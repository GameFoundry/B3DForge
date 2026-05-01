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

If you already run BansheeForge locally under pm2 (with `rebuild.sh`), to pick
up the new authentication system:

```bash
cd Framework/Tools/BansheeForge

# Install the new dependencies (bcryptjs, helmet, cookie-parser, etc.)
pnpm install

# Build all packages and pm2 restart banshee-forge
./rebuild.sh

# Create your first user (you'll be prompted for a password)
./bsf-cli.sh user add admin
```

Then open `http://localhost:3003` and sign in.

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

## 5. Agent tokens (Phase 2)

The build agent (in `packages/agent`) is currently a placeholder. When it's
implemented it will authenticate to the server with a bearer token instead of a
session cookie. The token system is already wired so that no auth refactor is
needed to add it later.

Provision a token:

```bash
./bsf-cli.sh agent-token create my-build-machine
```

The plaintext token is shown **once** and never again — store it somewhere safe.
Only its bcrypt hash is persisted on disk.

The agent (or any HTTP client representing a machine) sends it as:

```
Authorization: Bearer bsf_agt_<token>
```

Manage tokens:

```bash
./bsf-cli.sh agent-token list
./bsf-cli.sh agent-token revoke <id>
```

Revoking a token immediately invalidates it; the next request with that token
gets a 401.

## 6. Audit log

Mutating operations (create/update/delete projects and configurations, edit
build/test/fetch scripts, trigger/cancel builds, change references, edit server
config) are appended to `{dataPath}/auth/audit.log` in JSONL format with the
timestamp, actor (`user:<username>` or `agent:<name>`), action, and target.

The log grows forever. Rotate it manually (e.g. with `logrotate` on Linux) or
via a periodic script if it gets large.

## 7. Operational checklist

Before opening the firewall:

- [ ] At least one user exists (`bsf-cli user list` returns something)
- [ ] `bindHost` is `127.0.0.1` (or `0.0.0.0` only if no proxy and you accept HTTP-only)
- [ ] Caddy (or another TLS-terminating proxy) is running
- [ ] `cookieSecure: true` is set in `config.json`
- [ ] `curl https://forge.example.com/api/health` returns `{"status":"ok",...}`
- [ ] `curl https://forge.example.com/api/v1/projects` returns 401 (auth required)
- [ ] Sign-in via the web UI works, then sign out works

## 8. Things this deployment does NOT do

- No automatic password reset flow — use `bsf-cli user passwd <name>` to reset.
- No 2FA / MFA — out of scope for this initial version.
- No role/permission system — every user is admin (full mutate rights).
- No web UI for managing users or agent tokens — CLI only, by design (smaller attack surface).
- No log rotation — operator's responsibility.
