# GitHub 上传

在 Harness 里直接把插件发布到 GitHub：登录一次，从 profile 里选一个插件，让你正在用的模型写好说明，然后推到一个新仓库里。

从左栏的 **GitHub 上传** 图标打开。

## 它做什么

面板分四个页签，顺序就是一次真实发布的顺序。

1. **账号** —— 两种方式登录 GitHub：
   - **设备码（OAuth）**：填一次 OAuth App 的 client ID，面板给出形如 `ABCD-1234` 的码和一个链接，你在浏览器里授权，面板自己去取 token。
   - **个人访问令牌**：粘贴一个带 `repo` 权限的细粒度或经典令牌。

   登录后都会用 `GET /user` 校验一次，并把账号名、头像、套餐和权限范围缓存下来。

   状态表下方还会显示令牌类型，并提供「检查权限」按钮：它会直接问 GitHub，这个令牌能看到多少仓库、能不能新建仓库——所以「能登录但建不了仓库」的令牌会在这里被指出，而不是等到发布最后一步才失败。
2. **插件** —— 列出当前 profile 里的插件（包括 `link:` 装进来的），以及 `~/.dsh/plugins` 下的现有的插件目录。选一个。
3. **说明** —— 点「生成说明」会把插件的 `package.json`、入口模块、客户端模块（如果有）、`cordis.patch.yml` 和语言包发给你当前正在用的模型，流式返回描述、`README.md`、只含一张图的 `docs/DETAIL.md`、关键词和仓库名建议。每个字段都可以改，流可以随时停止。按钮上方的**说明语言**可以选中文或 English，默认「跟随界面」，也就是面板用什么语言，生成的说明就用什么语言；一旦手动选过就会记住。
4. **发布** —— 先问 GitHub：同名仓库在不在、同名插件有没有人发过。然后你选覆盖、改名还是停下。推送用一次提交完成，结束后给出仓库链接。

## 上传是怎么组织的

文件从插件目录读取，并过滤掉杂项和密钥：`node_modules`、`.git`、构建产物、`.env`、`.npmrc`、`.netrc`、私钥以及超过 512 KiB 的文件都会被跳过。你确认过的文档叠在上面，`package.json` 最后写入，保证 GitHub 上显示的描述和你确认的一致。

所有文件通过 Git Data API（`git/trees` → `git/commits` → 更新 ref）一次提交，要么完整出现，要么完全不出现。

## 你的 token 存在哪

token 存成 Harness 的**凭据记录**，key 是 `dsh-github-upload/github`（`<scope>/<id>`，凭据服务唯一接受的形状），既不写进 profile 的 `cordis.patch.yml`，也不会进仓库。凭据服务不可用时回退到 `~/.dsh/github-upload/github.json`，权限 `0600`。

面板访问的所有路由都在 `/api/dsh-github-upload/*` 下，只绑定回环地址；点「断开连接」会删除这条记录。

## 唯一会离开本机的事

发布。登录只跟 `github.com` 通信；生成说明时，上面列出的源码文件会发给你 Harness 配置的模型服务（走 Harness 自己的 `llm` 服务和你选定的模型，没有别的端点）。在你按下「发布」之前，什么都不会上传。

## 要求

- 带有 `webServer` 服务的 DeepSeek Harness（桌面版与网页版都有）。
- 设备码登录需要：一个启用了设备码流程的 OAuth App，以及它的 client ID。
- 令牌登录需要：细粒度令牌要在 Repository permissions 里勾上 **Administration: Read and write**（新界面里是 **Repository creation: Read and write**），并在 Repository access 里选中目标仓库或 **All repositories**；经典令牌需要 `repo` 权限。账号卡片另外需要 `read:user`。

## 限制

- 一次发布对应一个仓库；分支策略只会用目标仓库的默认分支。
- 文件数量上限 200，描述上限 350 字符。
- 覆盖只替换你这次上传的文件集合，不会删除只存在于仓库里的文件。
- 「生成说明」受模型自身输出上限约束。README 超出上限会报错，而不是写回半截内容。

## 说明

- **OAuth App Client ID** 只接受公开的 client id。往里粘贴令牌会被拒绝——该字段会写进明文设置文件，并由 status 路由回显。
- `403 Resource not accessible by personal access token` 只能由令牌自己修好：面板会把 GitHub 要求的权限（来自 `x-accepted-github-permissions` 响应头）列出来，并对细粒度令牌和经典令牌给出不同改法。这正是「检查权限」按钮存在的理由：`GET /user` 能过，不等于这个令牌能新建仓库。
- 发布前会扫描每个文件的内容：形如令牌的字符串（GitHub PAT、私钥头、AWS/Slack/Stripe/Google/npm/OpenAI 密钥）会被扣下不上传，并在结果里列出被扣的文件。GitHub 的推送保护（push protection）会因为一个文件拒收整个提交，而错误信息只说「Secret detected in content」，不告诉你是哪个文件——这一步就是为了把文件名摆到你面前。文档里提到的正则写法（例如 `/ghp_[A-Za-z0-9]+/`）不算命中。
- 面板自带配色，不继承 `--dsw-alias-*` 背景令牌，因此在把宿主表面置为透明的壁纸/玻璃主题下仍然可读。

