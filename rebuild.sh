#!/bin/bash
# Build all packages and start (or reload) the local pm2 apps:
#   - banshee-forge        (the orchestrator)
#   - banshee-forge-agent  (a local build agent)
#
# On first run this also provisions an agent token and writes it to .agent-token,
# which pm2.config.cjs reads when launching the agent process.

set -e

cd "$(dirname "$0")"

echo "Building all packages..."
pnpm run build

# Provision a local agent token if we don't already have one.
TOKEN_FILE=".agent-token"
if [ ! -f "$TOKEN_FILE" ]; then
	echo
	echo "Provisioning local agent token..."
	output=$(./bsf-cli.sh agent-token create local 2>&1)
	echo "$output"
	token=$(echo "$output" | grep -oE 'bsf_agt_[a-f0-9]+' | head -1)
	if [ -z "$token" ]; then
		echo "ERROR: failed to extract agent token from CLI output."
		exit 1
	fi
	printf '%s' "$token" > "$TOKEN_FILE"
	chmod 600 "$TOKEN_FILE" 2>/dev/null || true
	echo "Saved token to $TOKEN_FILE"
fi

echo
echo "Starting/reloading pm2 apps..."
pm2 startOrReload pm2.config.cjs

echo
echo "Done. View logs with:  pm2 logs banshee-forge       (server)"
echo "                       pm2 logs banshee-forge-agent (agent)"
