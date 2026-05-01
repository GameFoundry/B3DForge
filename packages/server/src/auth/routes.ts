import { Router } from 'express';
import type { Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { LoginRequest, AuthMeResponse } from '@banshee-forge/shared';
import { UsersRepository } from './users-repository.js';
import { SessionsRepository } from './sessions-repository.js';
import { verifyPassword } from './password.js';
import { SESSION_COOKIE_NAME } from './middleware.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthRoutesOptions {
	/** Set Secure on session cookies. Should be true when behind HTTPS (i.e. behind a reverse proxy). */
	cookieSecure: boolean;
}

export function createAuthRoutes(
	usersRepo: UsersRepository,
	sessionsRepo: SessionsRepository,
	options: AuthRoutesOptions
): Router {
	const router = Router();

	const loginLimiter = rateLimit({
		windowMs: 60 * 1000,
		limit: 5,
		standardHeaders: 'draft-7',
		legacyHeaders: false,
		message: { error: 'Too many requests', message: 'Too many login attempts. Try again in a minute.' },
	});

	function setSessionCookie(res: Response, sessionId: string): void {
		res.cookie(SESSION_COOKIE_NAME, sessionId, {
			httpOnly: true,
			sameSite: 'lax',
			secure: options.cookieSecure,
			maxAge: SESSION_TTL_MS,
			path: '/',
		});
	}

	router.post('/login', loginLimiter, async (req, res, next) => {
		try {
			const { username, password } = (req.body ?? {}) as Partial<LoginRequest>;
			if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
				res.status(400).json({ error: 'Bad request', message: 'username and password are required' });
				return;
			}

			const user = await usersRepo.getByUsername(username);
			if (!user || !(await verifyPassword(password, user.passwordHash))) {
				res.status(401).json({ error: 'Unauthorized', message: 'Invalid username or password' });
				return;
			}

			const session = await sessionsRepo.create(user.id);
			setSessionCookie(res, session.id);
			await usersRepo.updateLastLogin(user.id);

			const response: AuthMeResponse = { username: user.username };
			res.json(response);
		} catch (err) {
			next(err);
		}
	});

	router.post('/logout', async (req, res, next) => {
		try {
			const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
			if (typeof sessionId === 'string' && sessionId)
				await sessionsRepo.delete(sessionId);
			res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
			res.json({ success: true });
		} catch (err) {
			next(err);
		}
	});

	router.get('/me', async (req, res, next) => {
		try {
			const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
			if (typeof sessionId !== 'string' || !sessionId) {
				res.status(401).json({ error: 'Unauthorized', message: 'Not signed in' });
				return;
			}
			const session = await sessionsRepo.getActive(sessionId);
			if (!session) {
				res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
				res.status(401).json({ error: 'Unauthorized', message: 'Session expired' });
				return;
			}
			const user = await usersRepo.getById(session.userId);
			if (!user) {
				res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
				res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
				return;
			}
			const response: AuthMeResponse = { username: user.username };
			res.json(response);
		} catch (err) {
			next(err);
		}
	});

	return router;
}
