#!/bin/bash
# Install (or update) the BansheeForge build agent as a launchd user agent on macOS.
#
# Usage:
#   ./install-macos-agent.sh <orchestrator-url> <agent-token> [agent-name]
#
# Prerequisites (Homebrew): node, bash (>= 4, the CI scripts use associative arrays), cmake, ninja.
# Run as the user that will own the console while builds run; the agent only accepts work while
# that user is logged in at the screen. Re-run to pick up a rebuilt dist or a changed config.
#
# The agent lives in ~/.bansheeforge-agent:
#   agent.json     connection settings (token included, chmod 600)
#   workspaces/    incremental build workspaces
#   builds/        per-build results and artifacts
#   agent.log      launchd stdout/stderr

set -euo pipefail

ORCHESTRATOR_URL="${1:-}"
TOKEN="${2:-}"
NAME="${3:-$(hostname -s)-darwin}"

if [ -z "$ORCHESTRATOR_URL" ] || [ -z "$TOKEN" ]; then
	echo "Usage: $0 <orchestrator-url> <agent-token> [agent-name]" >&2
	exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
	echo "This installer is for macOS only." >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_PACKAGE="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_SCRIPT="$AGENT_PACKAGE/dist/index.js"
AGENT_HOME="$HOME/.bansheeforge-agent"
LABEL="com.bansheeforge.agent"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
	echo "node not found. Install it with: brew install node" >&2
	exit 1
fi

if [ ! -x /opt/homebrew/bin/bash ] && [ ! -x /usr/local/bin/bash ]; then
	echo "WARNING: Homebrew bash not found. The system bash (3.2) cannot run the CI test script." >&2
	echo "         Install it with: brew install bash" >&2
fi

if [ ! -f "$AGENT_SCRIPT" ]; then
	echo "Agent is not built ($AGENT_SCRIPT missing). Run 'pnpm install && pnpm build' at the repo root first." >&2
	exit 1
fi

mkdir -p "$AGENT_HOME" "$HOME/Library/LaunchAgents"

# Connection settings. Platforms default to the host OS (darwin); add e.g. "platforms": ["darwin"].
cat > "$AGENT_HOME/agent.json" <<JSON
{
	"orchestratorUrl": "$ORCHESTRATOR_URL",
	"token": "$TOKEN",
	"name": "$NAME",
	"labels": [],
	"maxParallelBuilds": 1
}
JSON
chmod 600 "$AGENT_HOME/agent.json"

# Fill the plist template.
sed \
	-e "s|__NODE__|$NODE_BIN|g" \
	-e "s|__AGENT_SCRIPT__|$AGENT_SCRIPT|g" \
	-e "s|__AGENT_HOME__|$AGENT_HOME|g" \
	"$SCRIPT_DIR/$LABEL.plist" > "$PLIST_DEST"

# (Re)load into the current GUI session.
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DEST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "Installed $LABEL"
echo "  Config:  $AGENT_HOME/agent.json"
echo "  Log:     $AGENT_HOME/agent.log"
echo "  Status:  launchctl print gui/$UID_NUM/$LABEL | head -20"
echo "  Remove:  launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST_DEST"
