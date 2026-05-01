import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Login } from '../pages/Login';

export function RequireAuth({ children }: { children: ReactNode }) {
	const { username, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="min-h-screen bg-gray-900 flex items-center justify-center">
				<div className="text-gray-500 text-sm">Loading...</div>
			</div>
		);
	}

	if (!username)
		return <Login />;

	return <>{children}</>;
}
