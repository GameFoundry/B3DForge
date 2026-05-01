import type { Request, Response, RequestHandler } from 'express';
import type { AgentToken, User } from '@banshee-forge/shared';
import { UsersRepository } from './users-repository.js';
import { SessionsRepository } from './sessions-repository.js';
import { AgentTokensRepository } from './agent-tokens-repository.js';

export const SESSION_COOKIE_NAME = 'bsf_session';

export interface AuthenticatedUser {
	id: string;
	username: string;
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			user?: AuthenticatedUser;
			agent?: { id: string; name: string };
		}
	}
}

export interface AuthMiddlewares {
	requireUser: RequestHandler;
	requireAgent: RequestHandler;
	requireAuth: RequestHandler;
}

export function createAuthMiddlewares(
	usersRepo: UsersRepository,
	sessionsRepo: SessionsRepository,
	agentTokensRepo: AgentTokensRepository
): AuthMiddlewares {
	async function resolveSession(sessionId: string | undefined): Promise<User | null> {
		if (!sessionId) return null;
		const session = await sessionsRepo.getActive(sessionId);
		if (!session) return null;
		return usersRepo.getById(session.userId);
	}

	async function resolveBearer(req: Request): Promise<AgentToken | null> {
		const header = req.headers.authorization;
		if (!header || !header.startsWith('Bearer ')) return null;
		const plaintext = header.slice('Bearer '.length).trim();
		if (!plaintext) return null;
		const token = await agentTokensRepo.findByPlaintext(plaintext);
		if (token) await agentTokensRepo.updateLastUsed(token.id);
		return token;
	}

	const requireUser: RequestHandler = async (req, res, next) => {
		try {
			const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
			const user = await resolveSession(sessionId);
			if (!user) {
				unauthorized(res);
				return;
			}
			req.user = { id: user.id, username: user.username };
			next();
		} catch (err) {
			next(err);
		}
	};

	const requireAgent: RequestHandler = async (req, res, next) => {
		try {
			const token = await resolveBearer(req);
			if (!token) {
				unauthorized(res);
				return;
			}
			req.agent = { id: token.id, name: token.name };
			next();
		} catch (err) {
			next(err);
		}
	};

	const requireAuth: RequestHandler = async (req, res, next) => {
		try {
			const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
			const user = await resolveSession(sessionId);
			if (user) {
				req.user = { id: user.id, username: user.username };
				next();
				return;
			}
			const token = await resolveBearer(req);
			if (token) {
				req.agent = { id: token.id, name: token.name };
				next();
				return;
			}
			unauthorized(res);
		} catch (err) {
			next(err);
		}
	};

	return { requireUser, requireAgent, requireAuth };
}

function unauthorized(res: Response): void {
	res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
}

/**
 * Parse a `Cookie:` header into a key/value map. Used by the Socket.IO handshake
 * which doesn't go through the cookie-parser middleware.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!header) return result;
	for (const part of header.split(';')) {
		const idx = part.indexOf('=');
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) result[key] = decodeURIComponent(value);
	}
	return result;
}

/**
 * Resolve the user behind a session cookie. Used by the Socket.IO handshake.
 */
export async function resolveSessionUser(
	sessionId: string | undefined,
	usersRepo: UsersRepository,
	sessionsRepo: SessionsRepository
): Promise<AuthenticatedUser | null> {
	if (!sessionId) return null;
	const session = await sessionsRepo.getActive(sessionId);
	if (!session) return null;
	const user = await usersRepo.getById(session.userId);
	if (!user) return null;
	return { id: user.id, username: user.username };
}
