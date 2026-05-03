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
- **Artifacts and test results stay on the agent's disk** in v1 — they are not
  uploaded back to the orchestrator. The build's log lines and phase timings
  *are* streamed back, so the dashboard reflects status correctly. Plan to ship
  artifacts elsewhere from inside your `build.sh` if you need them centrally
  available (e.g. push to S3 / shared storage from the script).

## 7. Audit log

Mutating operations (create/update/delete projects and configurations, edit
build/test/fetch scripts, trigger/cancel builds, change references, edit server
config) are appended to `{dataPath}/auth/audit.log` in JSONL format with the
timestamp, actor (`user:<username>` or `agent:<name>`), action, and target.

The log grows forever. Rotate it manually (e.g. with `logrotate` on Linux) or
via a periodic script if it gets large.

## 8. Operational checklist

Before opening the firewall:

- [ ] At least one user exists (`bsf-cli user list` returns something)
- [ ] `bindHost` is `127.0.0.1` (or `0.0.0.0` only if no proxy and you accept HTTP-only)
- [ ] Caddy (or another TLS-terminating proxy) is running
- [ ] `cookieSecure: true` is set in `config.json`
- [ ] `curl https://forge.example.com/api/health` returns `{"status":"ok",...}`
- [ ] `curl https://forge.example.com/api/v1/projects` returns 401 (auth required)
- [ ] Sign-in via the web UI works, then sign out works

## 9. Things this deployment does NOT do

- No automatic password reset flow — use `bsf-cli user passwd <name>` to reset.
- No 2FA / MFA — out of scope for this initial version.
- No role/permission system — every user is admin (full mutate rights).
- No web UI for managing users or agent tokens — CLI only, by design (smaller attack surface).
- No log rotation — operator's responsibility.
