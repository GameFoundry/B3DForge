// pm2 ecosystem file for a single-machine BansheeForge install (server + 1 local agent).
//
// Used by ./rebuild.sh to start or reload both apps.

const fs = require('fs');
const path = require('path');

const tokenPath = path.join(__dirname, '.agent-token');
const agentToken = fs.existsSync(tokenPath)
	? fs.readFileSync(tokenPath, 'utf-8').trim()
	: '';

module.exports = {
	apps: [
		{
			name: 'banshee-forge',
			script: 'packages/server/dist/index.js',
			cwd: __dirname,
			autorestart: true,
			watch: false,
			env: {
				NODE_ENV: 'production',
			},
		},
		{
			name: 'banshee-forge-agent',
			script: 'packages/agent/dist/index.js',
			cwd: __dirname,
			autorestart: true,
			watch: false,
			env: {
				NODE_ENV: 'production',
				BSF_ORCHESTRATOR_URL: 'http://127.0.0.1:3003',
				BSF_AGENT_TOKEN: agentToken,
				BSF_AGENT_NAME: 'local',
				BSF_AGENT_LABELS: 'local',
				BSF_AGENT_MAX_PARALLEL: '1',
			},
		},
	],
};
