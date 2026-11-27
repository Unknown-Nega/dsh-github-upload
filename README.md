# GitHub Upload

Publish a DeepSeek Harness plugin to GitHub from inside the Harness: sign in once, pick a plugin from your profile, let your current model write the documentation, then push the whole thing into a new repository.

Open it from the **GitHub Upload** icon in the left rail.

## What it does

The panel has four tabs that follow the order of a real publish.

1. **Account** — sign in with GitHub, either way:
   - **Device code (OAuth)**: paste an OAuth App's client ID once, the panel shows a code like `ABCD-1234` and a link, you approve it in the browser, and the panel picks the token up on its own.
   - **Personal access token**: paste a fine-grained or classic token with `repo` scope.

   Either way the token is checked with `GET /user` and the account name, avatar, plan and scopes are cached for the session.

   Under the status table the panel shows the token type and a **Check permissions** button. It asks GitHub what this token can actually do — how many repositories it can see and whether it can create one — so a token that signs in fine but cannot create repositories is reported here instead of failing at the last step of a publish.
2. **Plugin** — the panel lists the plugins in your current Harness profile, including `link:` installs, plus anything sitting in `~/.dsh/plugins`. Pick the one you want to publish.
3. **Docs** — **Generate** sends the plugin's `package.json`, its entry module, its client module when there is one, its `cordis.patch.yml` and its locale files to the model you are already using in this Harness, and streams back a description, a `README.md`, a one-image `docs/DETAIL.md`, keywords and a repository name. Every field stays editable; the stream has a stop button. The **Description language** switch above the button picks Chinese or English and defaults to **Follow the interface**, so the docs come back in the language the panel is speaking; an explicit choice is remembered.
4. **Publish** — the panel first asks GitHub whether a repository of that name already exists and whether a plugin of that name is published anywhere. You then choose to overwrite, rename, or stop. Pushing commits everything in one commit and prints the repository link.

## How the upload is put together

Files come from the plugin directory with junk and secrets filtered out: `node_modules`, `.git`, build output, `.env`, `.npmrc`, `.netrc`, private keys and anything over 512 KiB are skipped. The documented files you approved are layered on top, and `package.json` is written last so the description GitHub shows matches what you accepted.

Everything lands in a single commit through the Git Data API (`git/trees` → `git/commits` → ref update), so an upload either appears completely or not at all.

## Where your token lives

The token is stored as a Harness **credential record** under the key `dsh-github-upload/github` (`<scope>/<id>`, the only shape the credentials service accepts), never in the profile's `cordis.patch.yml` and never in a repository. When the credentials service is unavailable the plugin falls back to `~/.dsh/github-upload/github.json` with mode `0600`.

Every route the panel talks to is served under `/api/dsh-github-upload/*`, bound to loopback only, and **Disconnect** deletes the record.

## The only thing that leaves your machine

Publishing. Signing in talks to `github.com`. Generating documentation sends the source files listed under **Docs** to the model provider your Harness is configured with — that call goes through the Harness's own `llm` service with the model you have selected, no other endpoint. Nothing is uploaded anywhere until you press **Publish**.

## Requirements

- A DeepSeek Harness build with the `webServer` service (the desktop and web builds both have it).
- For device-code login: an OAuth App with device flow enabled, and its client ID.
- For token login: a fine-grained token with **Administration: Read and write** (or the newer **Repository creation: Read and write**) under Repository permissions, and the target repository — or **All repositories** — selected under Repository access; a classic token needs the `repo` scope. Add `read:user` for the profile card.

## Limits

- One repository per publish; there is no branching strategy beyond the target repository's default branch.
- The file list is capped at 200 files and the description at 350 characters.
- Overwriting replaces the file set you upload, but does not delete files that exist only in the repository.
- The **Generate** button is capped by the model's own output limit. A README that runs past it comes back as an error rather than a half-written file.

## Notes

- The **OAuth App client ID** field only accepts a public client id. Pasting a token there is refused, because that field is written to a plain settings file and echoed back by the status route.
- A `403 Resource not accessible by personal access token` is a permission problem the token itself has to fix: the panel names the permission GitHub asked for (from `x-accepted-github-permissions`) and turns the fine-grained and classic cases into different instructions. This is why **Check permissions** exists: `GET /user` succeeding does not mean a token may create a repository.
- Before publishing, every file's content is scanned: token-shaped strings (GitHub PATs, private-key headers, AWS/Slack/Stripe/Google/npm/OpenAI keys) are held back and the result names them. GitHub's push protection rejects the entire commit over one such file while saying only "Secret detected in content", with no file name — this scan is what puts the name in front of you. A regex written in prose, such as `/ghp_[A-Za-z0-9]+/`, is not a hit.
- The panel chooses its own colours instead of inheriting `--dsw-alias-*` background tokens, so it stays readable under wallpaper and glass themes that make the host surfaces transparent.

