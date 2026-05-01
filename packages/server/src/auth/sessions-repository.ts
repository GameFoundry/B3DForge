import type { Session } from '@banshee-forge/shared';
import { generateSessionId } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

interface SessionsFile {
	sessions: Session[];
}

const FILE_PATH = 'auth/sessions.json';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class SessionsRepository {
	constructor(private storage: JsonFileStorage) {}

	async create(userId: string): Promise<Session> {
		const data = await this.storage.read<SessionsFile>(FILE_PATH, { sessions: [] });
		const now = new Date();
		const session: Session = {
			id: generateSessionId(),
			userId,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
			lastUsedAt: now.toISOString(),
		};
		data.sessions.push(session);
		await this.storage.write<SessionsFile>(FILE_PATH, data);
		return session;
	}

	/** Look up a session, sliding the expiry forward if still valid. Returns null if missing or expired. */
	async getActive(sessionId: string): Promise<Session | null> {
		const data = await this.storage.read<SessionsFile>(FILE_PATH, { sessions: [] });
		const session = data.sessions.find(s => s.id === sessionId);
		if (!session) return null;

		const now = new Date();
		if (new Date(session.expiresAt).getTime() <= now.getTime()) {
			data.sessions = data.sessions.filter(s => s.id !== sessionId);
			await this.storage.write<SessionsFile>(FILE_PATH, data);
			return null;
		}

		// Slide expiry forward and update lastUsed (skip writes if updated within last minute to avoid thrashing)
		const lastUsedMs = new Date(session.lastUsedAt).getTime();
		if (now.getTime() - lastUsedMs > 60 * 1000) {
			session.lastUsedAt = now.toISOString();
			session.expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
			await this.storage.write<SessionsFile>(FILE_PATH, data);
		}
		return session;
	}

	async delete(sessionId: string): Promise<void> {
		const data = await this.storage.read<SessionsFile>(FILE_PATH, { sessions: [] });
		const initial = data.sessions.length;
		data.sessions = data.sessions.filter(s => s.id !== sessionId);
		if (data.sessions.length !== initial)
			await this.storage.write<SessionsFile>(FILE_PATH, data);
	}

	async deleteByUserId(userId: string): Promise<void> {
		const data = await this.storage.read<SessionsFile>(FILE_PATH, { sessions: [] });
		const initial = data.sessions.length;
		data.sessions = data.sessions.filter(s => s.userId !== userId);
		if (data.sessions.length !== initial)
			await this.storage.write<SessionsFile>(FILE_PATH, data);
	}

	async deleteExpired(): Promise<number> {
		const data = await this.storage.read<SessionsFile>(FILE_PATH, { sessions: [] });
		const now = Date.now();
		const before = data.sessions.length;
		data.sessions = data.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
		const removed = before - data.sessions.length;
		if (removed > 0)
			await this.storage.write<SessionsFile>(FILE_PATH, data);
		return removed;
	}
}
