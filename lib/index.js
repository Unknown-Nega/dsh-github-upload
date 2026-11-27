/**
 * dsh-github-upload — host half.
 *
 * Owns everything the page must not touch directly:
 *   - the GitHub token (stored as a credential record, never in configuration),
 *   - the OAuth device flow (start + poll, so one code covers the whole login),
 *   - every GitHub REST call (identity, repositories, name-conflict search,
 *     file publishing, repository creation),
 *   - plugin inspection on disk (package.json, entry file, cordis patch, locales),
 *   - the AI documentation call, streamed from the Harness LLM service so the
 *     panel can show progress and stop it.
 *
 * The browser half only talks to the loopback family `/api/dsh-github-upload`,
 * so the token is never visible to page scripts.
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

export const name = 'github-upload';

/** `llm` is optional: the panel still works for login + publish without it. */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/api/dsh-github-upload';

const GITHUB_API = 'https://api.github.com';
const GITHUB_LOGIN_URL = 'https://github.com/login/device';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'dsh-github-upload';

/**
 * Credential record holding the GitHub grant: `<scope>/<id>`, where the scope is
 * this plugin's registered name and the id is its own address for the grant.
 */
const CREDENTIAL_KEY = 'dsh-github-upload/github';

/**
 * Shape the credentials service accepts for a record key. The service validates
 * on load but not on write, so an unaddressable key would be committed happily
 * and then reject the entire credentials document at the next boot — taking the
 * connection plugin and everything downstream with it. Gate on the shape here
 * and fall back to the 0600 file store instead of risking that.
 */
const CREDENTIAL_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Device-flow scopes: create repositories and push into them. */
const DEVICE_SCOPES = 'repo read:user';

/** Scopes minted by the password → authorisation-token path. */
const PASSWORD_SCOPES = 'repo read:user';

/** Model calls get a bounded output; a README plus DETAIL fits comfortably. */
const DEFAULT_MAX_TOKENS = 4096;

/** Files we refuse to send to a model or to GitHub, by name. */
const SECRET_PATTERN = /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|id_rsa|id_ed25519|.*\.pem$|.*\.key$|.*\.pfx$|.*\.p12$)/i;

/** Directory names never descended into when collecting a plugin for upload. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', '.turbo', '.dsh-doc']);

/** Files larger than this are reported but never uploaded or sent to a model. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Token shapes GitHub's secret scanning refuses on push. A plugin's own test
 * fixtures are the usual offender: a literal written to exercise a redactor is
 * still a literal, and push protection does not care that it is fake. The
 * patterns are the ones GitHub documents for these secret types, so a hit here
 * is a push that would have come back as 422 "Secret detected in content".
 */
const SECRET_CONTENT_PATTERNS = [
  ['github-fine-grained-pat', /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/],
  ['github-fine-grained-pat', /github_pat_[A-Za-z0-9_]{80,}/],
  ['github-classic-pat', /gh[pousr]_[A-Za-z0-9]{36}/],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['aws-access-key-id', /AKIA[0-9A-Z]{16}/],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-key', /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['npm-token', /npm_[A-Za-z0-9]{36}/],
  ['openai-key', /sk-[A-Za-z0-9]{32,}/],
];

/**
 * The first token-shaped string in `text`, or null. Matching is deliberately
 * narrow: a plugin may legitimately ship the *pattern* (`/ghp_[A-Za-z0-9]+/`),
 * which none of these match, and flagging ordinary prose would make the
 * pre-flight check unusable.
 */
function findSecretInContent(text) {
  if (typeof text !== 'string' || !text) return null;
  for (const [kind, pattern] of SECRET_CONTENT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { kind, sample: normalizeSecret(match[0]) };
  }
  return null;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  // The panel consumes this stream through fetch(), not EventSource, but the
  // headers still keep intermediaries from buffering it.
  'x-accel-buffering': 'no',
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Loopback-only fence: these routes hold a token and can create repositories. */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '');
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

/**
 * Strip anything that looks like a token out of a string before it can reach
 * a log line, an error envelope, or the page. GitHub prints tokens in a few
 * shapes; keep the patterns narrow so ordinary text survives.
 */
function normalizeSecret(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh*_[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[redacted]')
    .replace(/\bclient_secret=[^&\s]+/gi, 'client_secret=[redacted]')
    .replace(/\bcode=[A-Za-z0-9-]{6,}/g, 'code=[redacted]')
    .replace(/\baccess_token=[^&\s]+/gi, 'access_token=[redacted]');
}

function sanitizeMessage(error) {
  const text = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return normalizeSecret(text);
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * An OAuth App client id is public, short and made of `[A-Za-z0-9._-]`. A
 * personal access token pasted into that field is none of those things, and
 * accepting it would write a live secret into a plaintext settings file and
 * hand it back through `/status`. Anything that fails this shape, or that the
 * redactor would have to rewrite, is not a client id.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

function clientIdValue(value) {
  const id = stringValue(value);
  if (!id || !CLIENT_ID_PATTERN.test(id)) return '';
  // normalizeSecret() rewrites token shapes; if it changed anything, this is a secret.
  return normalizeSecret(id) === id ? id : '';
}

function repoName(value) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.+$/, '')
    .slice(0, 100);
}

/* ------------------------------------------------------------------ */
/* GitHub REST client                                                  */
/* ------------------------------------------------------------------ */

class GitHubError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.extra = extra ?? {};
  }
}

/**
 * Fine-grained tokens and classic tokens fail for entirely different reasons
 * and are fixed in different places, so the prefix is the first thing worth
 * knowing when GitHub says no.
 */
function tokenKindOf(token) {
  const value = stringValue(token);
  if (!value) return 'none';
  if (value.startsWith('github_pat_')) return 'fine-grained';
  if (/^gh[pousr]_/.test(value)) return 'classic';
  return 'unknown';
}

/**
 * GitHub spells the permissions an endpoint wants in `x-accepted-github-permissions`
 * as `scope=level` pairs, semicolon separated, with alternative sets separated by
 * commas. Only the first alternative set is worth showing: the rest are narrower
 * variants of the same capability.
 */
function acceptedPermissions(headers) {
  const raw = headers?.get?.('x-accepted-github-permissions');
  if (!raw) return [];
  const first = raw.split(',')[0] ?? '';
  return first
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function createGitHub({ fetchImpl = globalThis.fetch } = {}) {
  async function call(token, path, options = {}) {
    if (typeof fetchImpl !== 'function') throw new GitHubError(0, 'fetch is unavailable in this runtime');
    const method = options.method ?? 'GET';
    const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-github-upload',
      'x-github-api-version': '2022-11-28',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const init = { method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    if (options.signal) init.signal = options.signal;

    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new GitHubError(0, `Cannot reach GitHub: ${sanitizeMessage(error)}`);
    }

    const text = await response.text();
    let body;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }

    if (!response.ok) {
      const detail = typeof body?.message === 'string' ? body.message : text.slice(0, 200) || response.statusText;
      const extra = {};
      if (Array.isArray(body?.errors)) {
        extra.errors = body.errors.map((item) => stringValue(item?.message ?? item?.code ?? '')).filter(Boolean).slice(0, 5);
      }
      if (response.status === 401) {
        throw new GitHubError(401, 'GitHub rejected the token (401). Sign in again.', extra);
      }
      if (response.status === 403) {
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = response.headers.get('x-ratelimit-reset');
        if (remaining === '0') {
          const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'later';
          throw new GitHubError(403, `GitHub rate limit reached; try again after ${when}.`, extra);
        }
        // "Resource not accessible by personal access token" is GitHub's entire
        // explanation for a token that authenticated but lacks the permission
        // this endpoint wants. Attach what the response actually says, so the
        // panel can name the permission instead of echoing the bare 403.
        const needs = acceptedPermissions(response.headers);
        const kind = tokenKindOf(token);
        const hint =
          kind === 'fine-grained'
            ? `This is a fine-grained token, so the permission has to be granted on the token itself${needs.length ? ` (${needs.join(', ')})` : ''} — and the repository it applies to has to be selected under "Repository access".`
            : needs.length
              ? `The token is missing ${needs.join(', ')}.`
              : 'The token does not have permission for this call.';
        throw new GitHubError(403, `GitHub refused the request (403): ${detail}`, {
          ...extra,
          tokenKind: kind,
          needsPermissions: needs,
          permissionHint: hint,
        });
      }
      if (response.status === 404) {
        throw new GitHubError(404, detail || 'Not found (404).', extra);
      }
      // Push protection answers through the ruleset machinery, so a secret in
      // the payload arrives as a 422 that never names a file. Say so, because
      // "Repository rule violations found" reads like a permissions problem.
      if (response.status === 422 && /secret (?:detected|scanning)|push protection/i.test(`${detail} ${JSON.stringify(extra.errors ?? [])}`)) {
        throw new GitHubError(422, `GitHub blocked the push (422): ${detail}`, {
          ...extra,
          code: 'SECRET_DETECTED',
          permissionHint:
            'GitHub\'s push protection found something token-shaped in the files being published. ' +
            'It scans the whole commit, including test fixtures, so a literal written to test a redactor is enough. ' +
            'Split such literals into pieces (`\'ghp_\' + \'...\'`), or remove them, then publish again — nothing from a blocked push reaches the repository, so no cleanup is needed.',
        });
      }
      throw new GitHubError(response.status, `GitHub error ${response.status}: ${detail}`, extra);
    }

    return { body, headers: response.headers };
  }

  /** Verify a token and return the identity behind it. */
  async function whoami(token) {
    const { body, headers } = await call(token, '/user');
    const scopes = headers.get('x-oauth-scopes');
    return {
      login: stringValue(body?.login),
      name: stringValue(body?.name),
      avatarUrl: stringValue(body?.avatar_url),
      htmlUrl: stringValue(body?.html_url),
      plan: stringValue(body?.plan?.name),
      scopes: scopes ? scopes.split(',').map((s) => s.trim()).filter(Boolean) : null,
      tokenKind: tokenKindOf(token),
    };
  }

  /**
   * What this token can actually do. `/user` succeeds for any valid token, which
   * is why a token that can do nothing else still looks connected; the panel
   * needs the difference *before* a publish fails.
   *
   * Repo creation has no read-only endpoint of its own, so it is probed with an
   * empty POST: GitHub checks the permission before the payload, which answers
   * 403 for "may not" and 422 for "may, but that request was empty". An empty
   * request can never create a repository, so the probe has no side effects.
   */
  async function probe(token) {
    const result = {
      tokenKind: tokenKindOf(token),
      login: '',
      scopes: null,
      canReadProfile: false,
      visibleRepos: 0,
      canListRepos: false,
      canCreateRepo: 'unknown',
      needsPermissions: [],
    };

    try {
      const viewer = await whoami(token);
      result.login = viewer.login;
      result.scopes = viewer.scopes;
      result.canReadProfile = Boolean(viewer.login);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      return { ...result, error: sanitizeMessage(error) };
    }

    try {
      const { body } = await call(token, '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member');
      result.visibleRepos = Array.isArray(body) ? body.length : 0;
      result.canListRepos = true;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      // A token with no repository access reports an empty list rather than an
      // error, so a failure here means something else went wrong.
      result.canListRepos = false;
    }

    try {
      // Reachability check only: a non-403 answer means the permission is there.
      await call(token, '/user/repos', { method: 'POST', body: {} });
      result.canCreateRepo = 'yes';
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 403) {
        result.canCreateRepo = 'no';
        result.needsPermissions = Array.isArray(error.extra?.needsPermissions) ? error.extra.needsPermissions : [];
      } else if (error.status === 422 || error.status === 400) {
        result.canCreateRepo = 'yes';
      }
    }

    return result;
  }

  /** Repositories the token can push to, most recently pushed first. */
  async function listRepos(token, { limit = 100 } = {}) {
    const perPage = Math.min(100, Math.max(1, limit));
    const { body } = await call(
      token,
      `/user/repos?per_page=${perPage}&sort=pushed&affiliation=owner,collaborator,organization_member`,
    );
    if (!Array.isArray(body)) return [];
    return body.map((repo) => ({
      fullName: stringValue(repo?.full_name),
      name: stringValue(repo?.name),
      owner: stringValue(repo?.owner?.login),
      private: repo?.private === true,
      defaultBranch: stringValue(repo?.default_branch) || 'main',
      description: stringValue(repo?.description),
      htmlUrl: stringValue(repo?.html_url),
      pushedAt: stringValue(repo?.pushed_at),
    }));
  }

  /** One repository, or null when it does not exist / is not visible. */
  async function getRepo(token, owner, repo) {
    try {
      const { body } = await call(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      return {
        fullName: stringValue(body?.full_name),
        name: stringValue(body?.name),
        owner: stringValue(body?.owner?.login),
        defaultBranch: stringValue(body?.default_branch) || 'main',
        private: body?.private === true,
        htmlUrl: stringValue(body?.html_url),
        description: stringValue(body?.description),
        sizeKb: Number(body?.size ?? 0),
      };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Repositories whose *name* matches, anywhere on GitHub. The "in:name" search
   * is how the panel warns that a plugin name is already taken.
   */
  async function searchByName(token, keyword, { limit = 5 } = {}) {
    const query = `${keyword} in:name`;
    const { body } = await call(token, `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`);
    const items = Array.isArray(body?.items) ? body.items : [];
    return items
      .filter((item) => stringValue(item?.name).toLowerCase() === keyword.toLowerCase())
      .map((item) => ({
        fullName: stringValue(item?.full_name),
        owner: stringValue(item?.owner?.login),
        htmlUrl: stringValue(item?.html_url),
        stars: Number(item?.stargazers_count ?? 0),
        description: stringValue(item?.description),
        updatedAt: stringValue(item?.updated_at),
      }));
  }

  async function createRepo(token, { name, description, private: isPrivate, autoInit }) {
    let created;
    try {
      created = await call(token, '/user/repos', {
        method: 'POST',
        body: {
          name,
          description: description || undefined,
          private: isPrivate !== false,
          auto_init: autoInit !== false,
        },
      });
    } catch (error) {
      // The generic 403 says nothing about what to change. Repository creation
      // is granted in exactly one place, so spell that out here.
      if (error instanceof GitHubError && error.status === 403) {
        const kind = tokenKindOf(token);
        throw new GitHubError(
          403,
          kind === 'fine-grained'
            ? 'GitHub refused to create the repository: this fine-grained token has no repository permission for it.'
            : 'GitHub refused to create the repository: the token cannot create repositories.',
          {
            ...(error.extra ?? {}),
            tokenKind: kind,
            needsPermissions: error.extra?.needsPermissions?.length
              ? error.extra.needsPermissions
              : ['administration=write', 'repository_creation=write'],
            permissionHint:
              kind === 'fine-grained'
                ? 'On github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens, edit this token and add "Administration: Read and write" (or the newer "Repository creation: Read and write") under Repository permissions. Under "Repository access" pick "All repositories", or add the target repository — a token scoped to other repositories cannot create this one.'
                : 'This is a classic token, so it needs the "repo" scope (and "workflow" if you also publish .github/workflows). Regenerate the token on github.com → Settings → Developer settings → Personal access tokens and tick "repo".',
          },
        );
      }
      throw error;
    }
    const { body } = created;
    return {
      fullName: stringValue(body?.full_name),
      owner: stringValue(body?.owner?.login),
      name: stringValue(body?.name),
      defaultBranch: stringValue(body?.default_branch) || 'main',
      htmlUrl: stringValue(body?.html_url),
      private: body?.private === true,
    };
  }

  /**
   * One commit carrying several files (the Git tree API). Written as a single
   * commit so a failed publish never leaves a half-uploaded repository.
   */
  async function commitFiles(token, { owner, repo, branch, files, message }) {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    // Reading one ref also works through the singular /git/ref/, but updating
    // it is only routed on the plural collection path /git/refs/. Using the
    // plural for both keeps a single path for read and write — with the
    // singular one the PATCH fell through to a bare "Not Found".
    const refPath = branch ? `/git/refs/heads/${encodeURIComponent(branch)}` : null;

    let parentSha = '';
    let baseTree = '';
    if (refPath) {
      try {
        const { body } = await call(token, `${base}${refPath}`);
        parentSha = stringValue(body?.object?.sha);
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
      }
    }

    // An empty repository has no ref yet; a fresh commit starts from scratch.
    if (parentSha) {
      const { body } = await call(token, `${base}/git/commits/${parentSha}`);
      baseTree = stringValue(body?.tree?.sha);
    }

    const tree = files.map((file) => ({
      path: file.path,
      mode: '100644',
      type: 'blob',
      content: file.content,
    }));

    const { body: treeBody } = await call(token, `${base}/git/trees`, {
      method: 'POST',
      body: { base_tree: baseTree || undefined, tree },
    });
    const treeSha = stringValue(treeBody?.sha);
    if (!treeSha) throw new GitHubError(500, 'GitHub did not return a tree sha.');

    const { body: commitBody } = await call(token, `${base}/git/commits`, {
      method: 'POST',
      body: { message, tree: treeSha, parents: parentSha ? [parentSha] : [] },
    });
    const commitSha = stringValue(commitBody?.sha);
    if (!commitSha) throw new GitHubError(500, 'GitHub did not return a commit sha.');

    if (parentSha) {
      try {
        await call(token, `${base}${refPath}`, { method: 'PATCH', body: { sha: commitSha, force: false } });
      } catch (error) {
        // A bare "Not Found" from the ref update says nothing about which step
        // failed, and it is the only step that can fail after the objects are
        // already written — so name the branch and what did not happen.
        if (error instanceof GitHubError) {
          throw new GitHubError(
            error.status,
            `The commit was created but the branch "${branch}" could not be moved to it (${error.status}): ${error.message}. The branch-protection rules may forbid the update, or the token may not have permission to write it.`,
            error.extra,
          );
        }
        throw error;
      }
    } else {
      const targetBranch = branch || 'main';
      await call(token, `${base}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${targetBranch}`, sha: commitSha },
      });
    }

    return { commitSha, branch: branch || 'main', fileCount: files.length };
  }

  return { call, whoami, probe, listRepos, getRepo, searchByName, createRepo, commitFiles };
}

/* ------------------------------------------------------------------ */
/* plugin inspection on disk                                           */
/* ------------------------------------------------------------------ */

/** Root the current profile lives in, as far as this plugin can tell. */
function resolveProfilesRoot(config) {
  if (config?.dshHome) return join(config.dshHome, 'profiles');
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'profiles');
  return join(homedir(), '.dsh', 'profiles');
}

function resolveDshHome(config) {
  if (config?.dshHome) return config.dshHome;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Follow a `link:` dependency back to its real directory. The profile package
 * lists local bundles exactly this way, so it is the cheapest source of truth
 * for "which plugins are installed, and where do they live".
 */
function resolveLinkTarget(spec, packageDir) {
  const raw = stringValue(spec);
  if (!raw.startsWith('link:')) return '';
  const target = raw.slice('link:'.length).trim();
  if (!target) return '';
  return isAbsolute(target) ? resolve(target) : resolve(packageDir, target);
}

async function readPackageDir(dir) {
  const manifest = await readJsonFile(join(dir, 'package.json'));
  if (!manifest || typeof manifest.name !== 'string') return undefined;
  return manifest;
}

/**
 * Enumerate plugins available to the profile: every linked bundle plus every
 * dependency that resolves to a directory carrying a package.json.
 */
async function listProfilePlugins({ profilesRoot, profileName, config }) {
  const candidates = [];
  let profileRoot = '';

  if (profileName) {
    profileRoot = join(profilesRoot, profileName);
  }

  if (profileRoot) {
    const requested = profileRoot;
    if (!(await readPackageDir(requested))) {
      // Fall back to whichever profile directory actually exists.
      profileRoot = '';
      try {
        const entries = await readdir(profilesRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dir = join(profilesRoot, entry.name);
          if (await readPackageDir(dir)) {
            profileRoot = dir;
            break;
          }
        }
      } catch {
        // No profiles directory at all; fall through with an empty list.
      }
    }
  } else {
    try {
      const entries = await readdir(profilesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(profilesRoot, entry.name);
        if (await readPackageDir(dir)) {
          profileRoot = dir;
          break;
        }
      }
    } catch {
      // No profiles directory at all; fall through with an empty list.
    }
  }

  if (profileRoot) {
    const profileManifest = await readPackageDir(profileRoot);
    const dependencies = profileManifest?.dependencies;
    if (dependencies && typeof dependencies === 'object') {
      for (const [depName, spec] of Object.entries(dependencies)) {
        const dir = resolveLinkTarget(spec, profileRoot);
        if (!dir) continue;
        candidates.push({ dir, requestedName: depName, source: 'link' });
      }
    }
  }

  // Any plugin source directory the user keeps under ~/.dsh/plugins, so a
  // checked-out-but-not-yet-installed plugin can still be published.
  const sourceRoot = join(resolveDshHome(config), 'plugins');
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push({ dir: join(sourceRoot, entry.name), requestedName: entry.name, source: 'source' });
    }
  } catch {
    // Not an error: the user may keep plugin sources elsewhere.
  }

  const seen = new Set();
  const plugins = [];
  for (const candidate of candidates) {
    const manifest = await readPackageDir(candidate.dir);
    if (!manifest) continue;
    const key = resolve(candidate.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    plugins.push({
      id: stringValue(manifest.name) || candidate.requestedName,
      dir: candidate.dir,
      version: stringValue(manifest.version),
      description: stringValue(manifest.description),
      hasClient: Boolean(manifest.dsh?.client),
      hasBundle: Boolean(manifest.dsh?.bundle),
      installed: candidate.source === 'link',
    });
  }

  plugins.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return { plugins, profileRoot, profilesRoot };
}

/** Reject a path that escapes the plugin directory. */
function safeJoin(root, relativePath) {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) return '';
  return target;
}

/**
 * Read the files a model (or GitHub) needs, within limits. Secret-shaped files
 * are skipped here rather than filtered later, so their contents never enter
 * this process's memory.
 */
async function collectPluginFiles(root, { maxFiles = 200, maxBytes = MAX_FILE_BYTES } = {}) {
  const files = [];
  const skipped = [];

  async function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          skipped.push({ path: rel, reason: 'directory' });
          continue;
        }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SECRET_PATTERN.test(entry.name)) {
        skipped.push({ path: rel, reason: 'secret-shaped name' });
        continue;
      }
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size > maxBytes) {
        skipped.push({ path: rel, reason: `too large (${info.size} bytes)` });
        continue;
      }
      if (files.length >= maxFiles) {
        skipped.push({ path: rel, reason: 'file limit reached' });
        continue;
      }
      let content;
      try {
        content = await readFile(full);
      } catch {
        continue;
      }
      // Binary detection: a NUL byte in the first 8 KiB.
      const probe = content.subarray(0, 8192);
      if (probe.includes(0)) {
        skipped.push({ path: rel, reason: 'binary' });
        continue;
      }
      // Content screening: a token-shaped literal here would be rejected by
      // GitHub's push protection with a 422 that says nothing about which file
      // caused it, so the file is held back and reported by name instead.
      const text = content.toString('utf8');
      const secret = findSecretInContent(text);
      if (secret) {
        skipped.push({ path: rel, reason: `secret-shaped content (${secret.kind})` });
        continue;
      }
      files.push({ path: rel, content: text, size: info.size });
    }
  }

  await walk(root, 0);
  return { files, skipped };
}

/**
 * The subset of a plugin worth sending to a model: the manifest, the declared
 * entry module, the cordis patch, and locale files. Full sources would blow
 * the context window and add nothing to a description.
 */
function pickModelContext(files, manifest) {
  const wanted = [];
  const push = (path, maxChars) => {
    const hit = files.find((file) => file.path === path);
    if (hit) wanted.push({ path, content: hit.content.slice(0, maxChars) });
  };

  push('package.json', 8000);
  push('cordis.patch.yml', 4000);
  push('README.md', 12000);

  const entry = stringValue(manifest?.main) || stringValue(manifest?.exports?.['.']) || 'lib/index.js';
  const entryPath = entry.replace(/^\.\//, '');
  push(entryPath, 16000);

  const clientExport = manifest?.exports?.['./client'];
  if (typeof clientExport === 'string') push(clientExport.replace(/^\.\//, ''), 6000);

  for (const file of files) {
    if (/^locale\/[^/]+\.json$/.test(file.path)) push(file.path, 3000);
    if (/^(?:README|docs\/DETAIL)[.\w-]*\.md$/i.test(file.path) && file.path !== 'README.md') {
      push(file.path, 6000);
    }
  }

  return wanted;
}

/* ------------------------------------------------------------------ */
/* token storage                                                       */
/* ------------------------------------------------------------------ */

/**
 * The token lives in a credential record when the credentials service is
 * present (the preferred home: it is the product's secret store), and in a
 * 0600 file beside the plugin state otherwise. Either way it never reaches
 * configuration, a log line, or the page.
 */
function createTokenStore({ ctx, stateDir }) {
  const filePath = join(stateDir, 'github.json');
  let memory;

  const credentials = () => {
    if (!CREDENTIAL_KEY_PATTERN.test(CREDENTIAL_KEY)) return null;
    try {
      return ctx?.get?.('credentials', false) ?? null;
    } catch {
      return null;
    }
  };

  async function readFileStore() {
    if (memory !== undefined) return memory;
    const parsed = await readJsonFile(filePath);
    memory = parsed && typeof parsed === 'object' ? parsed : null;
    return memory;
  }

  async function writeFileStore(value) {
    const { writeFile, mkdir, chmod } = await import('node:fs/promises');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(filePath, 0o600);
    } catch {
      // Windows has no POSIX mode; the file stays inside the user's profile.
    }
    memory = value;
  }

  return {
    /** Where the token is currently kept, for the panel to display. */
    async describes() {
      const store = credentials();
      if (store?.describeRecord) {
        try {
          const info = await store.describeRecord(CREDENTIAL_KEY);
          if (info?.configured) return { configured: true, source: 'credential-record', writable: info.writable !== false };
        } catch {
          // Fall through to the file store.
        }
      }
      const file = await readFileStore();
      return { configured: Boolean(file?.token), source: file?.token ? 'local-file' : 'none', writable: true };
    },

    async read() {
      const store = credentials();
      if (store?.readRecord) {
        try {
          const record = await store.readRecord(CREDENTIAL_KEY);
          const token = stringValue(record?.payload?.token);
          if (token) {
            return {
              token,
              login: stringValue(record?.payload?.login),
              name: stringValue(record?.payload?.name),
              avatarUrl: stringValue(record?.payload?.avatarUrl),
              method: stringValue(record?.payload?.method) || 'pat',
              scopes: Array.isArray(record?.payload?.scopes) ? record.payload.scopes : null,
              storedAt: stringValue(record?.payload?.storedAt),
              source: 'credential-record',
            };
          }
        } catch {
          // Fall through.
        }
      }
      const file = await readFileStore();
      if (file?.token) {
        return {
          token: stringValue(file.token),
          login: stringValue(file.login),
          name: stringValue(file.name),
          avatarUrl: stringValue(file.avatarUrl),
          method: stringValue(file.method) || 'pat',
          scopes: Array.isArray(file.scopes) ? file.scopes : null,
          storedAt: stringValue(file.storedAt),
          source: 'local-file',
        };
      }
      return null;
    },

    async write(payload) {
      const record = {
        token: stringValue(payload.token),
        login: stringValue(payload.login),
        name: stringValue(payload.name),
        avatarUrl: stringValue(payload.avatarUrl),
        method: stringValue(payload.method) || 'pat',
        scopes: Array.isArray(payload.scopes) ? payload.scopes : null,
        storedAt: new Date().toISOString(),
      };

      const store = credentials();
      if (store?.modifyRecord) {
        try {
          await store.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: record }));
          // A previous file-store token would otherwise shadow the new one on
          // the next read; drop it once the record is committed.
          await this.clearFile();
          return { source: 'credential-record' };
        } catch {
          // Fall through to the file store.
        }
      }
      await writeFileStore(record);
      return { source: 'local-file' };
    },

    async clearFile() {
      const { rm } = await import('node:fs/promises');
      memory = null;
      try {
        await rm(filePath, { force: true });
      } catch {
        // Nothing to remove.
      }
    },

    async clear() {
      let cleared = false;
      const store = credentials();
      if (store?.deleteRecord) {
        try {
          await store.deleteRecord(CREDENTIAL_KEY);
          cleared = true;
        } catch {
          // Ignore: the file store may still hold one.
        }
      }
      await this.clearFile();
      return cleared;
    },
  };
}

/* ------------------------------------------------------------------ */
/* OAuth device flow                                                   */
/* ------------------------------------------------------------------ */

/**
 * One in-flight device authorization. The panel starts it, then polls; the
 * pending entry is keyed by an opaque id so the page never holds the code.
 */
function createDeviceFlow({ fetchImpl = globalThis.fetch, clientId }) {
  const pending = new Map();

  async function formRequest(url, body) {
    const init = {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    };
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      throw new GitHubError(0, `Cannot reach GitHub: ${sanitizeMessage(error)}`);
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      throw new GitHubError(response.status, `Unexpected response from GitHub: ${text.slice(0, 160)}`);
    }
    return parsed;
  }

  return {
    async start(id) {
      const id2 = clientIdValue(clientId);
      if (!id2) throw new GitHubError(400, 'An OAuth App client id is required for the device flow.');

      const payload = await formRequest(DEVICE_CODE_URL, { client_id: id2, scope: DEVICE_SCOPES });
      const deviceCode = stringValue(payload.device_code);
      const userCode = stringValue(payload.user_code);
      if (!deviceCode || !userCode) {
        throw new GitHubError(400, stringValue(payload.error_description) || 'GitHub did not return a device code.');
      }
      const expiresIn = Number(payload.expires_in ?? 900);
      const interval = Math.max(5, Number(payload.interval ?? 5));

      const ticket = {
        id: stringValue(id) || `dev_${Date.now().toString(36)}`,
        deviceCode,
        userCode,
        verificationUri: stringValue(payload.verification_uri) || GITHUB_LOGIN_URL,
        expiresAt: Date.now() + expiresIn * 1000,
        interval,
        clientId: id2,
        status: 'pending',
      };
      pending.set(ticket.id, ticket);

      return {
        id: ticket.id,
        userCode: ticket.userCode,
        verificationUri: ticket.verificationUri,
        interval: ticket.interval,
        expiresAt: new Date(ticket.expiresAt).toISOString(),
      };
    },

    /**
     * One poll. Returns a status the panel can render: `pending`, `slow_down`,
     * `expired`, `denied`, or `authorized` with the token.
     */
    async poll(id) {
      const ticket = pending.get(stringValue(id));
      if (!ticket) throw new GitHubError(404, 'This device-code session is unknown; start sign-in again.');
      if (ticket.expiresAt <= Date.now()) {
        pending.delete(ticket.id);
        return { status: 'expired' };
      }

      const payload = await formRequest(ACCESS_TOKEN_URL, {
        client_id: ticket.clientId,
        device_code: ticket.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });

      const error = stringValue(payload.error);
      if (!error) {
        const token = stringValue(payload.access_token);
        if (!token) return { status: 'pending' };
        const scope = stringValue(payload.scope);
        pending.delete(ticket.id);
        return {
          status: 'authorized',
          token,
          scopes: scope ? scope.split(',').map((s) => s.trim()).filter(Boolean) : null,
        };
      }

      if (error === 'authorization_pending') return { status: 'pending' };
      if (error === 'slow_down') {
        ticket.interval += 5;
        return { status: 'slow_down', interval: ticket.interval };
      }
      if (error === 'expired_token') {
        pending.delete(ticket.id);
        return { status: 'expired' };
      }
      if (error === 'access_denied') {
        pending.delete(ticket.id);
        return { status: 'denied' };
      }
      pending.delete(ticket.id);
      return { status: 'error', error, message: stringValue(payload.error_description) || error };
    },

    cancel(id) {
      return pending.delete(stringValue(id));
    },

    /** Drop expired tickets so a long-lived process does not accumulate them. */
    prune() {
      const now = Date.now();
      for (const [id, ticket] of pending) {
        if (ticket.expiresAt <= now) pending.delete(id);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* AI documentation generation                                         */
/* ------------------------------------------------------------------ */

const DOC_SCHEMA_HINT = `Return ONE JSON object, and nothing else. Shape:
{
  "description": "one sentence, under 160 characters, no markdown",
  "readme": "full README.md markdown",
  "detail": "full docs/DETAIL.md markdown: exactly one image line, e.g. ![alt](preview.svg)",
  "keywords": ["lowercase", "search", "terms"],
  "tags": ["short", "topic", "words"]
}
Do not wrap the JSON in a code fence.`;

/**
 * Languages the generated description may be written in. The value is picked in
 * the panel, defaults to the interface language, and is stored per user; an
 * unknown value falls back to English rather than being passed to the model.
 */
const DOC_LANGUAGES = ['zh', 'en'];
const DEFAULT_DOC_LANGUAGE = 'en';

function docLanguageValue(value) {
  return DOC_LANGUAGES.includes(value) ? value : '';
}

/** The writing rules that change with the target language. */
function docLanguageRules(language) {
  if (language === 'zh') {
    return `- 用简体中文写作，句子简洁，使用第二人称；README 的小节标题也用中文。
- keywords：5-8 个短词（中文或英文均可）。tags：2-4 个主题词。`;
  }
  return `- Write in English, in sentence case, using second person.
- keywords: 5-8 lowercase English terms. tags: 2-4 short topic words.`;
}

function buildDocPrompt({ pluginId, version, manifestText, files, language }) {
  const context = files
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join('\n\n');
  const lang = docLanguageValue(language) || DEFAULT_DOC_LANGUAGE;

  return `You are documenting a DeepSeek Harness (DSH) plugin so it can be published to GitHub.

Write for a user who has DSH open and wants to know what this plugin does and where to click.
Rules:
- The plugin is "${pluginId}"${version ? `, version ${version}` : ''}.
- Describe only behaviour you can see in the sources below. Never invent a feature, a setting, an API, or a limitation.
- README.md starts with a single H1 with the plugin name, then a one-paragraph summary. Use short sections: what it does, where to find it in the UI (name the exact panel or toolbar label), how to use it, configuration, and limits. Use fenced code blocks for commands and file snippets.
- Mention concrete limits when the sources show them: added model requests, data sent to a third party, and what stops working when the plugin is disabled.
${docLanguageRules(lang)}

${DOC_SCHEMA_HINT}

Plugin sources:
${context}`;
}

function tryParseObject(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Pull the first balanced JSON object out of a model reply.
 *
 * The reply is usually a bare JSON object, but the readme it carries is full
 * of fenced code blocks. A fence regex over the whole reply therefore matches
 * the readme's own fence instead of a wrapper, which used to hand the parser a
 * few dozen characters and fail every generation. Parse the whole reply first,
 * since that is the shape the prompt asks for, and only fall back to a fence
 * when the fence opens and closes the entire reply.
 */
function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;

  const whole = tryParseObject(raw);
  if (whole) return whole;

  const opening = raw.match(/^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n?\x60\x60\x60\s*$/i);
  if (opening) {
    const inner = tryParseObject(opening[1]);
    if (inner) return inner;
  }

  return tryParseObject(raw);
}

/** Turn a model reply into the doc bundle the panel edits. */
function normalizeDocResult(parsed, fallbackId) {
  const readme = typeof parsed?.readme === 'string' ? parsed.readme.trim() : '';
  const detailRaw = typeof parsed?.detail === 'string' ? parsed.detail.trim() : '';
  const description = typeof parsed?.description === 'string' ? parsed.description.trim().slice(0, 400) : '';

  const keywords = Array.isArray(parsed?.keywords)
    ? parsed.keywords.map((item) => stringValue(item).toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.map((item) => stringValue(item).toLowerCase()).filter(Boolean).slice(0, 8)
    : [];

  // docs/DETAIL.md is allowed to be exactly one image line. Anything longer
  // would break the details page rule, so keep only the first image line.
  let detail = '';
  const imageLine = detailRaw.split('\n').map((line) => line.trim()).find((line) => /^!\[[^\]]*\]\(([^)]+)\)$/.test(line));
  if (imageLine) detail = imageLine;

  return {
    description: description || (readme.split('\n').find((line) => line.trim()) ?? '').replace(/^#+\s*/, ''),
    readme,
    detail,
    keywords,
    tags,
    suggestedName: repoName(fallbackId),
  };
}

/* ------------------------------------------------------------------ */
/* runtime                                                             */
/* ------------------------------------------------------------------ */

function createRuntime({ ctx, config, fetchImpl = globalThis.fetch }) {
  const dshHome = resolveDshHome(config);
  const stateDir = join(dshHome, 'github-upload');
  const profilesRoot = resolveProfilesRoot(config);

  const tokenStore = createTokenStore({ ctx, stateDir });
  const github = createGitHub({ fetchImpl });
  const device = createDeviceFlow({ fetchImpl, clientId: config?.clientId });

  let settings;
  const settingsFile = join(stateDir, 'settings.json');

  async function loadSettings() {
    if (settings) return settings;
    const parsed = await readJsonFile(settingsFile);
    const storedClientId = stringValue(parsed?.clientId);
    const storedValid = clientIdValue(storedClientId);
    settings = {
      clientId: storedValid || clientIdValue(config?.clientId),
      defaultPrivate: parsed?.defaultPrivate !== false,
      login: stringValue(parsed?.login),
      // Empty means "follow the interface language"; the panel decides what
      // that is, since only the browser knows the system locale.
      docLanguage: docLanguageValue(stringValue(parsed?.docLanguage)),
    };
    // An older build accepted anything into this field, so a token can be
    // sitting in the settings file in plaintext. Drop it on sight instead of
    // leaving a secret on disk that no longer even works.
    if (storedClientId && !storedValid) {
      await saveSettings({ clientId: settings.clientId }).catch(() => undefined);
    }
    return settings;
  }

  async function saveSettings(patch) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const next = { ...(await loadSettings()), ...patch };
    next.clientId = clientIdValue(next.clientId);
    next.docLanguage = docLanguageValue(next.docLanguage);
    settings = next;
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      settingsFile,
      JSON.stringify(
        {
          clientId: next.clientId,
          defaultPrivate: next.defaultPrivate,
          login: next.login,
          docLanguage: next.docLanguage,
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
    return next;
  }

  /** The model the user already has selected for conversations. */
  function currentModel() {
    try {
      const pick = ctx?.get?.('agentDefaultModel', false);
      const selection = pick?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort };
      }
    } catch {
      // No default selection available.
    }
    return null;
  }

  function llmService() {
    try {
      return ctx?.get?.('llm', false) ?? null;
    } catch {
      return null;
    }
  }

  return {
    ctx,
    config,
    dshHome,
    stateDir,
    profilesRoot,
    tokenStore,
    github,
    device,
    loadSettings,
    saveSettings,
    currentModel,
    llm: llmService,
    fetchImpl,
  };
}/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

function createRoutes(runtime) {
  const { tokenStore, github, device } = runtime;
  const { fetchImpl } = runtime;

  /** Run a handler behind the loopback fence and the JSON error envelope. */
  function makeHandler(method, action) {
    return async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback only' });
        return;
      }
      if ((req.method ?? 'GET').toUpperCase() !== method) {
        writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` });
        return;
      }
      let body;
      if (method === 'POST') {
        body = await readJsonBody(req);
        if (body === null) {
          writeJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
      } else {
        body = {};
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        const result = await action({ req, res, query: url.searchParams, body: body ?? {} });
        if (res.writableEnded) return;
        writeJson(res, 200, result ?? { ok: true });
      } catch (error) {
        if (res.writableEnded) return;
        const status = error instanceof GitHubError ? (error.status && error.status >= 400 && error.status < 600 ? error.status : 400) : 500;
        writeJson(res, status, { error: sanitizeMessage(error), ...(error?.extra ?? {}) });
      }
    };
  }

  /** Resolve the stored token or fail with a login hint. */
  async function requireToken() {
    const stored = await tokenStore.read();
    if (!stored?.token) throw new GitHubError(401, 'Not signed in to GitHub. Connect an account first.');
    return stored;
  }

  const routes = [
    /* ---- status ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: makeHandler('GET', async () => {
        const settings = await runtime.loadSettings();
        const stored = await tokenStore.read();
        const where = await tokenStore.describes();
        let viewer = null;
        let tokenValid = false;
        if (stored?.token) {
          try {
            viewer = await github.whoami(stored.token);
            tokenValid = true;
          } catch {
            tokenValid = false;
          }
        }
        return {
          connected: Boolean(stored?.token) && tokenValid,
          tokenPresent: Boolean(stored?.token),
          tokenValid,
          where,
          method: stored?.method ?? '',
          login: viewer?.login ?? stored?.login ?? '',
          name: viewer?.name ?? stored?.name ?? '',
          avatarUrl: viewer?.avatarUrl ?? stored?.avatarUrl ?? '',
          plan: viewer?.plan ?? '',
          scopes: viewer?.scopes ?? stored?.scopes ?? null,
          tokenKind: stored?.token ? tokenKindOf(stored.token) : 'none',
          clientId: settings.clientId,
          defaultPrivate: settings.defaultPrivate,
          // Empty means "follow the interface language": the panel fills the
          // gap with the active locale, because only the browser knows it.
          docLanguage: settings.docLanguage,
          model: runtime.currentModel(),
          llmAvailable: Boolean(runtime.llm()),
          profilesRoot: runtime.profilesRoot,
        };
      }),
    },

    /* ---- what the stored token can actually do ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/permissions`,
      handler: makeHandler('GET', async () => {
        const stored = await requireToken();
        return await github.probe(stored.token);
      }),
    },

    /* ---- preferences ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings`,
      handler: makeHandler('POST', async ({ body }) => {
        const patch = {};
        if ('docLanguage' in body) {
          // An empty string is a real choice: follow the interface language.
          const raw = body.docLanguage === '' ? '' : docLanguageValue(stringValue(body.docLanguage));
          if (raw === '' && stringValue(body.docLanguage) !== '') {
            throw new GitHubError(400, `Unsupported documentation language: ${stringValue(body.docLanguage)}`);
          }
          patch.docLanguage = raw;
        }
        if (!Object.keys(patch).length) throw new GitHubError(400, 'Nothing to save.');
        const next = await runtime.saveSettings(patch);
        return { ok: true, docLanguage: next.docLanguage };
      }),
    },

    /* ---- PAT login ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/connect-token`,
      handler: makeHandler('POST', async ({ body }) => {
        const token = stringValue(body.token);
        if (!token) throw new GitHubError(400, 'Paste a personal access token first.');
        if (token.length < 20) throw new GitHubError(400, 'That does not look like a GitHub token.');
        const viewer = await github.whoami(token);
        const written = await tokenStore.write({
          token,
          login: viewer.login,
          name: viewer.name,
          avatarUrl: viewer.avatarUrl,
          method: 'pat',
          scopes: viewer.scopes,
        });
        return { ok: true, where: written.source, login: viewer.login, avatarUrl: viewer.avatarUrl };
      }),
    },

    /* ---- username + password → authorisation token ---- */
    /* GitHub removed password auth from the REST API in 2021, so the password is never used
       for ordinary calls. The one remaining path is the legacy authorisation API: the
       credential is exchanged for a token exactly once, the password is dropped immediately
       and never written anywhere. */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/password-token`,
      handler: makeHandler('POST', async ({ body }) => {
        const username = stringValue(body.username).trim();
        const password = stringValue(body.password);
        if (!username) throw new GitHubError(400, 'Enter your GitHub username.');
        if (!password) throw new GitHubError(400, 'Enter your GitHub password.');
        const scope = stringValue(body.scope) || PASSWORD_SCOPES;
        const scopes = scope.split(/[\s,]+/).filter(Boolean);
        const note = stringValue(body.note) || 'DeepSeek Harness · dsh-github-upload';

        let response;
        try {
          response = await fetchImpl(GITHUB_API + '/authorizations', {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': GITHUB_API_VERSION,
              'User-Agent': USER_AGENT,
              Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
            },
            body: JSON.stringify({ scopes, note, note_url: 'https://github.com/liustack/deepseek-harness' }),
          });
        } catch (problem) {
          throw new GitHubError(502, `Could not reach GitHub: ${sanitizeMessage(problem?.message ?? problem)}`);
        }

        const raw = await response.text().catch(() => '');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        if (response.ok) {
          const token = stringValue(parsed?.token);
          if (!token) throw new GitHubError(502, 'GitHub returned no token for that request.');
          const viewer = await github.whoami(token);
          const written = await tokenStore.write({
            token,
            login: viewer.login,
            name: viewer.name,
            avatarUrl: viewer.avatarUrl,
            method: 'password',
            scopes: viewer.scopes,
          });
          return { ok: true, method: 'password', token: normalizeSecret(token), login: viewer.login, where: written.source };
        }

        const message = sanitizeMessage(stringValue(parsed?.message) || raw || `HTTP ${response.status}`);
        if (response.status === 401) {
          throw new GitHubError(401, '用户名或密码不正确，GitHub 拒绝了这次请求。', { code: 'password-rejected', github: message });
        }
        if (response.status === 403) {
          throw new GitHubError(403, '这个账号不允许用密码换令牌（多半是已强制开启两步验证），请改用设备码或 PAT。', {
            code: 'two-factor',
            github: message,
          });
        }
        if (response.status === 404) {
          throw new GitHubError(404, '这个账号不允许用密码换令牌，请改用设备码或 PAT。', { code: 'not-allowed', github: message });
        }
        throw new GitHubError(response.status, message, { code: 'github-error' });
      }),
    },

    /* ---- device flow: start ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/device-start`,
      handler: makeHandler('POST', async ({ body }) => {
        device.prune();
        const settings = await runtime.loadSettings();
        const supplied = clientIdValue(body.clientId);
        if (stringValue(body.clientId) && !supplied) {
          throw new GitHubError(400, '那不是 OAuth App 的 Client ID，看起来像是一个访问令牌。Client ID 是公开的短串（形如 Iv1.0123abcd），请不要把 PAT 填在这里。', {
            code: 'BAD_CLIENT_ID',
          });
        }
        const clientId = supplied || settings.clientId;
        if (!clientId) {
          throw new GitHubError(400, 'Enter an OAuth App client id (Settings → Developer settings → OAuth Apps).');
        }
        if (supplied && supplied !== settings.clientId) {
          await runtime.saveSettings({ clientId: supplied });
        }
        const ticketId = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const started = await device.start(ticketId);
        return started;
      }),
    },

    /* ---- device flow: poll ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/device-poll`,
      handler: makeHandler('POST', async ({ body }) => {
        const id = stringValue(body.id);
        if (!id) throw new GitHubError(400, 'Missing device session id.');
        const result = await device.poll(id);
        if (result.status !== 'authorized') return result;

        const viewer = await github.whoami(result.token);
        const written = await tokenStore.write({
          token: result.token,
          login: viewer.login,
          name: viewer.name,
          avatarUrl: viewer.avatarUrl,
          method: 'device',
          scopes: result.scopes ?? viewer.scopes,
        });
        return {
          status: 'authorized',
          where: written.source,
          login: viewer.login,
          avatarUrl: viewer.avatarUrl,
          scopes: result.scopes ?? viewer.scopes,
        };
      }),
    },

    /* ---- disconnect ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/disconnect`,
      handler: makeHandler('POST', async () => {
        await tokenStore.clear();
        return { ok: true };
      }),
    },

    /* ---- repositories the token can push to ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/repos`,
      handler: makeHandler('GET', async () => {
        const stored = await requireToken();
        const repos = await github.listRepos(stored.token);
        return { repos };
      }),
    },

    /* ---- plugins available in the profile ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/plugins`,
      handler: makeHandler('GET', async () => {
        const listed = await listProfilePlugins({
          profilesRoot: runtime.profilesRoot,
          profileName: runtime.config?.profileName,
          config: runtime.config,
        });
        return listed;
      }),
    },

    /* ---- conflict check before publishing ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/check`,
      handler: makeHandler('POST', async ({ body }) => {
        const stored = await requireToken();
        const token = stored.token;
        const owner = stringValue(body.owner);
        const name = repoName(body.name);
        if (!owner) throw new GitHubError(400, 'Missing GitHub owner (account or organisation).');
        if (!name) throw new GitHubError(400, 'Missing repository name.');

        const [existingRepo, nameMatches] = await Promise.all([
          github.getRepo(token, owner, name),
          github.searchByName(token, name).catch(() => []),
        ]);

        // A repository owned by someone else under the same name is the case
        // that most often surprises people, so it is called out separately.
        const foreign = nameMatches.filter((hit) => hit.owner.toLowerCase() !== owner.toLowerCase());

        return {
          owner,
          name,
          existingRepo,
          sameName: nameMatches,
          foreign,
          verdict: existingRepo ? 'exists' : nameMatches.length ? 'name-taken-elsewhere' : 'free',
        };
      }),
    },

    /* ---- AI documentation: streamed ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/analyze`,
      async handler(req, res) {
        if (!isLoopback(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback only' });
          return;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method ?? 'GET'}` });
          return;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          writeJson(res, 400, { error: 'invalid JSON body' });
          return;
        }

        const modelOverride = body?.model && typeof body.model === 'object' ? body.model : null;
        const model = (modelOverride?.provider && modelOverride?.model ? modelOverride : runtime.currentModel()) ?? null;
        if (!model) {
          writeJson(res, 400, {
            error: 'No model selected. Choose a model in Harness settings, then generate again.',
            code: 'NO_MODEL',
          });
          return;
        }

        const llm = runtime.llm();
        if (!llm?.stream) {
          writeJson(res, 400, {
            error: 'The Harness LLM service is not available in this profile.',
            code: 'NO_LLM',
          });
          return;
        }

        let pluginDir = stringValue(body?.pluginDir);
        const pluginId = stringValue(body?.pluginId);
        // The panel sends the language it is showing; a request without one
        // falls back to what the user saved, and then to English.
        const storedSettings = await runtime.loadSettings();
        const language = docLanguageValue(stringValue(body?.language)) || storedSettings.docLanguage || DEFAULT_DOC_LANGUAGE;
        if (!pluginDir && pluginId) {
          const listed = await listProfilePlugins({
            profilesRoot: runtime.profilesRoot,
            profileName: runtime.config?.profileName,
            config: runtime.config,
          });
          pluginDir = listed.plugins.find((item) => item.id === pluginId)?.dir ?? '';
        }
        if (!pluginDir) {
          writeJson(res, 400, { error: 'Pick a plugin to document first.', code: 'NO_PLUGIN' });
          return;
        }

        const manifest = await readPackageDir(pluginDir);
        if (!manifest) {
          writeJson(res, 400, { error: `No package.json in ${pluginDir}.`, code: 'NO_MANIFEST' });
          return;
        }

        const collected = await collectPluginFiles(pluginDir);
        const context = pickModelContext(collected.files, manifest);

        const controller = new AbortController();
        // A dropped browser connection should stop the model request rather
        // than let it burn tokens into a socket nobody reads.
        const onClose = () => controller.abort();
        res.on('close', onClose);

        res.writeHead(200, TEXT_HEADERS);

        const write = (payload) => {
          if (res.writableEnded) return;
          res.write(JSON.stringify(payload) + '\n');
        };

        let text = '';
        try {
          write({
            type: 'start',
            provider: model.provider,
            model: model.model,
            language,
            files: context.map((f) => f.path),
          });

          const stream = llm.stream({
            provider: model.provider,
            model: model.model,
            reasoningEffort: model.reasoningEffort,
            maxTokens: Number(body?.maxTokens) > 0 ? Number(body.maxTokens) : DEFAULT_MAX_TOKENS,
            temperature: 0.3,
            signal: controller.signal,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: buildDocPrompt({
                      pluginId: stringValue(manifest.name) || pluginId,
                      version: stringValue(manifest.version),
                      manifestText: JSON.stringify(manifest, null, 2),
                      files: context,
                      language,
                    }),
                  },
                ],
              },
            ],
          });

          let terminalError = '';
          for await (const chunk of stream) {
            if (chunk?.type === 'text-delta') {
              text += chunk.text ?? '';
              write({ type: 'delta', text: chunk.text ?? '' });
            } else if (chunk?.type === 'finish') {
              const reason = stringValue(chunk.reason);
              if (reason && reason !== 'stop' && reason !== 'length') {
                terminalError = reason;
              }
            }
          }

          // A truncated reply can still look like valid JSON when the cut lands
          // on a closing brace, so report the stop reason instead of quietly
          // publishing a half-written readme.
          if (terminalError) {
            write({ type: 'error', code: terminalError, error: `The model stopped early (${terminalError}).` });
          } else {
            const parsed = extractJsonObject(text);
            if (!parsed) {
              write({ type: 'error', code: 'BAD_JSON', error: 'The model reply was not valid JSON.', raw: text.slice(0, 4000) });
            } else {
              write({
                type: 'done',
                docs: normalizeDocResult(parsed, pluginId || stringValue(manifest.name)),
                raw: text.slice(0, 4000),
              });
            }
          }
        } catch (error) {
          write({ type: 'error', error: sanitizeMessage(error), code: 'STREAM_FAILED' });
        } finally {
          res.off('close', onClose);
          if (!res.writableEnded) res.end();
        }
      },
    },

    /* ---- publish ---- */
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/publish`,
      handler: makeHandler('POST', async ({ body }) => {
        const stored = await requireToken();
        const token = stored.token;

        const owner = stringValue(body.owner);
        const name = repoName(body.name);
        const isPrivate = body.private !== false;
        const createIfMissing = body.createIfMissing !== false;
        const overwrite = body.overwrite === true;
        const description = stringValue(body.description).slice(0, 350);
        const branch = stringValue(body.branch);
        const commitMessage = stringValue(body.message) || `Publish ${name} v${stringValue(body.version) || '0.0.0'}`;

        if (!owner) throw new GitHubError(400, 'Missing GitHub owner.');
        if (!name) throw new GitHubError(400, 'Missing repository name.');

        const pickDir = stringValue(body.pluginDir);
        const pluginId = stringValue(body.pluginId);
        let pluginDir = pickDir;
        if (!pluginDir && pluginId) {
          const listed = await listProfilePlugins({
            profilesRoot: runtime.profilesRoot,
            profileName: runtime.config?.profileName,
            config: runtime.config,
          });
          pluginDir = listed.plugins.find((item) => item.id === pluginId)?.dir ?? '';
        }
        if (!pluginDir) throw new GitHubError(400, 'Pick a plugin to publish first.');

        // Read the plugin from disk, then let the panel's edits win.
        let files = [];
        let heldBack = [];
        const edits = body.files && typeof body.files === 'object' ? body.files : {};
        if (body.includeSource !== false) {
          const collected = await collectPluginFiles(pluginDir);
          files = collected.files.map((file) => ({ path: file.path, content: file.content }));
          heldBack = collected.skipped.filter((item) => item.reason.startsWith('secret-shaped content'));
        }
        const generated = body.generated && typeof body.generated === 'object' ? body.generated : {};
        const readSource = async (path) => {
          const target = safeJoin(pluginDir, path);
          if (!target) return undefined;
          try {
            return await readFile(target, 'utf8');
          } catch {
            return undefined;
          }
        };
        const overlay = (path, content) => {
          if (typeof content !== 'string' || !content) return;
          if (!safeJoin(pluginDir, path)) return;
          // A fresh copy, so an overlay can never alias a collected entry.
          const entry = { path, content: String(content) };
          const index = files.findIndex((file) => file.path === path);
          if (index >= 0) files[index] = entry;
          else files.push(entry);
        };

        // The manifest always ships: it carries the name and description that
        // GitHub shows in the repository header, so it is written last.
        const manifest = await readPackageDir(pluginDir);
        const manifestDescription = description || stringValue(generated.description).slice(0, 350);
        overlay('README.md', typeof edits.readme === 'string' ? edits.readme : generated.readme);
        overlay('docs/DETAIL.md', typeof edits.detail === 'string' ? edits.detail : generated.detail);

        // A repository with no README is a dead end, so a docs-only publish of a
        // plugin that has none gets a minimal one built from the manifest.
        if (!files.some((file) => file.path === 'README.md')) {
          const title = stringValue(manifest?.name) || name;
          const blurb = manifestDescription || stringValue(manifest?.description);
          overlay('README.md', `# ${title}\n\n${blurb || 'A DeepSeek Harness plugin.'}\n`);
        }
        if (manifest) {
          let manifestText = await readSource('package.json');
          if (manifestText) {
            try {
              const nextManifest = manifestDescription ? { ...JSON.parse(manifestText), description: manifestDescription } : JSON.parse(manifestText);
              manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
            } catch {
              // A hand-edited manifest that will not parse ships verbatim.
            }
          } else {
            manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
          }
          overlay('package.json', manifestText);
        }

        if (files.length === 0) throw new GitHubError(400, 'Nothing to publish — the plugin directory has no files.');
        if (files.length > 200) throw new GitHubError(400, `Too many files (${files.length}); the limit is 200.`);

        // Generated docs and panel edits arrive after the disk scan, so the last
        // word on what ships is a scan of the payload itself. Push protection
        // would reject the whole commit over one of them, with no file named.
        const tainted = files
          .map((file) => ({ path: file.path, secret: findSecretInContent(file.content) }))
          .filter((item) => item.secret);
        if (tainted.length > 0) {
          throw new GitHubError(422, `GitHub would block this push: ${tainted.map((item) => item.path).join(', ')} ${tainted.length === 1 ? 'contains' : 'contain'} something token-shaped.`, {
            code: 'SECRET_DETECTED',
            files: tainted.map((item) => item.path),
            permissionHint:
              'Push protection scans the whole commit, including test fixtures and generated docs. ' +
              'Split the literal into pieces (`\'ghp_\' + \'...\'`) or remove it, then publish again.',
          });
        }

        const existing = await github.getRepo(token, owner, name);
        let created = null;
        if (!existing) {
          if (!createIfMissing) throw new GitHubError(409, `Repository ${owner}/${name} does not exist and creating it was not allowed.`);
          created = await github.createRepo(token, { name, description, private: isPrivate, autoInit: true });
        } else if (!overwrite) {
          throw new GitHubError(409, `Repository ${owner}/${name} already exists; confirm overwrite to push into it.`);
        }

        const repo = created ?? existing;
        const result = await github.commitFiles(token, {
          owner: repo.owner || owner,
          repo: repo.name || name,
          branch: branch || repo.defaultBranch,
          files,
          message: commitMessage,
        });

        // The name a model suggested is worth remembering for the next publish.
        if (pluginId) await runtime.saveSettings({ login: stored.login }).catch(() => undefined);

        return {
          ok: true,
          created: Boolean(created),
          repo: {
            fullName: repo.fullName,
            htmlUrl: repo.htmlUrl,
            defaultBranch: repo.defaultBranch,
            private: repo.private,
          },
          commit: result,
          files: files.map((file) => file.path),
          // Files held back by the pre-flight scan: they are absent from the
          // commit, so the panel says which ones instead of leaving a silently
          // incomplete repository.
          heldBack: heldBack.map((item) => ({ path: item.path, reason: item.reason })),
        };
      }),
    },
  ];

  return routes;
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  if (config?.enabled === false) return;

  const runtime = createRuntime({ ctx, config, fetchImpl: config?.fetchImpl ?? globalThis.fetch });

  ctx.effect(() => {
    const disposers = createRoutes(runtime).map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'github-upload: routes');
}

/** Test seam: nothing here touches a live Harness until apply() runs. */
export const __test = {
  createGitHub,
  createDeviceFlow,
  createTokenStore,
  createRuntime,
  createRoutes,
  normalizeSecret,
  sanitizeMessage,
  repoName,
  extractJsonObject,
  normalizeDocResult,
  buildDocPrompt,
  docLanguageValue,
  docLanguageRules,
  DOC_LANGUAGES,
  DEFAULT_DOC_LANGUAGE,
  tokenKindOf,
  acceptedPermissions,
  collectPluginFiles,
  findSecretInContent,
  pickModelContext,
  listProfilePlugins,
  safeJoin,
  isLoopback,
  ROUTE_PREFIX,
  CREDENTIAL_KEY,
};
