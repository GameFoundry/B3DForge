/**
 * A user account that can log in to BansheeForge.
 */
export interface User {
	id: string;
	username: string;
	passwordHash: string;
	createdAt: string;
	lastLoginAt?: string;
}

/**
 * Public-facing view of a user (no secrets).
 */
export interface UserPublic {
	id: string;
	username: string;
	createdAt: string;
	lastLoginAt?: string;
}

/**
 * A server-side session created on successful login.
 */
export interface Session {
	id: string;
	userId: string;
	createdAt: string;
	expiresAt: string;
	lastUsedAt: string;
}

/**
 * A long-lived bearer token used by build agents (Phase 2) for machine-to-machine auth.
 * The plaintext token is shown only once at creation time; only its hash is persisted.
 */
export interface AgentToken {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
	lastUsedAt?: string;
}

/**
 * Public-facing view of an agent token (no hash, no secret).
 */
export interface AgentTokenPublic {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt?: string;
}

/**
 * Request body for POST /api/v1/auth/login.
 */
export interface LoginRequest {
	username: string;
	password: string;
}

/**
 * Response body for POST /api/v1/auth/login and GET /api/v1/auth/me.
 */
export interface AuthMeResponse {
	username: string;
}
