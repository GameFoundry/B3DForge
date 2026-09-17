# Deploying BansheeForge

BansheeForge ships with username/password authentication and bearer-token agent
authentication, but it does **not** ship its own TLS termination. The intended
production posture is:

- BansheeForge listens on `127.0.0.1:3003` (not exposed to the internet directly).
- A reverse proxy (Caddy is recommended) handles HTTPS and forwards traffic to it.
- Cookies are issued with `Secure` so they only travel over HTTPS.

This guide covers first-run user setup, the Caddy reverse proxy, running the
server as a service, and managing agent tokens.

> **Already running locally with pm2?** Skip to the [Local pm2 upgrade](#local-pm2-upgrade) section.

## <a id="local-pm2-upgrade"></a>0. Local pm2 upgrade (existing local install)

If you already run BansheeForge locally under pm2 (with `rebuild.sh`):

```bash
cd Framework/Tools/BansheeForge

# Install dependencies
pnpm install

# Build all packages, provision a local agent token if missing, and
# start/reload both pm2 apps (banshee-forge + banshee-forge-agent).
./rebuild.sh

# Create your first user if you don't have one yet
./bsf-cli.sh user add admin
```

Then open `http://localhost:3003` and sign in.

`rebuild.sh` is now idempotent — running it on a fresh machine sets everything
up in one shot, and running it after pulling new code rebuilds the dist files
and triggers a graceful pm2 reload.

### What this manages

`pm2.config.cjs` defines two pm2 apps:

| pm2 name | What it runs | Notes |
| --- | --- | --- |
| `banshee-forge`       | `packages/server/dist/index.js` | The orchestrator (web UI + REST + Socket.IO). |
| `banshee-forge-agent` | `packages/agent/dist/index.js`  | A local build agent talking to `127.0.0.1:3003`. |

The agent's bearer token is stored in `.agent-token` at the repository root.
That file is created on first `./rebuild.sh` (via `bsf-cli.sh agent-token
create local`) and is git-ignored. To rotate it, revoke the old one with
`./bsf-cli.sh agent-token revoke <id>`, delete `.agent-token`, and run
`./rebuild.sh` again.

### Common operations

```bash
# Tail logs
pm2 logs banshee-forge
pm2 logs banshee-forge-agent

# Restart just one app
pm2 restart banshee-forge-agent

# Stop everything
pm2 stop pm2.config.cjs
```

**Behavior change to know about**: the server now binds to `127.0.0.1` by
default instead of `0.0.0.0`. If you previously hit BansheeForge from another
device on your LAN, edit `config.json` to override:

```json
{
	"dataPath": "D:\\BansheeForgeData",
	"port": 3003,
	"bindHost": "0.0.0.0"
}
```

then `./rebuild.sh` again. For LAN-only HTTP use leave `cookieSecure` unset
(defaults to `false` so cookies work over plain HTTP). Only flip `cookieSecure`
to `true` once you put HTTPS in front.

The CLI is also accessible as `pnpm cli ...` from the repo root, e.g.
`pnpm cli user list`.

## macOS build agent

The macOS agent runs as a launchd *user* agent inside your GUI session (Metal needs a window
server session) and reports itself **unavailable while another user owns the screen**. Builds
for `darwin` queued while the machine is asleep or in use simply wait on the server until the
agent reconnects and becomes available, so it is fine to trigger them at any time.

Prerequisites (Homebrew):

```bash
brew install node bash cmake ninja
```

Homebrew bash is required: the system bash 3.2 cannot run the CI test script (associative
arrays). The agent prefers `/opt/homebrew/bin/bash` automatically.

Install:

```bash
# On the server: create a token for the agent machine
./bsf-cli.sh agent-token create macbook

# On the agent machine, from a checkout with `pnpm install && pnpm build` done:
cd Framework/Tools/BansheeForge
./packages/agent/macos/install-macos-agent.sh https://forge.example.com bsf_agt_... macbook
```

This writes `~/.bansheeforge-agent/agent.json`, installs
`~/Library/LaunchAgents/com.bansheeforge.agent.plist`, and starts the agent. Logs go to
`~/.bansheeforge-agent/agent.log`. Re-run the script after rebuilding or changing the config.

Behaviour to know about:

- The agent services the `darwin` platform by default (`BSF_AGENT_PLATFORMS` / `"platforms"` in
  `agent.json` override this; a Windows agent that also builds PS5 sets `win32,ps5`).
- While a build runs the agent holds a `caffeinate -s -i` assertion, so closing the lid on AC
  power does not interrupt it. On battery the OS may still sleep.
- With the lid closed and no build running the laptop sleeps and the agent disconnects. The
  Agents page lists it under *Offline agents* and its platform stays selectable in Trigger Build.
- Enable auto-login for the agent's user so the agent comes back after a reboot.

## 1. First-run user setup

After installing dependencies and building (`pnpm install && pnpm build`), the
server has no users yet. Create the first admin account using the CLI:

```bash
./bsf-cli.sh user add admin
```

You'll be prompted for a password (minimum 8 characters). The user record is
written to `{dataPath}/auth/users.json` with the password stored as a bcrypt hash.

Other CLI commands:

```bash
./bsf-cli.sh user passwd admin       # change a user's password
./bsf-cli.sh user remove alice       # remove a user
./bsf-cli.sh user list               # list users
```

`./bsf-cli.sh` is a thin wrapper around `node packages/server/dist/cli.js`. From
the repo root you can also invoke it as `pnpm cli ...` — e.g. `pnpm cli user list`.

The CLI talks to the same JSON files the server reads, so it works whether the
server is running or stopped.

## 2. Server configuration

Configuration is loaded from environment variables, then `config.json` at the
repository root, then defaults. Defaults are:

| Field          | Default       | Notes                                                           |
| -------------- | ------------- | --------------------------------------------------------------- |
| `dataPath`     | `./data`      | Where projects, builds, users, sessions, agent tokens live      |
| `port`         | `3003`        | TCP port the HTTP server listens on                             |
| `bindHost`     | `127.0.0.1`   | Network interface to bind. Keep at `127.0.0.1` behind a proxy   |
| `cookieSecure` | `false`       | Set to `true` once you're behind HTTPS (Caddy)                  |

The corresponding env vars are `DATA_PATH`, `PORT`, `BIND_HOST`, `COOKIE_SECURE`.

Example `config.json` for production behind Caddy:

```json
{
	"dataPath": "/var/lib/bansheeforge",
	"port": 3003,
	"bindHost": "127.0.0.1",
	"cookieSecure": true
}
```

## 3. Reverse proxy with Caddy

Caddy provisions and renews Let's Encrypt certificates automatically.

Install Caddy (https://caddyserver.com/docs/install), then create a `Caddyfile`:

```
forge.example.com {
	reverse_proxy 127.0.0.1:3003

	# Optional hardening
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
}
```

Replace `forge.example.com` with your real DNS name. Make sure that name resolves
to the machine and that ports 80/443 are reachable so Caddy can complete the
ACME challenge.

Start Caddy:

```bash
sudo caddy run --config /etc/caddy/Caddyfile
```

(or `caddy reload` if it's already running). Once HTTPS is live, set
`cookieSecure: true` in `config.json` and restart BansheeForge so session cookies
are issued with the `Secure` flag.

## 4. Running BansheeForge as a service

### Linux (systemd)

Create `/etc/systemd/system/bansheeforge.service`:

```
[Unit]
Description=BansheeForge CI server
After=network.target

[Service]
Type=simple
User=bansheeforge
WorkingDirectory=/opt/bansheeforge
ExecStart=/usr/bin/node /opt/bansheeforge/packages/server/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bansheeforge
sudo journalctl -u bansheeforge -f
```

### Windows (NSSM)

```cmd
nssm install BansheeForge "C:\Program Files\nodejs\node.exe" ^
	"D:\BansheeForge\packages\server\dist\index.js"
nssm set BansheeForge AppDirectory "D:\BansheeForge"
nssm start BansheeForge
```

## 5. Agent tokens

Build agents authenticate to the server with a bearer token instead of a session
cookie. Provision one on the orchestrator host:

```bash
./bsf-cli.sh agent-token create my-build-machine
```

The plaintext token is shown **once** and never again — store it somewhere safe.
Only its bcrypt hash is persisted on disk.

Manage tokens:

```bash
./bsf-cli.sh agent-token list
./bsf-cli.sh agent-token revoke <id>
```

You can also do all three from the web UI under Settings → Agent Tokens.

Revoking a token immediately invalidates it; the next request with that token
gets a 401, and any open agent socket using it is dropped on the next
authenticated operation.

## <a id="remote-agent"></a>6. Remote build agents

A build agent is a standalone Node.js process that connects out to the
orchestrator over Socket.IO, advertises its platform/labels/capacity, and runs
build jobs locally. Agents can run on any machine that can reach the
orchestrator's HTTP/WebSocket port — different OS, different network, different
provider — as long as outbound HTTPS works.

The orchestrator picks an agent for each build based on the `platform` and
`requiredLabels` declared on the configuration (see Configuration UI in the web
app).

### What the agent machine needs

- **Node.js 20+**.
- **git** (the agent runs `git` directly to capture submodule commits).
- **bash**:
  - On Linux/macOS: usually already present at `/bin/bash`.
  - On Windows: install [Git for Windows](https://git-scm.com/download/win) so
    Git Bash is available at `C:\Program Files\Git\bin\bash.exe`. (The agent
    auto-detects it; override with `BSF_AGENT_BASH_PATH` if needed.)
- **Network reachability** to the orchestrator URL on its HTTP/WebSocket port.
  If the orchestrator is behind Caddy/HTTPS, the agent uses `wss://` automatically.
- **Whatever your build needs** — compilers, SDKs, CMake, etc. The agent just
  runs your `fetch.sh` / `build.sh` / `test.sh` scripts; the toolchain is your
  responsibility.

### Step 1 — provision a token

On the orchestrator host:

```bash
./bsf-cli.sh agent-token create gpu-builder-01
# Copy the printed bsf_agt_... value — you'll need it on the agent host.
```

### Step 2 — get the agent code on the remote machine

The simplest path is to clone the BansheeForge sub-tree and build the agent
package. From the agent host:

```bash
git clone <your-banshee-fork-url> banshee
cd banshee/Framework/Tools/BansheeForge
pnpm install
pnpm --filter @banshee-forge/shared --filter @banshee-forge/agent build
```

This produces `packages/agent/dist/index.js`. (If you'd rather not clone the
full engine on every agent host, you can `pnpm pack` the `agent` and `shared`
packages locally and copy the tarballs.)

### Step 3 — create an `agent.json`

Either set environment variables or drop an `agent.json` next to the binary.
The two are equivalent; env vars win on conflict.

```json
{
	"orchestratorUrl": "https://forge.example.com",
	"token": "bsf_agt_…",
	"name": "gpu-builder-01",
	"labels": ["gpu-nvidia"],
	"maxParallelBuilds": 2
}
```

Equivalent env vars:

| Env var                         | Purpose                                                         |
| ------------------------------- | --------------------------------------------------------------- |
| `BSF_ORCHESTRATOR_URL`          | Base URL of the orchestrator, e.g. `https://forge.example.com`  |
| `BSF_AGENT_TOKEN`               | Bearer token from `bsf-cli.sh agent-token create`               |
| `BSF_AGENT_NAME`                | Human-readable name shown in the web UI                         |
| `BSF_AGENT_LABELS`              | Comma-separated labels, e.g. `gpu-nvidia,high-mem`              |
| `BSF_AGENT_MAX_PARALLEL`        | How many builds this agent runs in parallel (default 1)         |
| `BSF_AGENT_WORKSPACE_ROOT`      | Where per-config build workspaces live (default `~/.bansheeforge-agent/workspaces`) |
| `BSF_AGENT_SCRIPTS_ROOT`        | Where transient script bodies are written (default `~/.bansheeforge-agent/scripts`) |
| `BSF_AGENT_TIMEOUT_MS`          | Default per-build timeout (default 1 hour)                      |
| `BSF_AGENT_CONFIG`              | Explicit path to the `agent.json` file                          |

### Step 4 — run the agent

Quick sanity check:

```bash
# Linux/macOS
BSF_ORCHESTRATOR_URL=https://forge.example.com \
BSF_AGENT_TOKEN=bsf_agt_… \
BSF_AGENT_NAME=gpu-builder-01 \
BSF_AGENT_LABELS=gpu-nvidia \
node packages/agent/dist/index.js
```

You should see `Connected to orchestrator` then `Registered (agentId=…)`. The
agent will appear under **Agents** in the web UI.

### Step 5 — keep it alive in production

Pick whichever supervisor matches the agent host:

#### Linux (systemd)

`/etc/systemd/system/bansheeforge-agent.service`:

```
[Unit]
Description=BansheeForge build agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bansheeforge
WorkingDirectory=/opt/bansheeforge
EnvironmentFile=/etc/bansheeforge-agent.env
ExecStart=/usr/bin/node /opt/bansheeforge/packages/agent/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/bansheeforge-agent.env` (mode `0600`, owned by the service user):

```
BSF_ORCHESTRATOR_URL=https://forge.example.com
BSF_AGENT_TOKEN=bsf_agt_…
BSF_AGENT_NAME=gpu-builder-01
BSF_AGENT_LABELS=gpu-nvidia
BSF_AGENT_MAX_PARALLEL=2
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bansheeforge-agent
sudo journalctl -u bansheeforge-agent -f
```

#### Windows (NSSM or pm2)

NSSM:

```cmd
nssm install BansheeForgeAgent "C:\Program Files\nodejs\node.exe" ^
	"D:\BansheeForge\packages\agent\dist\index.js"
nssm set BansheeForgeAgent AppDirectory "D:\BansheeForge"
nssm set BansheeForgeAgent AppEnvironmentExtra ^
	BSF_ORCHESTRATOR_URL=https://forge.example.com ^
	BSF_AGENT_TOKEN=bsf_agt_… ^
	BSF_AGENT_NAME=win-builder-01
nssm start BansheeForgeAgent
```

pm2:

```bash
pm2 start packages/agent/dist/index.js \
	--name bansheeforge-agent \
	--env BSF_ORCHESTRATOR_URL=https://forge.example.com \
	--env BSF_AGENT_TOKEN=bsf_agt_…
pm2 save
```

### Operational notes

- **Reconnection**: agents reconnect automatically (exponential backoff up to
  ~30 s). If the orchestrator restarts, the agent re-registers on its own.
- **Mid-build disconnect**: if the agent loses the connection while a build is
  running, the orchestrator marks that build `failed` with the message "Agent
  disconnected mid-build". The build is not retried — re-trigger it manually.
- **Firewalls**: the agent only opens an outbound TCP connection to the
  orchestrator. No inbound port is required on the agent host.
- **TLS**: `https://` URLs use `wss://` for the WebSocket leg; the cert is
  validated by Node's defaults. If you're behind a private CA, set
  `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the agent's environment.
- **Artifacts stay on the agent's disk** — the install tree and the
  dependency archives a build packaged wait under `{buildsRoot}/{buildId}/`
  until a deployment asks for them (see section 7). Test results are uploaded
  at the end of every build. The Agents page can purge artifacts; builds a
  pending deployment still needs are skipped, and a purged build can no longer
  be deployed (re-run it instead).

## 7. Branches, pins and deployments

Builds come from the project's build branch (or a configuration's override,
or the branch typed into Trigger Build). The root commit of that branch
defines the whole tree: every submodule, recursively, is built at the commit
its parent pins. Submodules never follow a branch of their own. A
**deployment** transfers the files a successful, fully tested build left in
its deploy directory to the server, runs the build's own `deploy.sh` there,
and optionally promotes the tested commits to a target branch.

Nothing about `staging` is hardcoded. Where the branches live:

| Setting | Where |
| --- | --- |
| Build branch (project default) | Project page → Repository → *Build Branch* (edit) |
| Build branch per configuration | Project page → Configurations → *Branch* override |
| Build branch for one run | Trigger Build → *Branch* |
| Default deploy target (blank = none) | Project page → Repository → *Default Deploy Branch* |
| Deploy target for one deployment | Build → Deploy tab → *Target branch* |
| Branches polled for changes | Project page → Automation → watched repositories |

### Submodule pins

Pressing **Trigger Build** first compares every submodule pin of the branch
head with the head of the submodule's branch (the build branch when the
submodule's remote has it, else the branch its `.gitmodules` entry names;
a submodule with neither is not checked). Stale pins are listed with two
choices:

- **Update pins and build** — the server writes a pin commit per affected
  repository, children first (Framework pins its submodules, then the editor
  pins Framework), pushes each with a plain push, and builds the new root
  head. A push the remote rejects means someone pushed meanwhile: nothing
  else is pushed, the list is refreshed, and you decide again. Nothing is
  ever force-pushed.
- **Build as pinned** — builds the tree exactly as the root commit pins it.

Polled builds always build the pins as-is; nothing updates pins on its own.
A build for an explicitly typed commit can only be built as pinned.

### One-time repository setup

Every repository in the tree (editor, framework, examples, code generator,
forge, doc generator, platform overlays) needs the build branch (`staging`)
on its remote. The script creates the missing ones from the deploy branch:

```bash
# Dry run first: lists the repositories and what would change
Framework/Scripts/B3DSetupStaging.sh --dry-run

# Create remote staging branches (from master) and local tracking branches
Framework/Scripts/B3DSetupStaging.sh --checkout
```

Developers push to `staging`; the orchestrator moves `master`.

### Move an existing project to the staging layout

All of it is done from the project page:

1. **Configurations → Repository**: set *Build Branch* to `staging` and
   *Default Deploy Branch* to `master` (or change the branch override of the
   configuration you build instead).
2. **Automation**: point each watched repository at `staging` so polling
   triggers on pushes to it.
3. **Configurations → Project Fetch Script**: paste the current
   `Framework/Scripts/CI/B3DCIFetch.sh` and **Save**. A stored script that
   moves submodules to branch heads must be replaced: the orchestrator fails
   any build whose root is not the commit it asked for, and a build of
   unpinned submodules cannot be promoted faithfully.
4. **Configurations → edit → Deploy parameters** (framework configuration
   only): add `FRAMEWORK_VERSION`, type string, pattern
   `^v\d+\.\d+\.\d+$`, so the Deploy tab asks for a release version. Add a
   `PACKAGE_FRAMEWORK` boolean to the configuration's build options
   (`configSchema`) to have builds zip the install tree.

### What the build leaves for a deployment

The build script (`B3DCIBuild.sh`, phase `deploy-inputs`) fills `DEPLOY_DIR`
with everything a deployment needs, taken from the tested commit:

- `deploy.sh` — a copy of `Framework/Scripts/CI/B3DCIDeploy.sh`
- `tools/B3DUploadBinaries.sh` — the uploader `deploy.sh` runs
- `build-info.txt` — platform, architecture, build type, root commit
- `dependencies/*.tar.gz` — every dependency the configure step built from
  source (folders carrying a `.builtfromsource` stamp)
- `framework/B3DFramework-<platform>-<arch>-<buildType>.zip` — the install
  tree, only when the build option `PACKAGE_FRAMEWORK` is on

The agent records every file with its size and SHA-256 when the build
finishes; the orchestrator stores nothing else about them.

### Credentials file

`deploy.sh` and the promotion need secrets that never leave the server. Put
them in a `key=value` file on the server's disk and enter its absolute path
under **Settings → Deployment** (or set `DEPLOY_CREDENTIALS_FILE`); the
setting applies without a restart. The server itself reads only `GIT_TOKEN`
and `GIT_USER`; the rest is passed to `deploy.sh` untouched as
`DEPLOY_CREDENTIALS_FILE`.

```
# Read by the server: Git push credentials for promotion and pin updates (HTTPS remotes)
GIT_TOKEN=ghp_...
GIT_USER=x-access-token         # optional, defaults to x-access-token

# Read by deploy.sh / B3DUploadBinaries.sh: package server
B3D_UPLOAD_BACKEND=rclone       # or ftp
B3D_FTP_URL=ftp://packages.example.com/banshee
B3D_FTP_USER=uploader
B3D_FTP_PASS=...
# or
B3D_R2_ACCOUNT_ID=...
B3D_R2_ACCESS_KEY_ID=...
B3D_R2_SECRET_ACCESS_KEY=...
B3D_R2_BUCKET=banshee-packages
B3D_R2_PATH=dependencies        # optional prefix inside the bucket
```

Restrict the file to the account the orchestrator runs as. SSH remotes need
no token; the orchestrator's account must hold a deploy key with write access.

### What a deployment does

1. **Transfer** — the agent that ran the build streams every recorded deploy
   file to the orchestrator (`X-Content-Sha256`, exact `Content-Length`); the
   orchestrator verifies each against the hash recorded at the end of the
   build. The agent must be online; the deployment waits for it otherwise.
2. **Run** — the orchestrator runs the transferred `deploy.sh` with
   `DEPLOY_DIR`, `DEPLOY_OUTPUT_DIR`, `RESULTS_FILE`,
   `DEPLOY_CREDENTIALS_FILE`, the build's identity (`BUILD_ID`, `PLATFORM`,
   `GIT_COMMIT`, `GIT_BRANCH`, `TARGET_BRANCH`, ...), the build options and
   the deploy parameters as uppercased environment variables. Files left in
   `DEPLOY_OUTPUT_DIR` become downloadable artifacts; lines of
   `item<TAB>status<TAB>message` in `RESULTS_FILE` are shown as a table. For
   Banshee that means: upload each packaged dependency with `--if-missing`
   (never overwriting, never bumping a version) and, given
   `FRAMEWORK_VERSION`, rename the framework archive to
   `B3DFramework-vX.Y.Z-<platform>-<arch>-<buildType>.zip` and keep it.
3. **Promote** (only with a target branch that differs from the build branch)
   — children first, pushes each repository's tested commit to the target:
   fast-forward when the target did not move, a merge commit (`--no-ff`) when
   it did, plain `push --atomic`, never forced. A conflict fails the
   deployment and moves nothing. No pin commits are written and the build
   branch is never touched. The promotion is journaled per root commit and
   target branch, so the other platforms of the same build group reuse it,
   while the same commit can still be promoted to a second branch.

The received deploy files are deleted once the script ran; a retry transfers
them again. Multiple platforms of one build group may be deployed
independently; the "Auto deploy on success" option in Trigger Build deploys
them all once every build of the group passed, and skips the group if any
failed.

### Recovery

- **Agent offline** — the deployment waits (`pending`) for the agent by name
  and continues when it reconnects; cancel it from the build's Deploy tab.
- **Deploy files purged** — an agent purge deletes them; the build shows as
  not deployable and needs a new build.
- **Failed mid-promotion** — the journal under `deployments/<slug>/promotions/`
  records how far the push got; **Retry** resumes from a consistent preflight
  (repositories already on the target are recognised and not pushed again).
- **Target moved during the promotion** — the plain push is rejected, the
  deployment fails, and **Retry** preflights against the new tip (a merge
  commit if needed).

## 8. Audit log

Mutating operations (create/update/delete projects and configurations, edit
build/test/fetch scripts, trigger/cancel builds, change references, edit server
config) are appended to `{dataPath}/auth/audit.log` in JSONL format with the
timestamp, actor (`user:<username>` or `agent:<name>`), action, and target.

The log grows forever. Rotate it manually (e.g. with `logrotate` on Linux) or
via a periodic script if it gets large.

## 9. Operational checklist

Before opening the firewall:

- [ ] At least one user exists (`bsf-cli user list` returns something)
- [ ] `bindHost` is `127.0.0.1` (or `0.0.0.0` only if no proxy and you accept HTTP-only)
- [ ] Caddy (or another TLS-terminating proxy) is running
- [ ] `cookieSecure: true` is set in `config.json`
- [ ] `curl https://forge.example.com/api/health` returns `{"status":"ok",...}`
- [ ] `curl https://forge.example.com/api/v1/projects` returns 401 (auth required)
- [ ] Sign-in via the web UI works, then sign out works
- [ ] `Settings → Deployment` shows "File found on the server" for the credentials file
- [ ] `B3DSetupStaging.sh --dry-run` reports no missing build (staging) branches
- [ ] `git --version` on the server is 2.38 or newer (`merge-tree --write-tree` is used for merge promotions)

## 10. Things this deployment does NOT do

- No automatic password reset flow — use `bsf-cli user passwd <name>` to reset.
- No 2FA / MFA — out of scope for this initial version.
- No role/permission system — every user is admin (full mutate rights).
- No web UI for managing users or agent tokens — CLI only, by design (smaller attack surface).
- No log rotation — operator's responsibility.
