#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import prompts from 'prompts';
import { JsonFileStorage } from './storage/json-file.js';
import { ConfigService } from './services/config-service.js';
import { UsersRepository } from './auth/users-repository.js';
import { AgentTokensRepository } from './auth/agent-tokens-repository.js';
import { hashPassword } from './auth/password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..', '..');

async function bootstrap(): Promise<{
	users: UsersRepository;
	tokens: AgentTokensRepository;
	dataPath: string;
}> {
	const configService = new ConfigService(APP_ROOT);
	const { config } = await configService.load();
	const storage = new JsonFileStorage(config.dataPath);
	return {
		users: new UsersRepository(storage),
		tokens: new AgentTokensRepository(storage),
		dataPath: config.dataPath,
	};
}

async function promptPassword(message: string): Promise<string> {
	const { password } = await prompts({
		type: 'password',
		name: 'password',
		message,
		validate: (v: string) => (v.length >= 8 ? true : 'Password must be at least 8 characters'),
	}, { onCancel: () => process.exit(1) });
	return password;
}

async function userAdd(username: string): Promise<void> {
	const { users } = await bootstrap();
	const existing = await users.getByUsername(username);
	if (existing) {
		console.error(`User '${username}' already exists.`);
		process.exit(1);
	}

	const password = await promptPassword(`Password for '${username}'`);
	const confirm = await promptPassword('Confirm password');
	if (password !== confirm) {
		console.error('Passwords do not match.');
		process.exit(1);
	}

	const hash = await hashPassword(password);
	const user = await users.create(username, hash);
	console.log(`Created user '${user.username}' (${user.id}).`);
}

async function userPasswd(username: string): Promise<void> {
	const { users } = await bootstrap();
	const existing = await users.getByUsername(username);
	if (!existing) {
		console.error(`User '${username}' not found.`);
		process.exit(1);
	}

	const password = await promptPassword(`New password for '${username}'`);
	const confirm = await promptPassword('Confirm password');
	if (password !== confirm) {
		console.error('Passwords do not match.');
		process.exit(1);
	}

	const hash = await hashPassword(password);
	await users.setPassword(username, hash);
	console.log(`Password updated for '${username}'.`);
}

async function userRemove(username: string): Promise<void> {
	const { users } = await bootstrap();
	const ok = await users.delete(username);
	if (!ok) {
		console.error(`User '${username}' not found.`);
		process.exit(1);
	}
	console.log(`Removed user '${username}'.`);
}

async function userList(): Promise<void> {
	const { users } = await bootstrap();
	const list = await users.list();
	if (list.length === 0) {
		console.log('(no users)');
		return;
	}
	for (const u of list) {
		const last = u.lastLoginAt ? `last login ${u.lastLoginAt}` : 'never logged in';
		console.log(`${u.username}  (${u.id})  created ${u.createdAt}  ${last}`);
	}
}

async function agentTokenCreate(name: string): Promise<void> {
	const { tokens } = await bootstrap();
	const created = await tokens.create(name);
	console.log(`Created agent token '${created.record.name}' (${created.record.id}).`);
	console.log('');
	console.log('  Token (shown ONCE — store it somewhere safe):');
	console.log('');
	console.log(`    ${created.plaintext}`);
	console.log('');
	console.log('  Use as: Authorization: Bearer <token>');
}

async function agentTokenRevoke(id: string): Promise<void> {
	const { tokens } = await bootstrap();
	const ok = await tokens.revoke(id);
	if (!ok) {
		console.error(`Agent token '${id}' not found.`);
		process.exit(1);
	}
	console.log(`Revoked agent token '${id}'.`);
}

async function agentTokenList(): Promise<void> {
	const { tokens } = await bootstrap();
	const list = await tokens.list();
	if (list.length === 0) {
		console.log('(no agent tokens)');
		return;
	}
	for (const t of list) {
		const last = t.lastUsedAt ? `last used ${t.lastUsedAt}` : 'never used';
		console.log(`${t.id}  '${t.name}'  created ${t.createdAt}  ${last}`);
	}
}

function usage(): never {
	console.log(`bsf-cli - manage BansheeForge users and agent tokens

Usage:
  bsf-cli user add <username>
  bsf-cli user passwd <username>
  bsf-cli user remove <username>
  bsf-cli user list
  bsf-cli agent-token create <name>
  bsf-cli agent-token revoke <id>
  bsf-cli agent-token list
`);
	process.exit(1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const [group, action, arg] = args;

	if (!group) usage();

	if (group === 'user') {
		switch (action) {
			case 'add': if (!arg) usage(); await userAdd(arg); return;
			case 'passwd': if (!arg) usage(); await userPasswd(arg); return;
			case 'remove': if (!arg) usage(); await userRemove(arg); return;
			case 'list': await userList(); return;
			default: usage();
		}
	}

	if (group === 'agent-token') {
		switch (action) {
			case 'create': if (!arg) usage(); await agentTokenCreate(arg); return;
			case 'revoke': if (!arg) usage(); await agentTokenRevoke(arg); return;
			case 'list': await agentTokenList(); return;
			default: usage();
		}
	}

	usage();
}

main().catch(err => {
	console.error('Error:', err);
	process.exit(1);
});
