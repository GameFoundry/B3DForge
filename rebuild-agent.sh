#!/bin/bash
# Rebuild the build agent from this checkout and restart whatever supervises it, on any platform.
#
# Usage:
#   ./rebuild-agent.sh [--pull] [--no-build] [--restart-only]
#
#   --pull          Fast-forward this checkout first (git pull --ff-only; skipped when detached)
#   --no-build      Skip pnpm install/build and only restart the agent
#   --restart-only  Same as --no-build
#
# The supervisor is detected in this order and the first match is restarted:
#   macOS    launchd user agent com.bansheeforge.agent   (install-macos-agent.sh)
#   Linux    systemd unit bansheeforge-agent, system or --user scope
#   Windows  NSSM/SCM service BansheeForgeAgent
#   any      pm2 app banshee-forge-agent (rebuild.sh) or bansheeforge-agent
#
# Only the shared and agent packages are built; the server and web packages are untouched, so this
# is safe on a machine that runs nothing but an agent. On the orchestrator host ./rebuild.sh
# rebuilds everything and reloads both pm2 apps; use this script there only to bounce the agent.

set -euo pipefail
cd "$(dirname "$0")"

PULL=false
BUILD=true
for arg in "$@"; do
	case "$arg" in
		--pull) PULL=true ;;
		--no-build|--restart-only) BUILD=false ;;
		-h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

LABEL="com.bansheeforge.agent"
AGENT_HOME="${BANSHEEFORGE_AGENT_HOME:-$HOME/.bansheeforge-agent}"

if [ "$PULL" = true ]; then
	if git symbolic-ref -q HEAD >/dev/null; then
		echo "Pulling $(git rev-parse --abbrev-ref HEAD)..."
		git pull --ff-only
	else
		echo "Checkout is detached (submodule pin); not pulling. Update the parent repository instead."
	fi
fi

if [ "$BUILD" = true ]; then
	echo "Installing dependencies..."
	pnpm install --frozen-lockfile
	echo "Building shared + agent..."
	pnpm --filter @banshee-forge/shared --filter @banshee-forge/agent build
fi

if [ ! -f packages/agent/dist/index.js ]; then
	echo "packages/agent/dist/index.js is missing; run without --no-build." >&2
	exit 1
fi

# Prints the last lines the restarted agent logged, so the "Connected" / "Registered" lines are
# visible without a second command. $1 = log file, $2 = byte offset the restart started at.
show_new_log() {
	local logFile="$1" offset="$2"
	[ -f "$logFile" ] || return 0
	echo "--- $logFile"
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 1
		if tail -c "+$((offset + 1))" "$logFile" | grep -q "Registered (agentId="; then break; fi
	done
	tail -c "+$((offset + 1))" "$logFile" | tail -n 20
}

log_size() {
	[ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo 0
}

# Restarts the pm2 app named $1 when pm2 manages one by that name; returns 1 otherwise.
restart_pm2() {
	command -v pm2 >/dev/null 2>&1 || return 1
	pm2 jlist 2>/dev/null | grep -q "\"name\":\"$1\"" || return 1
	echo "Restarting pm2 app $1..."
	pm2 restart "$1" --update-env
	sleep 3
	pm2 logs "$1" --nostream --lines 20
	return 0
}

case "$(uname -s)" in
	Darwin)
		UID_NUM="$(id -u)"
		PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
		if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
			echo "Restarting launchd agent $LABEL..."
			before=$(log_size "$AGENT_HOME/agent.log")
			launchctl kickstart -k "gui/$UID_NUM/$LABEL"
			show_new_log "$AGENT_HOME/agent.log" "$before"
		elif [ -f "$PLIST" ]; then
			echo "Loading launchd agent $LABEL..."
			before=$(log_size "$AGENT_HOME/agent.log")
			launchctl bootstrap "gui/$UID_NUM" "$PLIST"
			show_new_log "$AGENT_HOME/agent.log" "$before"
		elif ! restart_pm2 banshee-forge-agent && ! restart_pm2 bansheeforge-agent; then
			echo "No launchd agent or pm2 app found. Install with:" >&2
			echo "  ./packages/agent/macos/install-macos-agent.sh <orchestrator-url> <agent-token> [name]" >&2
			exit 1
		fi
		;;
	Linux)
		if systemctl cat bansheeforge-agent >/dev/null 2>&1; then
			echo "Restarting systemd unit bansheeforge-agent..."
			sudo systemctl restart bansheeforge-agent
			sleep 3
			journalctl -u bansheeforge-agent -n 20 --no-pager
		elif systemctl --user cat bansheeforge-agent >/dev/null 2>&1; then
			echo "Restarting user systemd unit bansheeforge-agent..."
			systemctl --user restart bansheeforge-agent
			sleep 3
			journalctl --user -u bansheeforge-agent -n 20 --no-pager
		elif ! restart_pm2 banshee-forge-agent && ! restart_pm2 bansheeforge-agent; then
			echo "No systemd unit or pm2 app found; see DEPLOYMENT.md section 6 for setting one up." >&2
			exit 1
		fi
		;;
	MINGW*|MSYS*|CYGWIN*)
		if sc query BansheeForgeAgent >/dev/null 2>&1; then
			echo "Restarting Windows service BansheeForgeAgent..."
			net stop BansheeForgeAgent >/dev/null 2>&1 || true
			net start BansheeForgeAgent
			sleep 3
			sc query BansheeForgeAgent | grep STATE
		elif ! restart_pm2 banshee-forge-agent && ! restart_pm2 bansheeforge-agent; then
			echo "No BansheeForgeAgent service or pm2 app found; see DEPLOYMENT.md section 6 for setting one up." >&2
			exit 1
		fi
		;;
	*)
		echo "Unsupported platform: $(uname -s)" >&2
		exit 1
		;;
esac

echo
echo "Done. The agent should now be listed under Agents in the web UI."
