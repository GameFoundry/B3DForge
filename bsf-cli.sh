#!/bin/bash
# Wrapper that invokes the BansheeForge management CLI.
#
# Usage:
#   ./bsf-cli.sh user add <username>
#   ./bsf-cli.sh user passwd <username>
#   ./bsf-cli.sh user remove <username>
#   ./bsf-cli.sh user list
#   ./bsf-cli.sh agent-token create <name>
#   ./bsf-cli.sh agent-token revoke <id>
#   ./bsf-cli.sh agent-token list
#
# The CLI reads the same config.json the server uses, so it works regardless
# of whether the server is running.

set -e
cd "$(dirname "$0")"

CLI_JS="packages/server/dist/cli.js"

if [ ! -f "$CLI_JS" ]; then
	echo "Error: $CLI_JS not found. Build first with:"
	echo "  pnpm install && pnpm build"
	exit 1
fi

exec node "$CLI_JS" "$@"
