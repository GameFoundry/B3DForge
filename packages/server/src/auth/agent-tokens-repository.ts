import { randomBytes } from 'crypto';
import type { AgentToken, AgentTokenPublic } from '@banshee-forge/shared';
import { generateAgentTokenId } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';
import { hashPassword, verifyPassword } from './password.js';

interface AgentTokensFile {
	tokens: AgentToken[];
}

const FILE_PATH = 'auth/agent-tokens.json';
const TOKEN_PREFIX = 'bsf_agt_';

function toPublic(token: AgentToken): AgentTokenPublic {
	return {
		id: token.id,
		name: token.name,
		createdAt: token.createdAt,
		lastUsedAt: token.lastUsedAt,
	};
}

export interface CreatedAgentToken {
	record: AgentTokenPublic;
	/** The plaintext token. Returned ONCE at creation time and never retrievable again. */
	plaintext: string;
}

export class AgentTokensRepository {
	constructor(private storage: JsonFileStorage) {}

	async list(): Promise<AgentTokenPublic[]> {
		const data = await this.storage.read<AgentTokensFile>(FILE_PATH, { tokens: [] });
		return data.tokens.map(toPublic);
	}

	async create(name: string): Promise<CreatedAgentToken> {
		const data = await this.storage.read<AgentTokensFile>(FILE_PATH, { tokens: [] });
		const secret = randomBytes(32).toString('hex');
		const plaintext = `${TOKEN_PREFIX}${secret}`;
		const tokenHash = await hashPassword(secret);
		const record: AgentToken = {
			id: generateAgentTokenId(),
			name,
			tokenHash,
			createdAt: new Date().toISOString(),
		};
		data.tokens.push(record);
		await this.storage.write<AgentTokensFile>(FILE_PATH, data);
		return { record: toPublic(record), plaintext };
	}

	async revoke(id: string): Promise<boolean> {
		const data = await this.storage.read<AgentTokensFile>(FILE_PATH, { tokens: [] });
		const index = data.tokens.findIndex(t => t.id === id);
		if (index === -1) return false;
		data.tokens.splice(index, 1);
		await this.storage.write<AgentTokensFile>(FILE_PATH, data);
		return true;
	}

	/** Look up a token record by its plaintext. Returns null if no token matches. */
	async findByPlaintext(plaintext: string): Promise<AgentToken | null> {
		if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
		const secret = plaintext.slice(TOKEN_PREFIX.length);
		if (!secret) return null;

		const data = await this.storage.read<AgentTokensFile>(FILE_PATH, { tokens: [] });
		for (const token of data.tokens) {
			if (await verifyPassword(secret, token.tokenHash))
				return token;
		}
		return null;
	}

	async updateLastUsed(id: string): Promise<void> {
		const data = await this.storage.read<AgentTokensFile>(FILE_PATH, { tokens: [] });
		const token = data.tokens.find(t => t.id === id);
		if (!token) return;
		const now = new Date();
		const lastUsedMs = token.lastUsedAt ? new Date(token.lastUsedAt).getTime() : 0;
		// Throttle writes to once per minute
		if (now.getTime() - lastUsedMs <= 60 * 1000) return;
		token.lastUsedAt = now.toISOString();
		await this.storage.write<AgentTokensFile>(FILE_PATH, data);
	}
}
