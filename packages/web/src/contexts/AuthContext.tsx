import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, AUTH_REQUIRED_EVENT, UnauthorizedError } from '../api/client';

interface AuthState {
	username: string | null;
	isLoading: boolean;
	login: (username: string, password: string) => Promise<void>;
	logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [username, setUsername] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const me = await authApi.me();
				if (!cancelled) setUsername(me.username);
			} catch (err) {
				if (!(err instanceof UnauthorizedError) && !cancelled)
					console.error('Failed to check auth state:', err);
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		})();
		return () => { cancelled = true; };
	}, []);

	useEffect(() => {
		const fnHandler = () => setUsername(null);
		window.addEventListener(AUTH_REQUIRED_EVENT, fnHandler);
		return () => window.removeEventListener(AUTH_REQUIRED_EVENT, fnHandler);
	}, []);

	const login = useCallback(async (user: string, password: string) => {
		const me = await authApi.login({ username: user, password });
		setUsername(me.username);
	}, []);

	const logout = useCallback(async () => {
		try {
			await authApi.logout();
		} finally {
			setUsername(null);
		}
	}, []);

	const value = useMemo<AuthState>(
		() => ({ username, isLoading, login, logout }),
		[username, isLoading, login, logout]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error('useAuth must be used within AuthProvider');
	return ctx;
}
