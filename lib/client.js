window.__ModuleLoader__.load({
  id: 'dsh-github-upload',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const NS = 'dsh-github-upload';
    const PANEL_ID = 'github-upload';
    const API = 'api/dsh-github-upload';
    const ORDER = 42;

    /* ---------------- dictionaries ---------------- */

    const zh = {
      'entry.label': 'GitHub 上传',
      'panel.title': '发布插件到 GitHub',
      'panel.close': '关闭面板',
      'panel.refresh': '刷新',

      'tab.account': '账号',
      'tab.plugin': '插件',
      'tab.docs': '说明生成',
      'tab.publish': '发布',

      'account.title': 'GitHub 账号',
      'account.signedOut': '尚未登录',
      'account.signedIn': '已登录',
      'account.invalid': '令牌已失效',
      'account.local': '令牌只存在本机，不会写进配置。',
      'account.device': '设备码登录',
      'account.pat': '访问令牌（PAT）',
      'account.clientId': 'OAuth App Client ID',
      'account.clientIdHint': '在 GitHub → Settings → Developer settings → OAuth Apps 新建一个应用，把它们设为 homepage 后复制 Client ID。',
      'account.start': '获取设备码',
      'account.code': '在你的浏览器里输入这个码',
      'account.open': '打开授权页',
      'account.waiting': '正在等待你在 GitHub 上授权……',
      'account.copy': '复制',
      'account.copied': '已复制',
      'account.patLabel': '个人访问令牌',
      'account.patPlaceholder': 'ghp_… 或 github_pat_…',
      'account.patHint': '需要 repo 权限（新建仓库并推送），读取用户信息还需要 read:user。',
      'account.connect': '登录',
      'account.disconnect': '断开',
      'account.verified': '已用 /user 校验',
      'account.where': '存放位置',
      'account.method': '登录方式',
      'account.method.device': '设备码 OAuth',
      'account.method.pat': '个人访问令牌',
      'account.method.password': '账号密码',
      'account.method.none': '—',
      'account.where.credential-record': '凭据记录',
      'account.where.local-file': '本机文件（0600）',
      'account.where.none': '未保存',
      'account.expires': '授权码过期时间',

      'account.perm': '权限检查',
      'account.permCheck': '检查权限',
      'account.permChecking': '正在检查……',
      'account.perm.hint': '授权成功不代表有权新建仓库：先查一次，免得发布到最后一步才被 GitHub 拒绝。',
      'account.perm.kind': '令牌类型',
      'account.perm.kind.fine-grained': '细粒度令牌（fine-grained）',
      'account.perm.kind.classic': '经典令牌（classic）',
      'account.perm.kind.unknown': '未知类型',
      'account.perm.kind.none': '—',
      'account.perm.repos': '可见仓库',
      'account.perm.reposValue': '{count} 个',
      'account.perm.create': '新建仓库',
      'account.perm.create.yes': '可以',
      'account.perm.create.no': '不可以',
      'account.perm.create.unknown': '未确认',
      'account.perm.blocked': '这个令牌不能新建仓库，发布到新仓库时会在最后一步被 GitHub 拒绝。',
      'account.perm.needs': 'GitHub 要求：{list}',
      'account.perm.empty': '这个令牌下看不到任何仓库，多半是「Repository access」没选到目标仓库。',
      'account.perm.fix':
        '在 github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens 里编辑这个令牌：Repository permissions 勾上「Administration: Read and write」（新版也叫「Repository creation: Read and write」），Repository access 选 All repositories，或者把目标仓库加进去。改完回来再检查一次。',
      'account.perm.fixClassic':
        '经典令牌要带 repo scope：在 github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) 里勾上 repo。',

      'account.password': '账号密码',
      'account.passwordNotice':
        'GitHub 从 2021 年 8 月起不再接受密码调用 API，所以这里的密码只用于「换一次令牌」，换来之后立刻丢弃，不写进任何文件。',
      'account.passwordUser': 'GitHub 用户名',
      'account.passwordUserPlaceholder': 'octocat',
      'account.passwordPass': '密码',
      'account.passwordPassHint': '只在内存里用一次：换成令牌后立即丢弃，不保存、不写日志。',
      'account.passwordExchange': '用密码换令牌',
      'account.passwordBusy': '正在向 GitHub 换取令牌……',
      'account.passwordBrowser': '改为在浏览器里登 GitHub',
      'account.passwordBrowserNote':
        '账号已开启两步验证的话，GitHub 会拒绝上面的换令牌请求。点这个按钮打开 github.com，在真实页面里登录一次，回来用设备码或 PAT 拿到令牌。',
      'account.passwordBrowserOpen': '打开 GitHub 登录页',
      'account.passwordMemory': '密码不会保存在本机。',

      'plugin.title': '选择插件',
      'plugin.pick': '选一个要发布的插件',
      'plugin.empty': '这个 profile 里没有找到可以发布的插件。',
      'plugin.reload': '重新扫描',
      'plugin.installed': '已安装',
      'plugin.source': '源码目录',
      'plugin.dir': '目录',
      'plugin.version': '版本',
      'plugin.noClient': '无界面',

      'docs.title': 'AI 生成说明',
      'docs.hint': '会把选中插件的 package.json、入口文件、cordis 补丁和语言包发给当前模型（{provider} / {model}）。',
      'docs.noModel': '还没有选模型。先在 Harness 设置里选一个模型，再回来生成。',
      'docs.generate': '生成说明',
      'docs.regenerate': '重新生成',
      'docs.stop': '停止',
      'docs.streaming': '生成中……',
      'docs.stopped': '已停止',
      'docs.done': '生成完成，可直接编辑后再发布',
      'docs.failed': '生成失败',
      'docs.description': '一句话描述（github 仓库简介）',
      'docs.readme': 'README.md',
      'docs.detail': 'docs / DETAIL.md（只能是一行图片）',
      'docs.keywords': '关键词',
      'docs.tags': '标签',
      'docs.name': '建议仓库名',
      'docs.missing': '还没有生成内容。',
      'docs.language': '说明语言',
      'docs.language.auto': '跟随界面',
      'docs.language.zh': '中文',
      'docs.language.en': 'English',
      'docs.language.hint': '默认与界面语言一致（当前：{current}）。选过之后会记住。',
      'docs.language.unsaved': '这次选择没能保存（{error}），本次会话仍按所选语言生成。',
      'docs.language.saved': '已固定用{language}生成，换界面语言也不会跟着变。',

      'publish.title': '发布',
      'publish.owner': '账号 / 组织',
      'publish.name': '仓库名',
      'publish.private': '私有仓库',
      'publish.includeSource': '连同源码一起上传',
      'publish.check': '检查同名',
      'publish.checking': '检查中……',
      'publish.verdict.free': '这个仓库名可以用，没有发现同名仓库。',
      'publish.verdict.exists': '你已经有一个同名仓库：{repo}（默认分支 {branch}）。',
      'publish.verdict.name-taken-elsewhere': 'GitHub 上已有同名插件/仓库，但不在你名下：{names}。同名仍可创建，只是可能重名。',
      'publish.existing': '同名仓库',
      'publish.conflict': '同名仓库已存在，选一个处理方式：',
      'publish.overwrite': '覆盖（提交到默认分支）',
      'publish.rename': '另存新名',
      'publish.skip': '跳过',
      'publish.go': '发布到 GitHub',
      'publish.working': '正在上传……',
      'publish.done': '发布完成',
      'publish.created': '已新建仓库',
      'publish.pushed': '已推送',
      'publish.open': '在 GitHub 打开',
      'publish.repo': '仓库',
      'publish.branch': '分支',
      'publish.commit': '提交',
      'publish.files': '文件数',
      'publish.heldBack': '有 {count} 个文件含疑似令牌，已扣下没上传（GitHub 会因它们拒收整个提交）：',
      'publish.needDocs': '先生成（或手写）README 再发布。',
      'publish.needPlugin': '先选一个插件。',
      'publish.needOwner': '需要账号或组织名。',
      'publish.needName': '需要仓库名。',

      'common.loading': '加载中……',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.yes': '好',
      'common.no': '取消',
    };

    const en = {
      'entry.label': 'GitHub Upload',
      'panel.title': 'Publish a plugin to GitHub',
      'panel.close': 'Close panel',
      'panel.refresh': 'Refresh',

      'tab.account': 'Account',
      'tab.plugin': 'Plugin',
      'tab.docs': 'Docs',
      'tab.publish': 'Publish',

      'account.title': 'GitHub account',
      'account.signedOut': 'Not signed in',
      'account.signedIn': 'Signed in',
      'account.invalid': 'Token rejected',
      'account.local': 'The token stays on this machine and is never written to configuration.',
      'account.device': 'Device code',
      'account.pat': 'Personal access token',
      'account.clientId': 'OAuth App client id',
      'account.clientIdHint': 'Create an OAuth App under GitHub → Settings → Developer settings → OAuth Apps, then copy its client id.',
      'account.start': 'Get device code',
      'account.code': 'Enter this code in your browser',
      'account.open': 'Open authorisation page',
      'account.waiting': 'Waiting for you to authorise on GitHub…',
      'account.copy': 'Copy',
      'account.copied': 'Copied',
      'account.patLabel': 'Personal access token',
      'account.patPlaceholder': 'ghp_… or github_pat_…',
      'account.patHint': 'Needs the repo scope to create repositories and push, plus read:user to read your profile.',
      'account.connect': 'Sign in',
      'account.disconnect': 'Disconnect',
      'account.verified': 'Verified against /user',
      'account.where': 'Stored in',
      'account.method': 'Sign-in method',
      'account.method.device': 'Device code OAuth',
      'account.method.pat': 'Personal access token',
      'account.method.password': 'Username and password',
      'account.method.none': '—',
      'account.where.credential-record': 'A credential record',
      'account.where.local-file': 'A local file (0600)',
      'account.where.none': 'Nothing stored',
      'account.expires': 'Code expires',

      'account.perm': 'Permissions',
      'account.permCheck': 'Check permissions',
      'account.permChecking': 'Checking…',
      'account.perm.hint': 'A successful sign-in does not mean repositories can be created — check first instead of failing at the last step of a publish.',
      'account.perm.kind': 'Token type',
      'account.perm.kind.fine-grained': 'Fine-grained token',
      'account.perm.kind.classic': 'Classic token',
      'account.perm.kind.unknown': 'Unrecognised type',
      'account.perm.kind.none': '—',
      'account.perm.repos': 'Visible repositories',
      'account.perm.reposValue': '{count}',
      'account.perm.create': 'Create repositories',
      'account.perm.create.yes': 'Allowed',
      'account.perm.create.no': 'Not allowed',
      'account.perm.create.unknown': 'Not confirmed',
      'account.perm.blocked': 'This token cannot create repositories, so publishing into a new one will be refused by GitHub at the last step.',
      'account.perm.needs': 'GitHub asks for: {list}',
      'account.perm.empty': 'No repositories are visible to this token, which usually means "Repository access" does not include the target repository.',
      'account.perm.fix':
        'Edit the token at github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens: under Repository permissions add "Administration: Read and write" (newer tokens call it "Repository creation: Read and write"), and under Repository access choose All repositories or add the target one. Come back and check again.',
      'account.perm.fixClassic':
        'A classic token needs the repo scope: tick it at github.com → Settings → Developer settings → Personal access tokens → Tokens (classic).',

      'account.password': 'Username and password',
      'account.passwordNotice':
        'GitHub stopped accepting passwords for API calls in August 2021, so the password here is used for one thing only: exchanging it for a token. It is discarded immediately afterwards and never written to a file.',
      'account.passwordUser': 'GitHub username',
      'account.passwordUserPlaceholder': 'octocat',
      'account.passwordPass': 'Password',
      'account.passwordPassHint': 'Held in memory for one exchange, then dropped. Never stored, never logged.',
      'account.passwordExchange': 'Exchange for a token',
      'account.passwordBusy': 'Asking GitHub for a token…',
      'account.passwordBrowser': 'Sign in through the browser instead',
      'account.passwordBrowserNote':
        'If your account enforces two-factor authentication, GitHub refuses the exchange above. Open github.com below, sign in on the real page, and come back for a token through the device code or a PAT.',
      'account.passwordBrowserOpen': 'Open the GitHub sign-in page',
      'account.passwordMemory': 'The password is never saved on this machine.',

      'plugin.title': 'Choose a plugin',
      'plugin.pick': 'Pick the plugin to publish',
      'plugin.empty': 'No publishable plugin was found in this profile.',
      'plugin.reload': 'Rescan',
      'plugin.installed': 'Installed',
      'plugin.source': 'Source folder',
      'plugin.dir': 'Folder',
      'plugin.version': 'Version',
      'plugin.noClient': 'No UI',

      'docs.title': 'Generate the description',
      'docs.hint': "Sends the selected plugin's package.json, entry file, cordis patch and locale files to your current model ({provider} / {model}).",
      'docs.noModel': 'No model is selected yet. Pick one in Harness settings, then come back.',
      'docs.generate': 'Generate docs',
      'docs.regenerate': 'Regenerate',
      'docs.stop': 'Stop',
      'docs.streaming': 'Generating…',
      'docs.stopped': 'Stopped',
      'docs.done': 'Generated — edit anything before publishing',
      'docs.failed': 'Generation failed',
      'docs.description': 'One-sentence description (repository blurb)',
      'docs.readme': 'README.md',
      'docs.detail': 'docs / DETAIL.md (one image line only)',
      'docs.keywords': 'Keywords',
      'docs.tags': 'Tags',
      'docs.name': 'Suggested repository name',
      'docs.missing': 'Nothing generated yet.',
      'docs.language': 'Description language',
      'docs.language.auto': 'Follow the interface',
      'docs.language.zh': '中文',
      'docs.language.en': 'English',
      'docs.language.hint': 'Defaults to the interface language (now: {current}). Your choice is remembered.',
      'docs.language.unsaved': 'That choice could not be saved ({error}); this session still generates in it.',
      'docs.language.saved': 'Generating in {language}; it stays fixed when the interface language changes.',

      'publish.title': 'Publish',
      'publish.owner': 'Account or organisation',
      'publish.name': 'Repository name',
      'publish.private': 'Private repository',
      'publish.includeSource': 'Upload the source files too',
      'publish.check': 'Check for name conflicts',
      'publish.checking': 'Checking…',
      'publish.verdict.free': 'This name is free — no repository of that name was found.',
      'publish.verdict.exists': 'You already have a repository with this name: {repo} (default branch {branch}).',
      'publish.verdict.name-taken-elsewhere': 'The name is already used on GitHub, but not by you: {names}. You can still create it.',
      'publish.existing': 'Existing repository',
      'publish.conflict': 'A repository with this name exists. Choose what to do:',
      'publish.overwrite': 'Overwrite (commit to the default branch)',
      'publish.rename': 'Save under a new name',
      'publish.skip': 'Skip',
      'publish.go': 'Publish to GitHub',
      'publish.working': 'Uploading…',
      'publish.done': 'Published',
      'publish.created': 'Repository created',
      'publish.pushed': 'Pushed',
      'publish.open': 'Open on GitHub',
      'publish.repo': 'Repository',
      'publish.branch': 'Branch',
      'publish.commit': 'Commit',
      'publish.files': 'Files',
      'publish.heldBack': '{count} file(s) looked token-shaped and were held back (GitHub would have rejected the whole commit):',
      'publish.needDocs': 'Generate (or write) a README before publishing.',
      'publish.needPlugin': 'Pick a plugin first.',
      'publish.needOwner': 'An account or organisation is required.',
      'publish.needName': 'A repository name is required.',

      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.yes': 'OK',
      'common.no': 'Cancel',
    };

    let translate = (key) => key;
    function tt(key, params) {
      let text = translate(key);
      if (typeof text !== 'string' || text === key) text = en[key] ?? key;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
        }
      }
      return text;
    }

    /* ---------------- language helpers ---------------- */

    // The host cannot see the browser's language, so the panel resolves the
    // "follow the interface" default here and sends the concrete choice along
    // with every generation request.
    let appCtx = null;

    /** Map a locale id onto a language the documentation writer supports. */
    function docLanguageFrom(localeId) {
      return String(localeId || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function readActiveLocale() {
      try {
        const snapshot = appCtx?.locale?.getLocale?.();
        if (snapshot?.active) return String(snapshot.active);
      } catch {
        // No locale service in this build.
      }
      return '';
    }

    /** Track the active interface locale, so "follow the interface" stays live. */
    function useActiveLocale() {
      const [active, setActive] = useState(readActiveLocale);
      useEffect(() => {
        const off = (() => {
          try {
            return appCtx?.on?.('locale/change', (snapshot) => setActive(snapshot?.active ?? readActiveLocale()));
          } catch {
            return undefined;
          }
        })();
        setActive(readActiveLocale());
        return () => {
          try {
            off?.();
          } catch {
            // Listener already detached.
          }
        };
      }, []);
      return active;
    }

    /* ---------------- styling ---------------- */

    const CSS = `
.ghu-root{--ghu-surface:#ffffff;--ghu-surface-2:#f5f6f9;--ghu-surface-3:#eceef3;--ghu-line:#d9dde6;--ghu-line-strong:#c3c9d4;--ghu-text:#1a1d23;--ghu-muted:#5b6472;--ghu-brand:#4176e6;--ghu-brand-soft:rgba(65,118,230,.12);--ghu-ok:#1a8f5e;--ghu-warn:#a86a00;--ghu-err:#c8383c;--ghu-on-brand:#ffffff;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--ghu-surface);color:var(--ghu-text);font-size:13px;line-height:1.5;font-family:inherit;isolation:isolate}
body[data-ds-dark-theme] .ghu-root{--ghu-surface:#15171c;--ghu-surface-2:#1b1e24;--ghu-surface-3:#23272f;--ghu-line:#2c313a;--ghu-line-strong:#3a4150;--ghu-text:#e8eaef;--ghu-muted:#9aa1ad;--ghu-brand:#5b8df6;--ghu-brand-soft:rgba(91,141,246,.16);--ghu-ok:#3ecf8e;--ghu-warn:#f5a524;--ghu-err:#f2555a;--ghu-on-brand:#0b1220}
.ghu-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--ghu-line);background:var(--ghu-surface-2);flex:0 0 auto}
.ghu-head h1{font-size:14px;font-weight:600;margin:0;white-space:nowrap}
.ghu-head .ghu-spacer{flex:1 1 auto;min-width:0}
.ghu-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid var(--ghu-line);background:var(--ghu-surface);font-size:11.5px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.ghu-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.ghu-dot.on{background:var(--ghu-ok)}
.ghu-dot.off{background:var(--ghu-err)}
.ghu-dot.wait{background:var(--ghu-warn)}
.ghu-tabs{display:flex;gap:2px;padding:6px 12px 0;border-bottom:1px solid var(--ghu-line);background:var(--ghu-surface-2);flex:0 0 auto;overflow-x:auto}
.ghu-tab{padding:7px 12px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:var(--ghu-muted);cursor:pointer;font-size:12.5px;white-space:nowrap;font-family:inherit}
.ghu-tab:hover{color:var(--ghu-text);background:var(--ghu-surface-3)}
.ghu-tab.on{color:var(--ghu-text);background:var(--ghu-surface);border-color:var(--ghu-line);font-weight:600}
.ghu-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px;background:var(--ghu-surface)}
.ghu-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.ghu-input,.ghu-select,.ghu-textarea{background:var(--ghu-surface-2);border:1px solid var(--ghu-line-strong);color:var(--ghu-text);border-radius:8px;padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none;min-width:0;box-sizing:border-box;max-width:100%}
.ghu-input{text-overflow:ellipsis}
.ghu-input:focus,.ghu-select:focus,.ghu-textarea:focus{border-color:var(--ghu-brand);box-shadow:0 0 0 3px var(--ghu-brand-soft)}
.ghu-input.grow{width:100%;flex:0 0 auto}
.ghu-textarea{width:100%;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;min-height:120px}
.ghu-btn{border:1px solid var(--ghu-line-strong);background:var(--ghu-surface-2);color:var(--ghu-text);border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap;font-family:inherit}
.ghu-btn:hover:not(:disabled){border-color:var(--ghu-brand);color:var(--ghu-brand)}
.ghu-btn:disabled{opacity:.5;cursor:default}
.ghu-btn.primary{background:var(--ghu-brand);border-color:var(--ghu-brand);color:var(--ghu-on-brand);font-weight:600}
.ghu-btn.primary:hover:not(:disabled){filter:brightness(1.08);color:var(--ghu-on-brand)}
.ghu-btn.ghost{background:transparent}
.ghu-btn.danger:hover:not(:disabled){border-color:var(--ghu-err);color:var(--ghu-err)}
.ghu-btn.sm{padding:4px 9px;font-size:11.5px}
.ghu-note{color:var(--ghu-muted);font-size:11.5px;margin:6px 0 0}
.ghu-error{border:1px solid var(--ghu-err);background:color-mix(in srgb,var(--ghu-err) 12%,var(--ghu-surface));color:var(--ghu-err);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;word-break:break-word;white-space:pre-wrap}
.ghu-ok{border:1px solid var(--ghu-ok);background:color-mix(in srgb,var(--ghu-ok) 12%,var(--ghu-surface));color:var(--ghu-ok);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;word-break:break-word}
.ghu-warn{border:1px solid var(--ghu-warn);background:color-mix(in srgb,var(--ghu-warn) 12%,var(--ghu-surface));color:var(--ghu-warn);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;word-break:break-word}
.ghu-section{border:1px solid var(--ghu-line);border-radius:10px;background:var(--ghu-surface-2);padding:12px;margin-bottom:12px;min-width:0}
.ghu-section > h3{margin:0 0 8px;font-size:13px}
.ghu-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;min-width:0}
.ghu-field > label{font-size:11.5px;color:var(--ghu-muted)}
.ghu-seg{display:inline-flex;padding:2px;gap:2px;border:1px solid var(--ghu-line);border-radius:9px;background:var(--ghu-surface-3);align-self:flex-start;max-width:100%;overflow:hidden}
.ghu-seg-btn{padding:5px 12px;border:none;border-radius:7px;background:transparent;color:var(--ghu-muted);font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.ghu-seg-btn:hover{color:var(--ghu-text)}
.ghu-seg-btn.on{background:var(--ghu-brand);color:var(--ghu-on-brand);font-weight:600}
.ghu-account{display:flex;gap:12px;align-items:center;min-width:0}
.ghu-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--ghu-surface-3);border:1px solid var(--ghu-line);flex:0 0 auto}
.ghu-avatar.ph{display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--ghu-muted)}
.ghu-account-main{flex:1 1 auto;min-width:0}
.ghu-account-name{font-size:14px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghu-code{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;border:1px dashed var(--ghu-brand);background:var(--ghu-surface-3);margin:8px 0}
.ghu-code strong{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:19px;letter-spacing:.14em;color:var(--ghu-brand)}
.ghu-list{display:flex;flex-direction:column;gap:6px}
.ghu-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--ghu-line);border-radius:8px;background:var(--ghu-surface);min-width:0;text-align:left;font-family:inherit;color:var(--ghu-text);cursor:pointer;width:100%;box-sizing:border-box}
.ghu-item.on{border-color:var(--ghu-brand);background:var(--ghu-brand-soft)}
.ghu-item .ghu-main{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.ghu-item .ghu-sub{font-size:11px;color:var(--ghu-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ghu-tag{font-size:10.5px;padding:2px 6px;border-radius:5px;background:var(--ghu-surface-3);border:1px solid var(--ghu-line);color:var(--ghu-muted);white-space:nowrap}
.ghu-table{width:100%;border-collapse:collapse;margin:10px 0}
.ghu-table td{padding:5px 8px;border-bottom:1px solid var(--ghu-line);vertical-align:top;font-size:12.5px;word-break:break-word}
.ghu-table td:first-child{color:var(--ghu-muted);width:110px;white-space:nowrap}
.ghu-empty{color:var(--ghu-muted);padding:24px 4px;text-align:center}
.ghu-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--ghu-line-strong);border-top-color:var(--ghu-brand);border-radius:50%;animation:ghu-spin .8s linear infinite}
@keyframes ghu-spin{to{transform:rotate(360deg)}}
.ghu-stream{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-word;background:var(--ghu-surface-3);border:1px solid var(--ghu-line);border-radius:8px;padding:10px;max-height:240px;overflow:auto;color:var(--ghu-text);margin-top:8px}
.ghu-note.warn{color:var(--ghu-warn);border:1px solid var(--ghu-line);border-radius:8px;padding:8px 10px;background:var(--ghu-surface-3)}
.ghu-browser{margin-top:12px;border-top:1px dashed var(--ghu-line);padding-top:10px}
.ghu-icon-btn{background:transparent;border:none;color:var(--ghu-muted);cursor:pointer;padding:4px;border-radius:6px;display:inline-flex;line-height:0}
.ghu-icon-btn:hover{color:var(--ghu-text);background:var(--ghu-surface-3)}
.ghu-steps{display:flex;flex-direction:column;gap:8px}
.ghu-progress{height:8px;border-radius:999px;background:var(--ghu-surface-3);overflow:hidden;border:1px solid var(--ghu-line);margin-top:8px}
.ghu-progress > i{display:block;height:100%;background:var(--ghu-brand);transition:width .3s}
`;

    let cssMounted = false;
    function mountCss() {
      if (cssMounted || typeof document === 'undefined') return;
      cssMounted = true;
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ---------------- host calls ---------------- */

    async function request(path, payload) {
      const init = { method: payload === undefined ? 'GET' : 'POST', headers: {} };
      if (payload !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(payload);
      }
      const response = await fetch(`${API}/${path}`, init);
      let body;
      // Some runtimes hand back a body that has to be decoded explicitly.
      try {
        body = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        // The host puts its guidance next to the message (which permission was
        // missing, what to grant), so keep the whole envelope on the error and
        // fold the hint into the text the panel shows.
        const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
        const hint = typeof body?.permissionHint === 'string' ? body.permissionHint : '';
        const failure = new Error(hint ? `${message}\n\n${hint}` : message);
        failure.status = response.status;
        failure.detail = body && typeof body === 'object' ? body : {};
        throw failure;
      }
      return body ?? {};
    }

    /**
     * Stream the documentation call. The host writes one JSON object per line,
     * so a partial buffer at the end of a chunk is carried into the next read.
     */
    async function streamDocs(payload, { onDelta, onEvent, signal }) {
      const response = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        let body;
        try {
          body = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text());
        } catch {
          body = undefined;
        }
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        // Fall back to a whole-body read where streams are unavailable.
        const text = await response.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line));
          } catch {
            // A truncated final line is not fatal.
          }
        }
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'delta') onDelta?.(event.text ?? '');
          else onEvent(event);
        }
      }
      if (buffer.trim()) {
        try {
          onEvent(JSON.parse(buffer));
        } catch {
          // Ignore a trailing partial object.
        }
      }
    }

    /* ---------------- small components ---------------- */

    function PanelIcon({ size, active }) {
      const s = Number(size) || 20;
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: active ? 1 : 0.82 },
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 17V4' }),
        h('path', { d: 'M7.5 8.5 12 4l4.5 4.5' }),
        h('path', { d: 'M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15' }),
      );
    }

    function Field({ label, hint, children }) {
      return h(
        'div',
        { className: 'ghu-field' },
        h('label', null, label),
        children,
        hint ? h('div', { className: 'ghu-note' }, hint) : null,
      );
    }

    function Avatar({ url, login, size }) {
      if (url) {
        return h('img', {
          className: 'ghu-avatar',
          src: url,
          alt: login || '',
          style: size ? { width: size, height: size } : undefined,
        });
      }
      const letter = String(login || '?').slice(0, 1).toUpperCase();
      return h('div', { className: 'ghu-avatar ph', style: size ? { width: size, height: size } : undefined }, letter);
    }

    function Seg({ value, options, onChange }) {
      return h(
        'div',
        { className: 'ghu-seg', role: 'tablist' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              'aria-selected': value === option.value,
              className: value === option.value ? 'ghu-seg-btn on' : 'ghu-seg-btn',
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    /* ---------------- account view ---------------- */

    function AccountView({ state, onChanged }) {
      const [mode, setMode] = useState('device');
      const [clientId, setClientId] = useState(state.settings?.clientId ?? '');
      const [token, setToken] = useState('');
      const [username, setUsername] = useState('');
      const [password, setPassword] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [ticket, setTicket] = useState(null);
      const [copied, setCopied] = useState(false);
      const [permissions, setPermissions] = useState(null);
      const [checkingPermissions, setCheckingPermissions] = useState(false);
      const pollRef = useRef(null);

      useEffect(() => {
        // A different account (or none) invalidates whatever was probed before.
        setPermissions(null);
      }, [state.status?.login, state.status?.tokenPresent]);

      async function checkPermissions() {
        if (checkingPermissions) return;
        setError('');
        setCheckingPermissions(true);
        try {
          setPermissions(await request('permissions'));
        } catch (problem) {
          setPermissions(null);
          setError(problem.message);
        } finally {
          setCheckingPermissions(false);
        }
      }

      useEffect(() => {
        setClientId(state.settings?.clientId ?? '');
      }, [state.settings?.clientId]);

      useEffect(
        () => () => {
          if (pollRef.current) clearInterval(pollRef.current);
        },
        [],
      );

      const stopPolling = useCallback(() => {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      const poll = useCallback(
        async (id) => {
          try {
            const result = await request('device-poll', { id });
            if (result.status === 'pending') return;
            if (result.status === 'slow_down') {
              // GitHub asked us to back off; restart the timer slower.
              stopPolling();
              pollRef.current = setInterval(() => poll(id), Math.max(5, Number(result.interval) || 10) * 1000);
              return;
            }
            stopPolling();
            setTicket(null);
            if (result.status === 'authorized') {
              setBusy('');
              onChanged?.();
              return;
            }
            setBusy('');
            if (result.status === 'expired') setError(tt('account.code') + ': expired — start again.');
            else if (result.status === 'denied') setError('Authorisation was denied on GitHub.');
            else setError(result.message || result.error || 'Sign-in failed.');
          } catch (problem) {
            stopPolling();
            setBusy('');
            setError(problem.message);
          }
        },
        [onChanged, stopPolling],
      );

      async function startDevice() {
        if (busy) return;
        setError('');
        setBusy('device');
        try {
          const started = await request('device-start', { clientId });
          setTicket(started);
          const interval = Math.max(5, Number(started.interval) || 5);
          stopPolling();
          pollRef.current = setInterval(() => poll(started.id), interval * 1000);
          // First poll after one interval, matching GitHub's documented timing.
        } catch (problem) {
          setBusy('');
          setError(problem.message);
        }
      }

      async function connectPat() {
        if (busy) return;
        setError('');
        setBusy('pat');
        try {
          await request('connect-token', { token });
          setToken('');
          onChanged?.();
        } catch (problem) {
          setError(problem.message);
        } finally {
          setBusy('');
        }
      }

      /**
       * GitHub has no password sign-in for API use. The only path left is the
       * legacy authorisation endpoint: the password buys one token, then it is
       * dropped from this component's state immediately.
       */
      async function connectPassword() {
        if (busy) return;
        if (!username.trim() || !password) return;
        setError('');
        setBusy('password');
        try {
          await request('password-token', { username: username.trim(), password });
          setPassword('');
          setToken('');
          onChanged?.();
        } catch (problem) {
          setPassword('');
          setError(problem.message);
        } finally {
          setBusy('');
        }
      }

      function openBrowserLogin() {
        try {
          window.open('https://github.com/login', '_blank', 'noopener,noreferrer');
        } catch {
          setError('Could not open a browser tab — visit github.com/login manually.');
        }
      }

      async function disconnect() {
        setError('');
        setBusy('disconnect');
        try {
          await request('disconnect', {});
          onChanged?.();
        } catch (problem) {
          setError(problem.message);
        } finally {
          setBusy('');
        }
      }

      function copyCode() {
        const code = ticket?.userCode ?? '';
        if (!code) return;
        try {
          navigator.clipboard?.writeText?.(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard is unavailable in some embeddings; the code is on screen.
        }
      }

      const connected = state.status?.connected === true;
      const tokenPresent = state.status?.tokenPresent === true;
      const where = state.status?.where ?? { source: 'none' };

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ghu-section' },
          h('h3', null, tt('account.title')),
          h(
            'div',
            { className: 'ghu-account' },
            h(Avatar, { url: state.status?.avatarUrl, login: state.status?.login }),
            h(
              'div',
              { className: 'ghu-account-main' },
              h(
                'p',
                { className: 'ghu-account-name' },
                connected ? state.status.login : tokenPresent ? tt('account.invalid') : tt('account.signedOut'),
              ),
              h(
                'div',
                { className: 'ghu-row' },
                h('span', { className: connected ? 'ghu-dot on' : tokenPresent ? 'ghu-dot wait' : 'ghu-dot off' }),
                h(
                  'span',
                  { className: 'ghu-note', style: { margin: 0 } },
                  tt('account.verified'),
                  state.status?.plan ? ` · ${state.status.plan}` : '',
                ),
              ),
            ),
            connected
              ? h(
                  'button',
                  { className: 'ghu-btn danger sm', type: 'button', onClick: disconnect, disabled: busy === 'disconnect' },
                  busy === 'disconnect' ? h('span', { className: 'ghu-spin' }) : tt('account.disconnect'),
                )
              : null,
          ),
          h(
            'table',
            { className: 'ghu-table' },
            h(
              'tbody',
              null,
              h(
                'tr',
                null,
                h('td', null, tt('account.method')),
                h('td', null, tt(`account.method.${state.status?.method || 'none'}`)),
              ),
              h(
                'tr',
                null,
                h('td', null, tt('account.where')),
                h('td', null, tt(`account.where.${where.source || 'none'}`)),
              ),
              connected
                ? h(
                    'tr',
                    null,
                    h('td', null, tt('account.perm.kind')),
                    h(
                      'td',
                      null,
                      tt(`account.perm.kind.${permissions?.tokenKind ?? state.status?.tokenKind ?? 'none'}`),
                    ),
                  )
                : null,
            ),
          ),
          h('p', { className: 'ghu-note' }, tt('account.local')),
        ),

        connected
          ? h(
              'div',
              { className: 'ghu-section' },
              h(
                'div',
                { className: 'ghu-row' },
                h('h3', { style: { margin: 0 } }, tt('account.perm')),
                h('div', { className: 'ghu-spacer', style: { flex: '1 1 auto' } }),
                h(
                  'button',
                  {
                    className: 'ghu-btn sm',
                    type: 'button',
                    onClick: checkPermissions,
                    disabled: checkingPermissions,
                  },
                  checkingPermissions ? h('span', { className: 'ghu-spin' }) : tt('account.permCheck'),
                ),
              ),
              permissions
                ? h(
                    'div',
                    null,
                    h(
                      'table',
                      { className: 'ghu-table' },
                      h(
                        'tbody',
                        null,
                        h(
                          'tr',
                          null,
                          h('td', null, tt('account.perm.repos')),
                          h(
                            'td',
                            null,
                            permissions.canListRepos === false
                              ? '—'
                              : tt('account.perm.reposValue', { count: String(permissions.visibleRepos ?? 0) }),
                          ),
                        ),
                        h(
                          'tr',
                          null,
                          h('td', null, tt('account.perm.create')),
                          h(
                            'td',
                            null,
                            tt(
                              `account.perm.create.${
                                permissions.canCreateRepo === 'yes'
                                  ? 'yes'
                                  : permissions.canCreateRepo === 'no'
                                    ? 'no'
                                    : 'unknown'
                              }`,
                            ),
                          ),
                        ),
                      ),
                    ),
                    permissions.canCreateRepo === 'no'
                      ? h(
                          'div',
                          { className: 'ghu-warn' },
                          tt('account.perm.blocked'),
                          permissions.needsPermissions?.length
                            ? h('p', { style: { margin: '6px 0 0' } }, tt('account.perm.needs', { list: permissions.needsPermissions.join(', ') }))
                            : null,
                          h(
                            'p',
                            { style: { margin: '6px 0 0' } },
                            permissions.tokenKind === 'classic'
                              ? tt('account.perm.fixClassic')
                              : tt('account.perm.fix'),
                          ),
                        )
                      : null,
                    permissions.canCreateRepo !== 'no' && permissions.visibleRepos === 0
                      ? h('div', { className: 'ghu-note warn' }, tt('account.perm.empty'))
                      : null,
                  )
                : h(
                    'p',
                    { className: 'ghu-note' },
                    tt('account.perm.hint'),
                  ),
            )
          : null,

        error ? h('div', { className: 'ghu-error' }, error) : null,

        h(
          'div',
          { className: 'ghu-section' },
          h(
            Seg,
            {
              value: mode,
              onChange: (next) => {
                setError('');
                setMode(next);
              },
              options: [
                { value: 'device', label: tt('account.device') },
                { value: 'pat', label: tt('account.pat') },
                { value: 'password', label: tt('account.password') },
              ],
            },
          ),

          mode === 'device'
            ? h(
                'div',
                { style: { marginTop: 12 } },
                h(
                  Field,
                  { label: tt('account.clientId'), hint: tt('account.clientIdHint') },
                  h('input', {
                    className: 'ghu-input grow',
                    type: 'text',
                    value: clientId,
                    spellCheck: false,
                    placeholder: 'Iv1.0123456789abcdef',
                    onChange: (event) => setClientId(event.target.value),
                  }),
                ),
                ticket
                  ? h(
                      'div',
                      null,
                      h('p', { className: 'ghu-note' }, tt('account.code')),
                      h(
                        'div',
                        { className: 'ghu-code' },
                        h('strong', null, ticket.userCode),
                        h(
                          'button',
                          { className: 'ghu-btn sm', type: 'button', onClick: copyCode },
                          copied ? tt('account.copied') : tt('account.copy'),
                        ),
                        h(
                          'a',
                          {
                            className: 'ghu-btn sm primary',
                            href: ticket.verificationUri,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                            style: { textDecoration: 'none' },
                          },
                          tt('account.open'),
                        ),
                      ),
                      h(
                        'p',
                        { className: 'ghu-note' },
                        h('span', { className: 'ghu-spin', style: { marginRight: 6 } }),
                        tt('account.waiting'),
                        ticket.expiresAt ? ` (${tt('account.expires')}: ${new Date(ticket.expiresAt).toLocaleTimeString()})` : '',
                      ),
                    )
                  : null,
                h(
                  'div',
                  { className: 'ghu-row', style: { marginTop: 10 } },
                  h(
                    'button',
                    { className: 'ghu-btn primary', type: 'button', onClick: startDevice, disabled: busy === 'device' || Boolean(ticket) },
                    busy === 'device' ? h('span', { className: 'ghu-spin' }) : ticket ? tt('account.waiting') : tt('account.start'),
                  ),
                  ticket
                    ? h(
                        'button',
                        {
                          className: 'ghu-btn ghost',
                          type: 'button',
                          onClick: () => {
                            stopPolling();
                            setTicket(null);
                            setBusy('');
                          },
                        },
                        tt('common.cancel'),
                      )
                    : null,
                ),
              )
            : h(
                'div',
                { style: { marginTop: 12 } },
                h(
                  Field,
                  { label: tt('account.patLabel'), hint: tt('account.patHint') },
                  h('input', {
                    className: 'ghu-input grow',
                    type: 'password',
                    value: token,
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder: tt('account.patPlaceholder'),
                    onChange: (event) => setToken(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') connectPat();
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'ghu-row' },
                  h(
                    'button',
                    { className: 'ghu-btn primary', type: 'button', onClick: connectPat, disabled: busy === 'pat' || !token.trim() },
                    busy === 'pat' ? h('span', { className: 'ghu-spin' }) : tt('account.connect'),
                  ),
                ),
              ),
          mode === 'password'
            ? h(
                'div',
                { style: { marginTop: 12 } },
                h('p', { className: 'ghu-note warn' }, tt('account.passwordNotice')),
                h(
                  Field,
                  { label: tt('account.passwordUser') },
                  h('input', {
                    className: 'ghu-input grow',
                    type: 'text',
                    value: username,
                    spellCheck: false,
                    autoComplete: 'username',
                    placeholder: tt('account.passwordUserPlaceholder'),
                    onChange: (event) => setUsername(event.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: tt('account.passwordPass'), hint: tt('account.passwordPassHint') },
                  h('input', {
                    className: 'ghu-input grow',
                    type: 'password',
                    value: password,
                    spellCheck: false,
                    autoComplete: 'current-password',
                    onChange: (event) => setPassword(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') connectPassword();
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'ghu-row' },
                  h(
                    'button',
                    {
                      className: 'ghu-btn primary',
                      type: 'button',
                      onClick: connectPassword,
                      disabled: busy === 'password' || !username.trim() || !password,
                    },
                    busy === 'password' ? h('span', { className: 'ghu-spin' }) : tt('account.passwordExchange'),
                  ),
                  h(
                    'button',
                    { className: 'ghu-btn ghost', type: 'button', onClick: () => setMode('pat') },
                    tt('account.pat'),
                  ),
                ),
                h(
                  'div',
                  { className: 'ghu-browser' },
                  h('p', { className: 'ghu-note', style: { marginTop: 0 } }, tt('account.passwordBrowserNote')),
                  h(
                    'div',
                    { className: 'ghu-row' },
                    h('button', { className: 'ghu-btn sm', type: 'button', onClick: openBrowserLogin }, tt('account.passwordBrowserOpen')),
                    h(
                      'button',
                      { className: 'ghu-btn sm ghost', type: 'button', onClick: () => setMode('device') },
                      tt('account.device'),
                    ),
                  ),
                ),
                h('p', { className: 'ghu-note' }, tt('account.passwordMemory')),
              )
            : null,
        ),
      );
    }

    /* ---------------- plugin view ---------------- */

    function PluginView({ state, onPick }) {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      async function reload() {
        setBusy(true);
        setError('');
        try {
          await state.reloadPlugins();
        } catch (problem) {
          setError(problem.message);
        } finally {
          setBusy(false);
        }
      }

      const plugins = state.plugins ?? [];

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ghu-section' },
          h(
            'div',
            { className: 'ghu-row' },
            h('h3', { style: { margin: 0, flex: '1 1 auto' } }, tt('plugin.title')),
            h(
              'button',
              { className: 'ghu-btn sm', type: 'button', onClick: reload, disabled: busy },
              busy ? h('span', { className: 'ghu-spin' }) : tt('plugin.reload'),
            ),
          ),
          error ? h('div', { className: 'ghu-error' }, error) : null,
          state.pluginsLoading
            ? h('div', { className: 'ghu-empty' }, tt('common.loading'))
            : plugins.length === 0
              ? h('div', { className: 'ghu-empty' }, tt('plugin.empty'))
              : h(
                  'div',
                  { className: 'ghu-list', style: { marginTop: 10 } },
                  plugins.map((plugin) =>
                    h(
                      'button',
                      {
                        key: plugin.id,
                        type: 'button',
                        className: plugin.dir === state.selectedDir ? 'ghu-item on' : 'ghu-item',
                        onClick: () => onPick(plugin),
                      },
                      h(
                        'div',
                        { style: { flex: '1 1 auto', minWidth: 0 } },
                        h('div', { className: 'ghu-main' }, plugin.id),
                        h(
                          'div',
                          { className: 'ghu-sub' },
                          plugin.version ? `v${plugin.version}` : '',
                          plugin.description ? ` · ${plugin.description}` : '',
                        ),
                      ),
                      plugin.installed ? h('span', { className: 'ghu-tag' }, tt('plugin.installed')) : null,
                      plugin.hasClient ? null : h('span', { className: 'ghu-tag' }, tt('plugin.noClient')),
                    ),
                  ),
                ),
        ),
        state.selectedDir
          ? h(
              'div',
              { className: 'ghu-section' },
              h('h3', null, tt('plugin.pick')),
              h(
                'table',
                { className: 'ghu-table' },
                h(
                  'tbody',
                  null,
                  h(
                    'tr',
                    null,
                    h('td', null, tt('plugin.dir')),
                    h('td', { style: { wordBreak: 'break-all' } }, state.selectedDir),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    /* ---------------- docs view ---------------- */

    function DocsView({ state, onDocs }) {
      const [tree, setTree] = useState(() => state.docs ?? null);
      const [streaming, setStreaming] = useState(false);
      const [raw, setRaw] = useState('');
      const [error, setError] = useState('');
      const [status, setStatus] = useState('');
      const [language, setLanguage] = useState(() => state.status?.docLanguage ?? '');
      const [savingLanguage, setSavingLanguage] = useState(false);
      const [languageNote, setLanguageNote] = useState('');
      const abortRef = useRef(null);
      const activeLocale = useActiveLocale();

      useEffect(() => {
        setTree(state.docs ?? null);
      }, [state.docs]);

      useEffect(() => {
        setLanguage(state.status?.docLanguage ?? '');
      }, [state.status?.docLanguage]);

      // "Follow the interface" resolves here, because the host has no way to
      // know the browser's language.
      const interfaceLanguage = docLanguageFrom(activeLocale);
      const effectiveLanguage = language === 'zh' || language === 'en' ? language : interfaceLanguage;

      async function chooseLanguage(value) {
        if (savingLanguage) return;
        setLanguage(value);
        setLanguageNote('');
        setSavingLanguage(true);
        try {
          await request('settings', { docLanguage: value });
        } catch (problem) {
          // The choice still governs this session; only remembering it failed.
          setLanguageNote(tt('docs.language.unsaved', { error: problem.message }));
        } finally {
          setSavingLanguage(false);
        }
      }

      const update = (patch) => {
        const next = { ...(tree ?? {}), ...patch };
        setTree(next);
        onDocs(next);
      };

      async function generate() {
        if (streaming) return;
        setError('');
        setStatus('');
        setRaw('');
        setStreaming(true);
        const controller = new AbortController();
        abortRef.current = controller;
        let buffer = '';
        try {
          await streamDocs(
            {
              pluginDir: state.selectedDir,
              pluginId: state.selectedId,
              language: effectiveLanguage,
            },
            {
              signal: controller.signal,
              onDelta: (text) => {
                buffer += text;
                // Show the tail of the stream so the user sees progress.
                setRaw(buffer.length > 6000 ? buffer.slice(-6000) : buffer);
              },
              onEvent: (event) => {
                if (event.type === 'start') {
                  setStatus(tt('docs.streaming'));
                } else if (event.type === 'done') {
                  const docs = event.docs ?? {};
                  setTree(docs);
                  onDocs(docs);
                  setStatus(tt('docs.done'));
                } else if (event.type === 'error') {
                  setError(event.error || event.code || tt('docs.failed'));
                  setStatus('');
                }
              },
            },
          );
        } catch (problem) {
          if (problem?.name === 'AbortError') setStatus(tt('docs.stopped'));
          else setError(problem.message);
        } finally {
          setStreaming(false);
          abortRef.current = null;
        }
      }

      function stop() {
        try {
          abortRef.current?.abort();
        } catch {
          // Nothing to abort.
        }
      }

      const model = state.status?.model;
      const modelLabel = model ? `${model.provider} / ${model.model}` : '—';
      const docs = tree ?? {};

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ghu-section' },
          h('h3', null, tt('docs.title')),
          h(
            'p',
            { className: 'ghu-note' },
            tt('docs.hint', { provider: model?.provider ?? '—', model: model?.model ?? '—' }),
          ),
          h(
            'div',
            { className: 'ghu-row', style: { marginTop: 8 } },
            h('span', { className: 'ghu-note', style: { margin: 0 } }, tt('docs.language')),
            h(Seg, {
              value: language === 'zh' || language === 'en' ? language : 'auto',
              options: [
                { value: 'auto', label: tt('docs.language.auto') },
                { value: 'zh', label: tt('docs.language.zh') },
                { value: 'en', label: tt('docs.language.en') },
              ],
              onChange: (value) => {
                chooseLanguage(value === 'auto' ? '' : value);
              },
            }),
            h(
              'span',
              { className: 'ghu-note', style: { margin: 0 } },
              languageNote ||
                (language === 'zh' || language === 'en'
                  ? tt('docs.language.saved', {
                      language: language === 'zh' ? tt('docs.language.zh') : tt('docs.language.en'),
                    })
                  : tt('docs.language.hint', {
                      current: interfaceLanguage === 'zh' ? tt('docs.language.zh') : tt('docs.language.en'),
                    })),
            ),
          ),
          !model
            ? h('div', { className: 'ghu-warn' }, tt('docs.noModel'))
            : h(
                'div',
                { className: 'ghu-row', style: { marginTop: 10 } },
                h(
                  'button',
                  {
                    className: 'ghu-btn primary',
                    type: 'button',
                    onClick: generate,
                    disabled: streaming || !state.selectedDir,
                  },
                  streaming
                    ? h('span', null, h('span', { className: 'ghu-spin', style: { marginRight: 6 } }), tt('docs.streaming'))
                    : docs.readme
                      ? tt('docs.regenerate')
                      : tt('docs.generate'),
                ),
                streaming
                  ? h('button', { className: 'ghu-btn ghost', type: 'button', onClick: stop }, tt('docs.stop'))
                  : null,
                h('span', { className: 'ghu-note', style: { margin: 0 } }, `model: ${modelLabel}`),
              ),
          error ? h('div', { className: 'ghu-error' }, error) : null,
          status ? h('div', { className: 'ghu-ok' }, status) : null,
          streaming && raw ? h('div', { className: 'ghu-stream' }, raw) : null,
        ),

        !docs.readme && !streaming
          ? h('div', { className: 'ghu-empty' }, tt('docs.missing'))
          : h(
              'div',
              { className: 'ghu-section' },
              h(
                Field,
                { label: tt('docs.description') },
                h('input', {
                  className: 'ghu-input grow',
                  type: 'text',
                  value: docs.description ?? '',
                  onChange: (event) => update({ description: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: tt('docs.readme') },
                h('textarea', {
                  className: 'ghu-textarea',
                  rows: 16,
                  value: docs.readme ?? '',
                  spellCheck: false,
                  onChange: (event) => update({ readme: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: tt('docs.detail') },
                h('textarea', {
                  className: 'ghu-textarea',
                  rows: 3,
                  value: docs.detail ?? '',
                  spellCheck: false,
                  onChange: (event) => update({ detail: event.target.value }),
                }),
              ),
              h(
                Field,
                { label: tt('docs.keywords') },
                h('input', {
                  className: 'ghu-input grow',
                  type: 'text',
                  value: (docs.keywords ?? []).join(', '),
                  onChange: (event) =>
                    update({
                      keywords: event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    }),
                }),
              ),
              h(
                Field,
                { label: tt('docs.tags') },
                h('input', {
                  className: 'ghu-input grow',
                  type: 'text',
                  value: (docs.tags ?? []).join(', '),
                  onChange: (event) =>
                    update({
                      tags: event.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    }),
                }),
              ),
            ),
      );
    }

    /* ---------------- publish view ---------------- */

    function PublishView({ state, onDocs }) {
      const [owner, setOwner] = useState(state.status?.login ?? '');
      const [name, setName] = useState(state.docs?.suggestedName ?? state.selectedId ?? '');
      const [isPrivate, setIsPrivate] = useState(state.status?.defaultPrivate !== false);
      const [includeSource, setIncludeSource] = useState(true);
      const [checking, setChecking] = useState(false);
      const [check, setCheck] = useState(null);
      const [choice, setChoice] = useState('overwrite');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [result, setResult] = useState(null);

      useEffect(() => {
        setOwner((current) => current || state.status?.login || '');
      }, [state.status?.login]);

      useEffect(() => {
        if (!state.docs?.suggestedName) return;
        setName((current) => (current ? current : state.docs.suggestedName));
      }, [state.docs?.suggestedName]);

      async function runCheck() {
        if (checking) return;
        setError('');
        setResult(null);
        setChecking(true);
        try {
          const found = await request('check', { owner, name });
          setCheck(found);
          // Default to overwriting only when the repository is the user's own.
          setChoice(found.existingRepo ? 'overwrite' : 'overwrite');
        } catch (problem) {
          setError(problem.message);
          setCheck(null);
        } finally {
          setChecking(false);
        }
      }

      async function publish() {
        if (busy) return;
        setError('');
        setBusy(true);
        setResult(null);
        try {
          if (check?.existingRepo && choice === 'skip') {
            setError('Skipped: a repository with this name already exists.');
            setBusy(false);
            return;
          }
          if (check?.existingRepo && choice === 'rename') {
            const base = `${name}-plugin`;
            const outcome = await request('check', { owner, name: base });
            if (outcome.existingRepo) {
              setError(`${base} also exists. Choose another name.`);
              setBusy(false);
              return;
            }
            setName(base);
            const published = await request('publish', {
              owner,
              name: base,
              private: isPrivate,
              includeSource,
              overwrite: false,
              description: state.docs?.description ?? '',
              generated: state.docs ?? {},
              pluginDir: state.selectedDir,
              pluginId: state.selectedId,
            });
            setResult(published);
            setBusy(false);
            return;
          }

          const published = await request('publish', {
            owner,
            name,
            private: isPrivate,
            includeSource,
            overwrite: choice === 'overwrite',
            description: state.docs?.description ?? '',
            generated: state.docs ?? {},
            pluginDir: state.selectedDir,
            pluginId: state.selectedId,
          });
          setResult(published);
        } catch (problem) {
          setError(problem.message);
        } finally {
          setBusy(false);
        }
      }

      const ready = Boolean(owner.trim()) && Boolean(name.trim());
      // A missing README is a warning rather than a blocker: the host falls
      // back to a manifest-derived README so a publish never dead-ends here.
      const docsMissing = !state.docs?.readme;

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ghu-section' },
          h('h3', null, tt('publish.title')),
          h(
            Field,
            { label: tt('publish.owner') },
            h('input', {
              className: 'ghu-input grow',
              type: 'text',
              value: owner,
              spellCheck: false,
              onChange: (event) => setOwner(event.target.value),
            }),
          ),
          h(
            Field,
            { label: tt('publish.name') },
            h('input', {
              className: 'ghu-input grow',
              type: 'text',
              value: name,
              spellCheck: false,
              onChange: (event) => setName(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'ghu-row', style: { marginBottom: 10 } },
            h(
              'label',
              { className: 'ghu-row', style: { gap: 6, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: isPrivate, onChange: (event) => setIsPrivate(event.target.checked) }),
              h('span', null, tt('publish.private')),
            ),
            h(
              'label',
              { className: 'ghu-row', style: { gap: 6, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: includeSource,
                onChange: (event) => setIncludeSource(event.target.checked),
              }),
              h('span', null, tt('publish.includeSource')),
            ),
          ),
          h(
            'div',
            { className: 'ghu-row' },
            h(
              'button',
              {
                className: 'ghu-btn',
                type: 'button',
                onClick: runCheck,
                disabled: checking || !ready,
              },
              checking ? h('span', null, h('span', { className: 'ghu-spin', style: { marginRight: 6 } }), tt('publish.checking')) : tt('publish.check'),
            ),
          ),

          check
            ? check.verdict === 'free'
              ? h('div', { className: 'ghu-ok' }, tt('publish.verdict.free'))
              : check.verdict === 'exists'
                ? h(
                    'div',
                    { className: 'ghu-warn' },
                    tt('publish.verdict.exists', {
                      repo: check.existingRepo?.fullName ?? `${owner}/${name}`,
                      branch: check.existingRepo?.defaultBranch ?? 'main',
                    }),
                    h('p', { style: { margin: '8px 0 0' } }, tt('publish.conflict')),
                    h(
                      Seg,
                      {
                        value: choice,
                        onChange: setChoice,
                        options: [
                          { value: 'overwrite', label: tt('publish.overwrite') },
                          { value: 'rename', label: tt('publish.rename') },
                          { value: 'skip', label: tt('publish.skip') },
                        ],
                      },
                    ),
                  )
                : h(
                    'div',
                    { className: 'ghu-warn' },
                    tt('publish.verdict.name-taken-elsewhere', {
                      names: (check.sameName ?? []).map((hit) => hit.fullName).join(', '),
                    }),
                  )
            : null,

          docsMissing ? h('div', { className: 'ghu-warn' }, tt('publish.needDocs')) : null,
          error ? h('div', { className: 'ghu-error' }, error) : null,

          h(
            'div',
            { className: 'ghu-row', style: { marginTop: 10 } },
            h(
              'button',
              {
                className: 'ghu-btn primary',
                type: 'button',
                onClick: publish,
                disabled: busy || !ready || (check?.existingRepo && choice === 'skip'),
              },
              busy ? h('span', null, h('span', { className: 'ghu-spin', style: { marginRight: 6 } }), tt('publish.working')) : tt('publish.go'),
            ),
          ),
        ),

        result
          ? h(
              'div',
              { className: 'ghu-section' },
              h('h3', null, tt('publish.done')),
              h(
                'table',
                { className: 'ghu-table' },
                h(
                  'tbody',
                  null,
                  h('tr', null, h('td', null, tt('publish.repo')), h('td', null, result.repo?.fullName ?? '')),
                  h('tr', null, h('td', null, tt('publish.branch')), h('td', null, result.commit?.branch ?? '')),
                  h(
                    'tr',
                    null,
                    h('td', null, tt('publish.commit')),
                    h('td', { style: { wordBreak: 'break-all' } }, (result.commit?.commitSha ?? '').slice(0, 12)),
                  ),
                  h('tr', null, h('td', null, tt('publish.files')), h('td', null, String(result.commit?.fileCount ?? 0))),
                ),
              ),
              // Push protection would reject the whole commit over these, so
              // the scan holds them back and the panel names them.
              Array.isArray(result.heldBack) && result.heldBack.length > 0
                ? h(
                    'div',
                    { className: 'ghu-note warn' },
                    tt('publish.heldBack', { count: result.heldBack.length }),
                    h(
                      'ul',
                      { style: { margin: '6px 0 0', paddingLeft: 18 } },
                      result.heldBack.map((item) => h('li', null, `${item.path} — ${item.reason}`)),
                    ),
                  )
                : null,
              result.repo?.htmlUrl
                ? h(
                    'a',
                    {
                      className: 'ghu-btn primary',
                      href: result.repo.htmlUrl,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      style: { textDecoration: 'none', display: 'inline-block', marginTop: 6 },
                    },
                    tt('publish.open'),
                  )
                : null,
            )
          : null,
      );
    }

    /* ---------------- panel ---------------- */

    function Panel({ onClose }) {
      const [tab, setTab] = useState('account');
      const [status, setStatus] = useState(null);
      const [plugins, setPlugins] = useState([]);
      const [pluginsLoading, setPluginsLoading] = useState(false);
      const [selectedDir, setSelectedDir] = useState('');
      const [selectedId, setSelectedId] = useState('');
      const [docs, setDocs] = useState(null);
      const [error, setError] = useState('');

      const refreshStatus = useCallback(async () => {
        try {
          const next = await request('status');
          setStatus(next);
          setError('');
        } catch (problem) {
          setError(problem.message);
        }
      }, []);

      const loadPlugins = useCallback(async () => {
        setPluginsLoading(true);
        try {
          const listed = await request('plugins');
          const next = Array.isArray(listed.plugins) ? listed.plugins : [];
          setPlugins(next);
          setSelectedDir((current) => current || next[0]?.dir || '');
          setSelectedId((current) => current || next[0]?.id || '');
        } catch (problem) {
          setError(problem.message);
        } finally {
          setPluginsLoading(false);
        }
      }, []);

      useEffect(() => {
        refreshStatus();
        loadPlugins();
      }, [refreshStatus, loadPlugins]);

      // The client is the last line of defence for the client id field: an
      // older host build echoed whatever was stored there, and that value can
      // be a token that a user pasted into the wrong box. Only render a value
      // that looks like a public OAuth App client id.
      const looksLikeClientId = (value) => /^[A-Za-z0-9._-]{8,64}$/.test(value) && !/^(gh[pousr]_|github_pat_)/.test(value);
      const rawClientId = typeof status?.clientId === 'string' ? status.clientId : '';
      const settings = status ? { clientId: looksLikeClientId(rawClientId) ? rawClientId : '' } : null;
      const state = {
        status,
        settings,
        plugins,
        pluginsLoading,
        selectedDir,
        selectedId,
        docs,
        reloadPlugins: loadPlugins,
      };

      return h(
        'div',
        { className: 'ghu-root', 'data-plugin': NS },
        h(
          'div',
          { className: 'ghu-head' },
          h('h1', null, tt('panel.title')),
          h('div', { className: 'ghu-spacer' }),
          h(
            'span',
            { className: 'ghu-chip' },
            h('span', { className: status?.connected ? 'ghu-dot on' : 'ghu-dot off' }),
            status?.connected ? status.login : tt('account.signedOut'),
          ),
          h(
            'button',
            { className: 'ghu-btn sm', type: 'button', onClick: refreshStatus },
            tt('panel.refresh'),
          ),
          h(
            'button',
            { className: 'ghu-icon-btn', type: 'button', onClick: onClose, title: tt('panel.close') },
            h(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
              h('path', { d: 'M6 6l12 12M18 6 6 18' }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ghu-tabs' },
          ['account', 'plugin', 'docs', 'publish'].map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: tab === key ? 'ghu-tab on' : 'ghu-tab',
                onClick: () => setTab(key),
              },
              tt(`tab.${key}`),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ghu-body' },
          error ? h('div', { className: 'ghu-error' }, error) : null,
          status === null && !error ? h('div', { className: 'ghu-empty' }, tt('common.loading')) : null,
          tab === 'account'
            ? h(AccountView, {
                state,
                onChanged: () => {
                  refreshStatus();
                  loadPlugins();
                },
              })
            : null,
          tab === 'plugin'
            ? h(PluginView, {
                state,
                onPick: (plugin) => {
                  setSelectedDir(plugin.dir);
                  setSelectedId(plugin.id);
                },
              })
            : null,
          tab === 'docs' ? h(DocsView, { state, onDocs: setDocs }) : null,
          tab === 'publish' ? h(PublishView, { state, onDocs: setDocs }) : null,
        ),
      );
    }

    /* ---------------- plugin entry ---------------- */

    function apply(ctx) {
      mountCss();
      appCtx = ctx;

      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en });
        } catch {
          return () => {};
        }
      }, 'github-upload: dictionaries');

      try {
        translate = ctx.locale.bind(NS);
      } catch {
        translate = (key) => key;
      }

      const closePanel = () => {
        try {
          ctx.get?.('layout', false)?.selectPanel?.(null);
        } catch {
          // Layout may not be mounted.
        }
      };

      ctx.effect(() => {
        const disposers = [];
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: ORDER, label: () => tt('entry.label'), locale: NS },
              (props) => h(PanelIcon, { size: props?.size, active: props?.active === true }),
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              () => h(Panel, { onClose: closePanel }),
            ),
          ),
        );
        return () => {
          for (const dispose of disposers.splice(0)) dispose();
        };
      }, 'github-upload: panel');
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply,
      __views: { Panel, PanelIcon, AccountView, PluginView, DocsView, PublishView, Field, Avatar, Seg },
      __api: { request, streamDocs },
    };
  },
});
