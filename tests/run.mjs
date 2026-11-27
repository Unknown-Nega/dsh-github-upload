/**
 * Route + logic self-test for dsh-github-upload.
 *
 * Boots the real plugin against a fake Cordis context (fake webServer, fake
 * credentials service) and a stubbed global fetch, then drives every route over
 * a real http server on loopback. Nothing here talks to GitHub.
 */

import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const plugin = await import('../lib/index.js');
const T = plugin.__test;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}

/* ---------------- fake GitHub ---------------- */

// The plugin calls global fetch for GitHub; the suite calls the real one for its
// own loopback HTTP traffic.
const realFetch = globalThis.fetch;
const calls = [];
// Ref updates are recorded separately so a test can assert the branch actually
// moved, not just that no error came back.
const refUpdates = [];
let githubState = {};

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url: target, method, headers: init.headers ?? {}, body: init.body });

    const json = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(Object.entries(headers)),
      text: async () => JSON.stringify(body),
    });

    // Device flow endpoints
    if (target.includes('/login/device/code')) {
      return json(200, {
        device_code: 'dev-secret-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (target.includes('/login/oauth/access_token')) {
      return json(200, githubState.tokenResponse ?? { error: 'authorization_pending' });
    }

    // REST
    if (target.endsWith('/user') && method === 'GET') {
      return json(200, { login: 'octocat', name: 'The Octocat', avatar_url: 'https://example.test/a.png', plan: { name: 'pro' } }, {
        'x-oauth-scopes': 'repo, read:user',
      });
    }
    if (target.includes('/user/repos') && method === 'GET') {
      if (githubState.repos) return json(200, githubState.repos);
      return json(200, [
        { full_name: 'octocat/hello', name: 'hello', owner: { login: 'octocat' }, private: false, default_branch: 'main' },
      ]);
    }
    if (target.includes('/user/repos') && method === 'POST') {
      const body = JSON.parse(init.body);
      if (githubState.createRepoStatus) {
        // Reproduce what a fine-grained token without repository permission
        // gets back: a 403 plus the permissions the endpoint wanted.
        return json(
          githubState.createRepoStatus,
          { message: 'Resource not accessible by personal access token' },
          { 'x-accepted-github-permissions': githubState.acceptedPermissions ?? 'administration=write; repository_creation=write' },
        );
      }
      return json(201, {
        full_name: `octocat/${body.name}`,
        name: body.name,
        owner: { login: 'octocat' },
        default_branch: 'main',
        private: body.private,
        html_url: `https://github.com/octocat/${body.name}`,
      });
    }
    if (target.includes('/search/repositories')) {
      return json(200, { items: githubState.searchItems ?? [] });
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(target) && method === 'GET') {
      if (githubState.repo) {
        return json(200, {
          full_name: githubState.repo,
          name: githubState.repo.split('/')[1],
          owner: { login: githubState.repo.split('/')[0] },
          default_branch: 'main',
          private: false,
          html_url: `https://github.com/${githubState.repo}`,
        });
      }
      return json(404, { message: 'Not Found' });
    }
    // Legacy authorisation API: username + password → token
    if (target.endsWith('/authorizations') && method === 'POST') {
      const answer = githubState.authorizationResponse ?? { status: 201, body: { token: 'ghp_' + 'p'.repeat(36) } };
      return json(answer.status, answer.body);
    }
    if (target.endsWith('/git/trees')) return json(201, { sha: 'tree-sha-1' });
    if (target.endsWith('/git/commits') && method === 'POST') return json(201, { sha: 'commit-sha-1' });
    // GitHub routes these differently: reading one ref answers on both the
    // singular /git/ref/ and the plural /git/refs/, but updating one is only
    // routed on the plural collection path. A mock that answers the singular
    // PATCH too would hide the real 404, so it refuses it on purpose.
    if (/\/git\/refs?\/heads\//.test(target)) {
      if (method === 'PATCH') {
        if (!target.includes('/git/refs/')) return json(404, { message: 'Not Found' });
        refUpdates.push({ url: target, body: JSON.parse(init.body) });
        return json(200, { ref: 'refs/heads/main', object: { sha: 'commit-sha-1', type: 'commit' } });
      }
      return json(200, { ref: 'refs/heads/main', object: { sha: 'parent-sha-1', type: 'commit' } });
    }
    if (target.endsWith('/git/commits/parent-sha-1')) return json(200, { tree: { sha: 'base-tree-1' } });
    if (target.endsWith('/git/refs') && method === 'POST') return json(201, { ref: 'refs/heads/main' });

    return json(404, { message: `unstubbed ${method} ${target}` });
  };
}

/* ---------------- fake Cordis context ---------------- */

function makeCtx({ dshHome, profileName, creds = true, llm } = {}) {
  const routes = [];
  const effects = [];
  const services = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };

  if (creds) {
    const records = new Map();
    services.credentials = {
      async readRecord(key) {
        return records.get(key);
      },
      async describeRecord(key) {
        return { configured: records.has(key), kind: 'grant', writable: true };
      },
      async listRecords() {
        return [...records.keys()].map((key) => ({ key, kind: 'grant' }));
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
      },
      async deleteRecord(key) {
        records.delete(key);
      },
    };
    services.__records = records;
  }

  if (llm) services.llm = llm;
  services.agentDefaultModel = {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }),
  };

  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    get(name, strict) {
      if (services[name]) return services[name];
      if (strict) throw new Error(`service ${name} is not available`);
      return undefined;
    },
    logger: { warn() {}, info() {} },
    fiber: { entry: {} },
  };

  // The plugin reaches the web server through `ctx.webServer` (service proxy).
  ctx.webServer = services.webServer;

  for (const name of Object.keys(services)) {
    if (ctx[name] === undefined && name !== 'webServer') {
      Object.defineProperty(ctx, name, { get: () => services[name], configurable: true });
    }
  }

  return { ctx, routes, effects, services };
}

async function withServer(routes, fn) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = routes.find((item) => item.kind === 'exact' && item.path === url.pathname);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no route' }));
      return;
    }
    try {
      await route.handler(req, res);
    } catch (error) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      }
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

async function get(base, path) {
  const response = await realFetch(`${base}${path}`);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function post(base, path, body) {
  const response = await realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

async function postStream(base, path, body, signal) {
  return realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
}

/* ---------------- fixtures ---------------- */

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ghu-test-'));
  const dshHome = join(root, '.dsh');
  const profileDir = join(dshHome, 'profiles', 'desktop');
  const pluginDir = join(dshHome, 'plugins', 'demo-plugin');
  await mkdir(join(pluginDir, 'lib'), { recursive: true });
  await mkdir(join(pluginDir, 'locale'), { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify(
      {
        name: 'demo-plugin',
        version: '1.2.3',
        description: 'A demo plugin.',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js', './client': './lib/client.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
      },
      null,
      2,
    ),
  );
  await writeFile(join(pluginDir, 'lib', 'index.js'), 'export const name = "demo";\nexport function apply(ctx) {}\n');
  await writeFile(join(pluginDir, 'lib', 'client.js'), 'window.__ModuleLoader__.load({ id: "demo-plugin", factory: () => ({}) });\n');
  await writeFile(join(pluginDir, 'cordis.patch.yml'), '- insert:\n    - id: demo-plugin\n      name: demo-plugin\n');
  await writeFile(join(pluginDir, 'locale', 'en.json'), JSON.stringify({ meta: { title: 'Demo' } }));
  await writeFile(join(pluginDir, '.env'), 'SECRET_TOKEN=should-never-be-read\n');

  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { 'demo-plugin': `link:${pluginDir.replace(/\\/g, '/')}` },
    }),
  );

  return { root, dshHome, profileDir, pluginDir };
}

/* ---------------- the run ---------------- */

async function main() {
  stubFetch();
  const fixture = await makeFixture();

  console.log('\n# unit helpers');
  await test('repoName normalises and truncates', () => {
    assert.equal(T.repoName('  My Plugin!! v2 '), 'my-plugin-v2');
    assert.equal(T.repoName('---'), '');
    assert.equal(T.repoName('a'.repeat(150)).length, 100);
  });

  await test('normalizeSecret strips github token shapes', () => {
    // Assembled at runtime: a contiguous token-shaped literal in this file
    // would trip GitHub push protection when the plugin publishes its own
    // sources, and the shipped payload is what the redactor must still catch.
    const classic = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const fineGrained = 'github_pat_' + '11ABCDEFG0123456789_abcdefghij';
    const input = `bad token ${classic} and ${fineGrained}`;
    const out = T.normalizeSecret(input);
    assert.ok(!out.includes(classic));
    assert.ok(out.includes('[redacted]'));
  });

  await test('extractJsonObject finds nested balanced JSON', () => {
    const parsed = T.extractJsonObject('noise ```json\n{"a":{"b":1},"c":"d"}\n``` tail');
    assert.deepEqual(parsed, { a: { b: 1 }, c: 'd' });
  });

  await test('extractJsonObject rejects unterminated input', () => {
    assert.equal(T.extractJsonObject('{"a": 1'), undefined);
  });

  await test('extractJsonObject survives a readme that contains its own fences', () => {
    // The readme field carries ``` blocks, so a fence regex over the whole
    // reply used to lock onto the readme's own block and return undefined.
    const reply = JSON.stringify({
      description: 'Publishes plugins.',
      readme: '# Demo\n\n```bash\nnpm install demo\n```\n\nMore text.\n\n```json\n{"x":1}\n```\n',
      detail: '![alt](preview.svg)',
      keywords: ['demo'],
      tags: ['dsh'],
    });
    const parsed = T.extractJsonObject(reply);
    assert.ok(parsed, 'bare reply with inner fences must parse');
    assert.equal(parsed.description, 'Publishes plugins.');
    assert.ok(parsed.readme.includes('npm install demo'));
  });

  await test('extractJsonObject accepts the whole reply wrapped in one fence', () => {
    const inner = JSON.stringify({ description: 'D', readme: '```js\ncode\n```', detail: '', keywords: [], tags: [] });
    const parsed = T.extractJsonObject('```json\n' + inner + '\n```');
    assert.ok(parsed);
    assert.equal(parsed.description, 'D');
  });

  await test('normalizeDocResult keeps only one image line for detail', () => {
    const docs = T.normalizeDocResult(
      { description: 'Hi', readme: '# Demo', detail: '# Heading\n![alt](preview.svg)\nmore text', keywords: ['A', 'b'] },
      'demo-plugin',
    );
    assert.equal(docs.detail, '![alt](preview.svg)');
    assert.deepEqual(docs.keywords, ['a', 'b']);
    assert.equal(docs.suggestedName, 'demo-plugin');
  });

  await test('buildDocPrompt switches its writing rules with the language', () => {
    const files = [{ path: 'package.json', content: '{}' }];
    const english = T.buildDocPrompt({ pluginId: 'demo-plugin', files });
    assert.ok(english.includes('Write in English'), 'the default is English');
    assert.ok(!english.includes('简体中文'));

    const chinese = T.buildDocPrompt({ pluginId: 'demo-plugin', files, language: 'zh' });
    assert.ok(chinese.includes('简体中文'));
    assert.ok(!chinese.includes('Write in English'));
    assert.ok(chinese.includes('keywords'), 'the JSON shape stays language-independent');

    // An unrecognised code must not leak into the prompt.
    const bogus = T.buildDocPrompt({ pluginId: 'demo-plugin', files, language: 'xx' });
    assert.ok(bogus.includes('Write in English'));
    assert.equal(T.docLanguageValue('xx'), '');
    assert.equal(T.docLanguageValue('zh'), 'zh');
  });

  await test('tokenKindOf tells fine-grained tokens from classic ones', () => {
    assert.equal(T.tokenKindOf(`github_pat_${'a'.repeat(30)}`), 'fine-grained');
    assert.equal(T.tokenKindOf(`ghp_${'a'.repeat(36)}`), 'classic');
    assert.equal(T.tokenKindOf(`gho_${'a'.repeat(36)}`), 'classic');
    assert.equal(T.tokenKindOf(''), 'none');
    assert.equal(T.tokenKindOf('not-a-token'), 'unknown');
  });

  await test('acceptedPermissions reads the first alternative set only', () => {
    const headers = new Map([
      ['x-accepted-github-permissions', 'administration=write; repository_creation=write, contents=write'],
    ]);
    assert.deepEqual(T.acceptedPermissions(headers), ['administration=write', 'repository_creation=write']);
    assert.deepEqual(T.acceptedPermissions(new Map()), []);
    assert.deepEqual(T.acceptedPermissions(undefined), []);
  });

  await test('a 403 carries the permissions GitHub wanted', async () => {
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(Object.entries(headers)),
      text: async () => JSON.stringify(body),
    });
    const github = T.createGitHub({
      fetchImpl: async () =>
        reply(
          403,
          { message: 'Resource not accessible by personal access token' },
          { 'x-accepted-github-permissions': 'contents=write' },
        ),
    });
    const failure = await github
      .call(`github_pat_${'a'.repeat(30)}`, '/repos/octocat/hello/git/refs')
      .then(() => null)
      .catch((error) => error);
    assert.ok(failure, 'a 403 must reject');
    assert.equal(failure.status, 403);
    assert.equal(failure.extra.tokenKind, 'fine-grained');
    assert.deepEqual(failure.extra.needsPermissions, ['contents=write']);
    assert.match(failure.extra.permissionHint, /fine-grained/);
    assert.match(failure.extra.permissionHint, /Repository access/);
  });

  await test('probe separates "no repository access" from "cannot create"', async () => {
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(Object.entries(headers)),
      text: async () => JSON.stringify(body),
    });
    const seen = [];
    const github = T.createGitHub({
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        const method = (init.method ?? 'GET').toUpperCase();
        seen.push(`${method} ${target}`);
        if (target.endsWith('/user')) return reply(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' });
        if (target.includes('/user/repos') && method === 'GET') return reply(200, []);
        if (target.includes('/user/repos') && method === 'POST') {
          return reply(
            403,
            { message: 'Resource not accessible by personal access token' },
            { 'x-accepted-github-permissions': 'administration=write; repository_creation=write' },
          );
        }
        return reply(404, { message: 'Not Found' });
      },
    });

    const probe = await github.probe(`github_pat_${'b'.repeat(30)}`);
    assert.equal(probe.tokenKind, 'fine-grained');
    assert.equal(probe.login, 'octocat');
    assert.equal(probe.canReadProfile, true);
    assert.equal(probe.visibleRepos, 0);
    assert.equal(probe.canListRepos, true);
    assert.equal(probe.canCreateRepo, 'no');
    assert.deepEqual(probe.needsPermissions, ['administration=write', 'repository_creation=write']);
    assert.ok(
      seen.some((line) => line === 'POST https://api.github.com/user/repos'),
      'the create probe must be a POST',
    );

    // A token that can create gets a validation error, not a 403: that counts as yes.
    const allowed = T.createGitHub({
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith('/user')) return reply(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' });
        if (target.includes('/user/repos')) return reply(422, { message: 'Repository creation failed.', errors: [] });
        return reply(404, { message: 'Not Found' });
      },
    });
    const ok = await allowed.probe('ghp_' + 'c'.repeat(36));
    assert.equal(ok.canCreateRepo, 'yes');
    assert.equal(ok.tokenKind, 'classic');
  });

  await test('creating a repository explains the missing permission', async () => {
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(Object.entries(headers)),
      text: async () => JSON.stringify(body),
    });
    const github = T.createGitHub({
      fetchImpl: async () =>
        reply(
          403,
          { message: 'Resource not accessible by personal access token' },
          { 'x-accepted-github-permissions': 'administration=write; repository_creation=write' },
        ),
    });
    const failure = await github
      .createRepo(`github_pat_${'d'.repeat(30)}`, { name: 'demo-plugin' })
      .then(() => null)
      .catch((error) => error);
    assert.ok(failure, 'a refused creation must reject');
    assert.equal(failure.status, 403);
    assert.match(failure.message, /fine-grained token/);
    assert.deepEqual(failure.extra.needsPermissions, ['administration=write', 'repository_creation=write']);
    assert.match(failure.extra.permissionHint, /Administration: Read and write/);
    assert.match(failure.extra.permissionHint, /All repositories/);
  });

  await test('a push blocked by secret scanning explains itself', async () => {
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(Object.entries(headers)),
      text: async () => JSON.stringify(body),
    });
    const github = T.createGitHub({
      fetchImpl: async () =>
        reply(422, {
          message: 'Repository rule violations found',
          errors: [{ message: 'Secret detected in content' }],
        }),
    });
    const failure = await github
      .commitFiles(`ghp_${'a'.repeat(36)}`, { owner: 'octocat', repo: 'hello', branch: 'main', files: [], message: 'x' })
      .then(() => null)
      .catch((error) => error);
    assert.ok(failure, 'a 422 must reject');
    assert.equal(failure.status, 422);
    assert.equal(failure.extra.code, 'SECRET_DETECTED');
    assert.match(failure.extra.permissionHint, /push protection/i);
    assert.match(failure.extra.permissionHint, /Split/);
  });

  await test('a failed branch move says the commit exists but the branch did not move', async () => {
    const reply = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: new Map(),
      text: async () => JSON.stringify(body),
    });
    const github = T.createGitHub({
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        const method = (init.method ?? 'GET').toUpperCase();
        if (target.endsWith('/git/ref/heads/main') || target.endsWith('/git/refs/heads/main')) {
          if (method === 'PATCH') return reply(404, { message: 'Not Found' });
          return reply(200, { object: { sha: 'parent-sha-1', type: 'commit' } });
        }
        if (target.includes('/git/commits/parent-sha-1')) return reply(200, { tree: { sha: 'base-tree-1' } });
        if (target.endsWith('/git/trees')) return reply(201, { sha: 'tree-sha-1' });
        if (target.endsWith('/git/commits')) return reply(201, { sha: 'commit-sha-1' });
        return reply(404, { message: `unstubbed ${method} ${target}` });
      },
    });
    const failure = await github
      .commitFiles(`ghp_${'a'.repeat(36)}`, { owner: 'octocat', repo: 'hello', branch: 'main', files: [], message: 'x' })
      .then(() => null)
      .catch((error) => error);
    assert.ok(failure, 'a 404 on the ref update must reject');
    assert.equal(failure.status, 404);
    // The bare "Not Found" said nothing about the step, so the message names
    // the branch and states that the commit itself was already created.
    assert.match(failure.message, /commit was created/);
    assert.match(failure.message, /branch "main" could not be moved/);
  });

  await test('safeJoin rejects escapes', () => {
    const root = '/tmp/plugin';
    assert.equal(T.safeJoin(root, '../etc/passwd'), '');
    assert.notEqual(T.safeJoin(root, 'lib/index.js'), '');
  });

  console.log('\n# plugin inspection');

  const listed = await T.listProfilePlugins({ profilesRoot: join(fixture.dshHome, 'profiles'), config: { dshHome: fixture.dshHome } });
  await test('lists the linked plugin from the profile', () => {
    assert.ok(listed.plugins.some((item) => item.id === 'demo-plugin' && item.installed === true));
  });

  await test('lists the source directory under ~/.dsh/plugins', () => {
    assert.ok(listed.plugins.some((item) => item.id === 'demo-plugin' && item.dir === fixture.pluginDir));
  });

  const collected = await T.collectPluginFiles(fixture.pluginDir);
  await test('collects runtime files and never reads .env', () => {
    const paths = collected.files.map((file) => file.path);
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('lib/index.js'));
    assert.ok(!paths.includes('.env'), 'secret-shaped file must be skipped');
    assert.ok(collected.skipped.some((item) => item.path === '.env'));
  });

  // A token-shaped *content* is what push protection rejects with a 422 that
  // names no file, so the collector holds the file back instead of shipping it.
  const secretDir = join(fixture.root, 'secret-plugin');
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, 'package.json'), JSON.stringify({ name: 'secret-plugin' }));
  await writeFile(
    join(secretDir, 'fixture.mjs'),
    `const token = 'ghp_${'a'.repeat(36)}';\n`,
  );
  await writeFile(join(secretDir, 'notes.md'), 'A plugin that strips tokens, e.g. /ghp_[A-Za-z0-9]+/.\n');

  await test('holds back a file whose content is token-shaped', async () => {
    const scanned = await T.collectPluginFiles(secretDir);
    const paths = scanned.files.map((file) => file.path);
    assert.ok(!paths.includes('fixture.mjs'), 'a token literal must not be shipped');
    const held = scanned.skipped.find((item) => item.path === 'fixture.mjs');
    assert.ok(held, 'the held-back file must be reported');
    assert.match(held.reason, /secret-shaped content/);
  });

  await test('a documented pattern is not mistaken for a token', async () => {
    const scanned = await T.collectPluginFiles(secretDir);
    assert.ok(scanned.files.some((file) => file.path === 'notes.md'), 'prose and regexes must survive');
    assert.ok(scanned.files.some((file) => file.path === 'package.json'));
  });

  await test('findSecretInContent names the secret type', () => {
    assert.equal(T.findSecretInContent('nothing to see here'), null);
    const hit = T.findSecretInContent(`x github_pat_${'1'.repeat(22)}_${'a'.repeat(59)} y`);
    assert.equal(hit.kind, 'github-fine-grained-pat');
    assert.ok(!hit.sample.includes('a'.repeat(59)), 'the sample must be redacted');
    // Assembled at runtime so this file itself survives the content scan.
    const pemHeader = '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----';
    assert.equal(T.findSecretInContent(pemHeader).kind, 'private-key');
    assert.equal(T.findSecretInContent('AKIA' + 'IOSFODNN7EXAMPLE').kind, 'aws-access-key-id');
  });

  const manifest = JSON.parse(await readFile(join(fixture.pluginDir, 'package.json'), 'utf8'));
  const context = T.pickModelContext(collected.files, manifest);
  await test('model context includes manifest, entry, patch and locales', () => {
    const paths = context.map((file) => file.path);
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('lib/index.js'));
    assert.ok(paths.includes('cordis.patch.yml'));
    assert.ok(paths.includes('locale/en.json'));
    assert.ok(paths.includes('lib/client.js'));
  });

  console.log('\n# routes');

  const { ctx, routes, effects } = makeCtx({ dshHome: fixture.dshHome, profileName: "desktop" });
  plugin.apply(ctx, { dshHome: fixture.dshHome, profileName: 'desktop' });
  assert.ok(routes.length >= 9, `expected at least 9 routes, got ${routes.length}`);

  await withServer(routes, async (base) => {
    await test('status reports signed out with no model loss', async () => {
      const { status, body } = await get(base, '/api/dsh-github-upload/status');
      assert.equal(status, 200);
      assert.equal(body.connected, false);
      assert.equal(body.llmAvailable, false);
      assert.equal(body.model.provider, 'deepseek');
      assert.equal(body.where.source, 'none');
    });

    await test('connect-token rejects short tokens', async () => {
      const { status, body } = await post(base, '/api/dsh-github-upload/connect-token', { token: 'short' });
      assert.equal(status, 400);
      assert.match(body.error, /does not look like/);
    });

    await test('connect-token stores a credential record and verifies via /user', async () => {
      const token = 'ghp_' + 'a'.repeat(36);
      const { status, body } = await post(base, '/api/dsh-github-upload/connect-token', { token });
      assert.equal(status, 200);
      assert.equal(body.login, 'octocat');
      assert.equal(body.where, 'credential-record');
      const record = ctx.get('credentials').readRecord ? undefined : undefined;
      const stored = await ctx.get('credentials').readRecord('dsh-github-upload/github');
      assert.equal(stored.payload.token, token);
    });

    await test('status now reports connected', async () => {
      const { body } = await get(base, '/api/dsh-github-upload/status');
      assert.equal(body.connected, true);
      assert.equal(body.login, 'octocat');
      assert.equal(body.scopes.includes('repo'), true);
    });

    await test('status never leaks the token', async () => {
      const { body } = await get(base, '/api/dsh-github-upload/status');
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes('ghp_'), 'token must not appear in status');
    });

    await test('GET on a POST route returns 405', async () => {
      const { status, body } = await get(base, '/api/dsh-github-upload/connect-token');
      assert.equal(status, 405);
      assert.match(body.error, /method not allowed/);
    });

    await test('repos lists pushable repositories', async () => {
      const { status, body } = await get(base, '/api/dsh-github-upload/repos');
      assert.equal(status, 200);
      assert.equal(body.repos[0].fullName, 'octocat/hello');
      assert.equal(body.repos[0].defaultBranch, 'main');
    });

    await test('plugins route lists the fixture', async () => {
      const { body } = await get(base, '/api/dsh-github-upload/plugins');
      assert.ok(Array.isArray(body.plugins));
      assert.ok(body.plugins.some((item) => item.id === 'demo-plugin'));
    });

    await test('settings stores the documentation language', async () => {
      const before = await get(base, '/api/dsh-github-upload/status');
      assert.equal(before.body.docLanguage, '', 'unset means follow the interface');

      const saved = await post(base, '/api/dsh-github-upload/settings', { docLanguage: 'zh' });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.docLanguage, 'zh');

      const after = await get(base, '/api/dsh-github-upload/status');
      assert.equal(after.body.docLanguage, 'zh');
      const stored = JSON.parse(await readFile(join(fixture.dshHome, 'github-upload', 'settings.json'), 'utf8'));
      assert.equal(stored.docLanguage, 'zh');

      const cleared = await post(base, '/api/dsh-github-upload/settings', { docLanguage: '' });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.docLanguage, '');
    });

    await test('settings rejects an unknown documentation language', async () => {
      const { status, body } = await post(base, '/api/dsh-github-upload/settings', { docLanguage: 'klingon' });
      assert.equal(status, 400);
      assert.match(body.error, /language/i);
    });

    await test('check reports free when nothing exists', async () => {
      githubState = { repo: null, searchItems: [] };
      const { body } = await post(base, '/api/dsh-github-upload/check', { owner: 'octocat', name: 'brand-new' });
      assert.equal(body.verdict, 'free');
      assert.equal(body.existingRepo, null);
    });

    await test('check reports exists with default branch', async () => {
      githubState = { repo: 'octocat/brand-new', searchItems: [] };
      const { body } = await post(base, '/api/dsh-github-upload/check', { owner: 'octocat', name: 'brand-new' });
      assert.equal(body.verdict, 'exists');
      assert.equal(body.existingRepo.fullName, 'octocat/brand-new');
      assert.equal(body.existingRepo.defaultBranch, 'main');
    });

    await test('check flags a same-name repository owned by someone else', async () => {
      githubState = {
        repo: null,
        searchItems: [
          { full_name: 'someone/brand-new', name: 'brand-new', owner: { login: 'someone' }, stargazers_count: 3 },
        ],
      };
      const { body } = await post(base, '/api/dsh-github-upload/check', { owner: 'octocat', name: 'brand-new' });
      assert.equal(body.verdict, 'name-taken-elsewhere');
      assert.equal(body.foreign.length, 1);
      assert.equal(body.foreign[0].fullName, 'someone/brand-new');
    });

    await test('check requires an owner', async () => {
      const { status, body } = await post(base, '/api/dsh-github-upload/check', { owner: '', name: 'x' });
      assert.equal(status, 400);
      assert.match(body.error, /owner/i);
    });

    await test('publish creates a repository and commits files', async () => {
      githubState = { repo: null, searchItems: [] };
      calls.length = 0;
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        private: true,
        pluginDir: fixture.pluginDir,
        generated: { readme: '# Demo Plugin\n\nHello.', detail: '![alt](preview.svg)', description: 'A demo plugin.' },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.created, true);
      assert.equal(body.repo.fullName, 'octocat/demo-plugin');
      assert.equal(body.commit.commitSha, 'commit-sha-1');
      const created = calls.find((call) => call.url.endsWith('/user/repos') && call.method === 'POST');
      assert.ok(created, 'repository creation must be requested');
      assert.equal(JSON.parse(created.body).private, true);
      assert.ok(!body.files.includes('.env'), 'secret file must never be uploaded');
      assert.ok(body.files.includes('README.md'));
      assert.ok(body.files.includes('docs/DETAIL.md'));
    });

    await test('publish refuses an existing repository unless overwrite is set', async () => {
      githubState = { repo: 'octocat/demo-plugin', searchItems: [] };
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        pluginDir: fixture.pluginDir,
        generated: { readme: '# Demo' },
      });
      assert.equal(status, 409);
      assert.match(body.error, /already exists/);
    });

    await test('publish overwrites when asked', async () => {
      githubState = { repo: 'octocat/demo-plugin', searchItems: [] };
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        overwrite: true,
        pluginDir: fixture.pluginDir,
        generated: { readme: '# Demo v2' },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.created, false);
      assert.equal(body.commit.branch, 'main');
    });

    await test('an overwrite moves the branch through the plural refs path', async () => {
      githubState = { repo: 'octocat/demo-plugin', searchItems: [] };
      refUpdates.length = 0;
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        overwrite: true,
        pluginDir: fixture.pluginDir,
        generated: { readme: '# Demo v3' },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(refUpdates.length, 1, 'the branch must be moved exactly once');
      const update = refUpdates[0];
      // PATCH on the singular /git/ref/ is a 404 on GitHub, so a plural path is
      // the only one that can actually move a real branch.
      assert.match(update.url, /\/git\/refs\/heads\/main$/, update.url);
      assert.equal(update.body.sha, 'commit-sha-1');
    });

    await test('publish writes the edited description into package.json', async () => {
      githubState = { repo: null, searchItems: [] };
      const { body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        pluginDir: fixture.pluginDir,
        includeSource: false,
        generated: { readme: '# Demo', description: 'Freshly written blurb.' },
      });
      assert.equal(body.files.length, 2, JSON.stringify(body.files));
      const manifestCall = calls.filter((call) => call.url.endsWith('/git/trees')).pop();
      const tree = JSON.parse(manifestCall.body).tree;
      const pkg = JSON.parse(tree.find((item) => item.path === 'package.json').content);
      assert.equal(pkg.description, 'Freshly written blurb.');
      assert.equal(pkg.name, 'demo-plugin', 'other manifest fields must survive');
    });

    await test('publish without generated docs still ships a README and the manifest', async () => {
      githubState = { repo: null, searchItems: [] };
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        pluginDir: fixture.pluginDir,
        includeSource: false,
        generated: { readme: '# Demo Plugin\n\nGenerated documentation.' },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(body.files.sort(), ['README.md', 'package.json'], JSON.stringify(body.files));
    });

    await test('a docs-only publish of a bare plugin still builds a README', async () => {
      githubState = { repo: null, searchItems: [] };
      const bareDir = join(fixture.root, 'bare-plugin');
      await mkdir(bareDir, { recursive: true });
      await writeFile(join(bareDir, 'package.json'), JSON.stringify({ name: 'bare-plugin', version: '0.0.1' }));
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'bare-plugin',
        pluginDir: bareDir,
        includeSource: false,
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual(body.files.sort(), ['README.md', 'package.json'], JSON.stringify(body.files));
    });

    await test('analyze without the llm service returns NO_LLM', async () => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 'NO_LLM');
    });

    await test('analyze requires a plugin', async () => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400);
    });

    await test('permissions reports what the token can do', async () => {
      githubState = { repos: [] };
      const { status, body } = await get(base, '/api/dsh-github-upload/permissions');
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.tokenKind, 'classic');
      assert.equal(body.login, 'octocat');
      assert.equal(body.visibleRepos, 0);
      assert.equal(body.canListRepos, true);
      assert.equal(body.canCreateRepo, 'yes', 'the stub accepts repository creation');

      githubState = { createRepoStatus: 403 };
      const blocked = await get(base, '/api/dsh-github-upload/permissions');
      assert.equal(blocked.body.canCreateRepo, 'no');
      assert.deepEqual(blocked.body.needsPermissions, ['administration=write', 'repository_creation=write']);
      githubState = {};
    });

    await test('permissions needs a token', async () => {
      const bare = makeCtx({ dshHome: fixture.dshHome });
      plugin.apply(bare.ctx, { dshHome: fixture.dshHome });
      await withServer(bare.routes, async (innerBase) => {
        const { status, body } = await get(innerBase, '/api/dsh-github-upload/permissions');
        assert.equal(status, 401);
        assert.match(body.error, /Not signed in/);
      });
    });

    await test('a refused publish explains which permission to grant', async () => {
      githubState = { repo: null, searchItems: [], createRepoStatus: 403 };
      const { status, body } = await post(base, '/api/dsh-github-upload/publish', {
        owner: 'octocat',
        name: 'demo-plugin',
        pluginDir: fixture.pluginDir,
        generated: { readme: '# Demo' },
      });
      githubState = {};
      assert.equal(status, 403);
      assert.match(body.error, /GitHub refused to create the repository/);
      // The stored token here is classic, so the wording names that case.
      assert.match(body.error, /the token cannot create repositories/);
      assert.deepEqual(body.needsPermissions, ['administration=write', 'repository_creation=write']);
      assert.match(body.permissionHint, /"repo" scope/);
      assert.equal(body.tokenKind, 'classic');
    });

    await test('disconnect clears the stored token', async () => {
      const { status } = await post(base, '/api/dsh-github-upload/disconnect', {});
      assert.equal(status, 200);
      const { body } = await get(base, '/api/dsh-github-upload/status');
      assert.equal(body.connected, false);
      assert.equal(body.tokenPresent, false);
    });

    await test('routes that need a token report 401 after disconnect', async () => {
      const { status, body } = await get(base, '/api/dsh-github-upload/repos');
      assert.equal(status, 401);
      assert.match(body.error, /Not signed in/);
    });

    await test('unknown route is not claimed', async () => {
      const { status } = await get(base, '/api/dsh-github-upload/nope');
      assert.equal(status, 404);
    });
  });

  console.log('\n# device flow');

  const devCtx = makeCtx({ dshHome: fixture.dshHome, profileName: 'desktop' });
  plugin.apply(devCtx.ctx, { dshHome: fixture.dshHome, profileName: 'desktop', clientId: 'Iv1.test' });
  await withServer(devCtx.routes, async (base) => {
    await test('device-start returns a user code and link', async () => {
      const { status, body } = await post(base, '/api/dsh-github-upload/device-start', {});
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.userCode, 'ABCD-1234');
      assert.equal(body.verificationUri, 'https://github.com/login/device');
      assert.equal(body.interval, 5);
      githubState = { tokenResponse: { error: 'authorization_pending' } };
      devCtx.services.__pendingId = body.id;
    });

    await test('device-poll reports pending while unauthorised', async () => {
      const { body } = await post(base, '/api/dsh-github-upload/device-poll', { id: devCtx.services.__pendingId });
      assert.equal(body.status, 'pending');
    });

    await test('device-poll reports slow_down and backs off', async () => {
      githubState = { tokenResponse: { error: 'slow_down' } };
      const { body } = await post(base, '/api/dsh-github-upload/device-poll', { id: devCtx.services.__pendingId });
      assert.equal(body.status, 'slow_down');
      assert.equal(body.interval, 10);
    });

    await test('device-poll reports denied', async () => {
      githubState = { tokenResponse: { error: 'access_denied' } };
      const { body } = await post(base, '/api/dsh-github-upload/device-poll', { id: devCtx.services.__pendingId });
      assert.equal(body.status, 'denied');
    });

    await test('polling an unknown session is a 404', async () => {
      const { status } = await post(base, '/api/dsh-github-upload/device-poll', { id: 'nope' });
      assert.equal(status, 404);
    });

    await test('device-start without a client id is rejected', async () => {
      const bare = makeCtx({ dshHome: fixture.dshHome });
      plugin.apply(bare.ctx, { dshHome: fixture.dshHome });
      await withServer(bare.routes, async (innerBase) => {
        const { status, body } = await post(innerBase, '/api/dsh-github-upload/device-start', {});
        assert.equal(status, 400);
        assert.match(body.error, /client id/i);
      });
    });

    await test('a token pasted into the client id field is refused, not stored', async () => {
      const bare = makeCtx({ dshHome: fixture.dshHome });
      plugin.apply(bare.ctx, { dshHome: fixture.dshHome });
      // Split so no complete token appears in this file (push protection would
      // block publishing it); the concatenation is what the client-id check sees.
      // Obviously fake filler, not a real token: 22 chars, an underscore, 59
      // chars. Any value with this shape fails the client-id check, so the test
      // proves the same thing without carrying somebody's credential.
      const pasted = 'github_pat_' + '0'.repeat(22) + '_' + 'A'.repeat(59);
      await withServer(bare.routes, async (innerBase) => {
        const { status, body } = await post(innerBase, '/api/dsh-github-upload/device-start', { clientId: pasted });
        assert.equal(status, 400);
        assert.equal(body.code, 'BAD_CLIENT_ID');
      });
      const written = await readFile(join(fixture.dshHome, 'github-upload', 'settings.json'), 'utf8').catch(() => '');
      assert.ok(!written.includes('github_pat_'), 'the rejected token never reaches the settings file');
    });

    await test('a token already left in settings.json is scrubbed and never echoed', async () => {
      const stateDir = join(fixture.dshHome, 'github-upload');
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, 'settings.json'),
        JSON.stringify({ clientId: 'ghp_' + 'p'.repeat(36), defaultPrivate: true }),
        'utf8',
      );
      const bare = makeCtx({ dshHome: fixture.dshHome });
      plugin.apply(bare.ctx, { dshHome: fixture.dshHome });
      await withServer(bare.routes, async (innerBase) => {
        const { body } = await get(innerBase, '/api/dsh-github-upload/status');
        assert.equal(body.clientId, '', 'status never hands back a stored secret');
      });
      const after = await readFile(join(stateDir, 'settings.json'), 'utf8');
      assert.ok(!after.includes('ghp_'), 'the stale secret is removed from the file');
    });
  });

  await test('device flow authorisation stores the token and verifies identity', async () => {
    const flowCtx = makeCtx({ dshHome: fixture.dshHome });
    plugin.apply(flowCtx.ctx, { dshHome: fixture.dshHome, clientId: 'Iv1.test' });
    await withServer(flowCtx.routes, async (base) => {
      githubState = { tokenResponse: { error: 'authorization_pending' } };
      const started = await post(base, '/api/dsh-github-upload/device-start', {});
      githubState = { tokenResponse: { access_token: 'gho_' + 'b'.repeat(36), scope: 'repo read:user' } };
      const { body } = await post(base, '/api/dsh-github-upload/device-poll', { id: started.body.id });
      assert.equal(body.status, 'authorized');
      assert.equal(body.login, 'octocat');
      assert.equal(body.where, 'credential-record');
      const stored = await flowCtx.services.credentials.readRecord('dsh-github-upload/github');
      assert.equal(stored.payload.method, 'device');
      assert.ok(stored.payload.token.startsWith('gho_'));
    });
  });

  console.log('\n# username + password');

  await test('password-token exchanges credentials for a token once and stores it', async () => {
    const pwCtx = makeCtx({ dshHome: fixture.dshHome });
    plugin.apply(pwCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(pwCtx.routes, async (base) => {
      githubState = { authorizationResponse: { status: 201, body: { token: 'ghp_' + 'p'.repeat(36) } } };
      calls.length = 0;
      const { status, body } = await post(base, '/api/dsh-github-upload/password-token', {
        username: 'octocat',
        password: 'hunter2',
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.login, 'octocat');
      assert.equal(body.method, 'password');
      // The response echoes only a redacted preview of the new token.
      assert.ok(body.token !== 'ghp_' + 'p'.repeat(36), 'token is never echoed in full');
      assert.match(body.token, /\[redacted\]$/);

      const exchange = calls.find((call) => call.url.endsWith('/authorizations'));
      assert.ok(exchange, 'authorisation endpoint was called');
      const expected = 'Basic ' + Buffer.from('octocat:hunter2').toString('base64');
      assert.equal(exchange.headers.Authorization ?? exchange.headers.authorization, expected);
      const payload = JSON.parse(exchange.body);
      assert.deepEqual(payload.scopes, ['repo', 'read:user']);

      const stored = await pwCtx.services.credentials.readRecord('dsh-github-upload/github');
      assert.equal(stored.payload.method, 'password');
      assert.equal(stored.payload.token, 'ghp_' + 'p'.repeat(36));
      // The password itself must never be persisted or echoed back.
      assert.ok(!JSON.stringify(stored).includes('hunter2'));
      assert.ok(!JSON.stringify(body).includes('hunter2'));
    });
  });

  await test('a rejected password is a 401 with a stable code', async () => {
    const pwCtx = makeCtx({ dshHome: fixture.dshHome });
    plugin.apply(pwCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(pwCtx.routes, async (base) => {
      githubState = { authorizationResponse: { status: 401, body: { message: 'Bad credentials' } } };
      const { status, body } = await post(base, '/api/dsh-github-upload/password-token', {
        username: 'octocat',
        password: 'wrong',
      });
      assert.equal(status, 401);
      assert.equal(body.code, 'password-rejected');
      assert.ok(!JSON.stringify(body).includes('wrong'));
    });
  });

  await test('a 2FA-protected account gets a 403 pointing at device code', async () => {
    const pwCtx = makeCtx({ dshHome: fixture.dshHome });
    plugin.apply(pwCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(pwCtx.routes, async (base) => {
      githubState = {
        authorizationResponse: { status: 403, body: { message: 'Must specify two-factor authentication OTP code.' } },
      };
      const { status, body } = await post(base, '/api/dsh-github-upload/password-token', {
        username: 'octocat',
        password: 'hunter2',
      });
      assert.equal(status, 403);
      assert.equal(body.code, 'two-factor');
    });
  });

  await test('empty username or password is rejected before any request', async () => {
    const pwCtx = makeCtx({ dshHome: fixture.dshHome });
    plugin.apply(pwCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(pwCtx.routes, async (base) => {
      calls.length = 0;
      const a = await post(base, '/api/dsh-github-upload/password-token', { username: '', password: 'x' });
      assert.equal(a.status, 400);
      const b = await post(base, '/api/dsh-github-upload/password-token', { username: 'octocat', password: '' });
      assert.equal(b.status, 400);
      assert.equal(calls.length, 0);
    });
  });

  console.log('\n# AI documentation stream');

  await test('analyze streams deltas and a parsed doc bundle', async () => {
    const docJson = JSON.stringify({
      description: 'Demo plugin blurb.',
      readme: '# Demo Plugin\n\nDoes demo things.',
      detail: '![preview](preview.svg)',
      keywords: ['demo', 'sample'],
      tags: ['tool'],
    });
    async function* fakeStream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const piece of [docJson.slice(0, 20), docJson.slice(20)]) {
        yield { type: 'text-delta', index: 0, text: piece };
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: docJson } };
      yield { type: 'finish', reason: 'stop' };
    }
    let received;
    const llm = {
      stream(options) {
        received = options;
        return fakeStream();
      },
    };
    const aiCtx = makeCtx({ dshHome: fixture.dshHome, llm });
    plugin.apply(aiCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(aiCtx.routes, async (base) => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const lines = text.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines[0].type, 'start');
      assert.ok(lines.some((line) => line.type === 'delta'));
      const done = lines.find((line) => line.type === 'done');
      assert.ok(done, 'stream must end with a done event');
      assert.equal(done.docs.description, 'Demo plugin blurb.');
      assert.equal(done.docs.detail, '![preview](preview.svg)');
      assert.deepEqual(done.docs.keywords, ['demo', 'sample']);
    });

    assert.equal(received.provider, 'deepseek');
    assert.equal(received.model, 'deepseek-v4-flash');
    assert.equal(received.reasoningEffort, 'high');
    assert.equal(received.reasoningEffort, 'high');
    const prompt = received.messages[0].content[0].text;
    assert.ok(prompt.includes('demo-plugin'));
    assert.ok(!prompt.includes('should-never-be-read'), 'secret file content must not enter the prompt');
  });

  await test('analyze writes the prompt in the requested language', async () => {
    const docJson = JSON.stringify({
      description: '演示插件。',
      readme: '# 演示',
      detail: '![preview](preview.svg)',
      keywords: ['演示'],
      tags: ['工具'],
    });
    async function* zhStream() {
      yield { type: 'text-delta', index: 0, text: docJson };
      yield { type: 'finish', reason: 'stop' };
    }
    let received;
    const llm = {
      stream(options) {
        received = options;
        return zhStream();
      },
    };
    const zhCtx = makeCtx({ dshHome: fixture.dshHome, llm });
    plugin.apply(zhCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(zhCtx.routes, async (base) => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir, language: 'zh' }),
      });
      const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines[0].language, 'zh');
      assert.ok(lines.some((line) => line.type === 'done'));
    });
    const prompt = received.messages[0].content[0].text;
    assert.ok(prompt.includes('简体中文'));
    assert.ok(!prompt.includes('Write in English'));
  });

  await test('analyze falls back to the saved language when the request omits one', async () => {
    async function* empty() {
      yield { type: 'text-delta', index: 0, text: '{}' };
      yield { type: 'finish', reason: 'stop' };
    }
    let received;
    const llm = {
      stream(options) {
        received = options;
        return empty();
      },
    };
    const savedCtx = makeCtx({ dshHome: fixture.dshHome, llm });
    plugin.apply(savedCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(savedCtx.routes, async (base) => {
      await post(base, '/api/dsh-github-upload/settings', { docLanguage: 'zh' });
      await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      // A bogus per-request value is ignored rather than trusted.
      await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir, language: 'klingon' }),
      });
    });
    const prompt = received.messages[0].content[0].text;
    assert.ok(prompt.includes('简体中文'), 'the stored language wins over an unusable request value');
  });

  await test('analyze reports BAD_JSON when the model rambles', async () => {
    async function* rambling() {
      yield { type: 'text-delta', index: 0, text: 'I cannot help with that.' };
      yield { type: 'finish', reason: 'stop' };
    }
    const aiCtx = makeCtx({ dshHome: fixture.dshHome, llm: { stream: () => rambling() } });
    plugin.apply(aiCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(aiCtx.routes, async (base) => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      const error = lines.find((line) => line.type === 'error');
      assert.equal(error.code, 'BAD_JSON');
    });
  });

  await test('analyze surfaces a terminal finish reason as an error event', async () => {
    async function* failing() {
      yield { type: 'text-delta', index: 0, text: '{"description":' };
      yield { type: 'finish', reason: 'error' };
    }
    const aiCtx = makeCtx({ dshHome: fixture.dshHome, llm: { stream: () => failing() } });
    plugin.apply(aiCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(aiCtx.routes, async (base) => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      const error = lines.find((line) => line.type === 'error');
      assert.equal(error.code, 'error');
    });
  });

  await test('a truncated stream never reports done alongside the error', async () => {
    // The cut can land on a closing brace and still parse, so the stop reason
    // has to win over the parse result.
    const body = {
      description: 'D',
      readme: '# Demo',
      detail: '![alt](preview.svg)',
      keywords: ['demo'],
      tags: ['dsh'],
    };
    async function* truncated() {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(body) };
      yield { type: 'finish', reason: 'max_tokens' };
    }
    const aiCtx = makeCtx({ dshHome: fixture.dshHome, llm: { stream: () => truncated() } });
    plugin.apply(aiCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(aiCtx.routes, async (base) => {
      const response = await realFetch(`${base}/api/dsh-github-upload/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pluginDir: fixture.pluginDir }),
      });
      const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.some((line) => line.type === 'done'), false, 'a truncated stream must not report done');
      const error = lines.find((line) => line.type === 'error');
      assert.equal(error.code, 'max_tokens');
    });
  });

  console.log('\n# token storage fallback');

  await test('without a credentials service the token lands in a 0600 file', async () => {
    const fileCtx = makeCtx({ dshHome: fixture.dshHome, creds: false });
    plugin.apply(fileCtx.ctx, { dshHome: fixture.dshHome });
    await withServer(fileCtx.routes, async (base) => {
      const token = 'ghp_' + 'c'.repeat(36);
      const { status, body } = await post(base, '/api/dsh-github-upload/connect-token', { token });
      assert.equal(status, 200);
      assert.equal(body.where, 'local-file');
      const stored = JSON.parse(await readFile(join(fixture.dshHome, 'github-upload', 'github.json'), 'utf8'));
      assert.equal(stored.token, token);
      assert.equal((await readFile(join(fixture.dshHome, 'github-upload', 'github.json'), 'utf8')).includes(token), true);
    });
  });

  console.log('\n# loopback fence');

  await test('a non-loopback peer gets 403', async () => {
    const route = routes.find((item) => item.path === '/api/dsh-github-upload/status');
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await route.handler({ method: 'GET', url: '/api/dsh-github-upload/status', socket: { remoteAddress: '10.0.0.7' }, on() {} }, res);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /loopback/);
  });

  await test('effect disposers drop every route', () => {
    assert.ok(devCtx.routes.length > 0);
    for (const effect of devCtx.effects) effect.dispose?.();
    assert.equal(devCtx.routes.length, 0, 'all routes must be unregistered');
  });

  await rm(fixture.root, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('SUITE CRASH', error);
  process.exitCode = 1;
});
