import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '../contexts/AuthContext';

export function Login() {
	const { login } = useAuth();
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [submitting, setSubmitting] = useState(false);

	async function fnSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		try {
			await login(username, password);
		} catch (err) {
			toast.error((err as Error).message || 'Login failed');
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
			<div className="w-full max-w-sm">
				<div className="flex items-center justify-center gap-2 mb-8 text-2xl font-bold text-gray-100">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="w-8 h-8">
						<defs>
							<linearGradient id="login-flame" x1="0" y1="0" x2="0" y2="1">
								<stop offset="0%" stopColor="#f97316"/>
								<stop offset="100%" stopColor="#dc2626"/>
							</linearGradient>
						</defs>
						<path d="M6 20h20v3c0 1-1 2-2 2H8c-1 0-2-1-2-2v-3z" fill="#94a3b8"/>
						<path d="M4 18h24v2H4z" fill="#cbd5e1"/>
						<rect x="9" y="16" width="14" height="2" rx="0.5" fill="#e2e8f0"/>
						<rect x="15" y="4" width="2" height="12" rx="0.5" fill="#a78bfa" transform="rotate(-30 16 10)"/>
						<rect x="10" y="2" width="8" height="5" rx="1" fill="#7c3aed" transform="rotate(-30 14 4.5)"/>
						<circle cx="10" cy="14" r="1" fill="url(#login-flame)"/>
						<circle cx="22" cy="12" r="0.8" fill="url(#login-flame)"/>
						<circle cx="8" cy="11" r="0.6" fill="#fbbf24"/>
					</svg>
					BansheeForge
				</div>
				<form
					onSubmit={fnSubmit}
					className="bg-gray-800 border border-gray-700 rounded-lg p-6 space-y-4 shadow-lg"
				>
					<div>
						<label className="block text-sm font-medium text-gray-300 mb-1.5" htmlFor="username">
							Username
						</label>
						<input
							id="username"
							type="text"
							value={username}
							onChange={e => setUsername(e.target.value)}
							autoFocus
							autoComplete="username"
							required
							className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
						/>
					</div>
					<div>
						<label className="block text-sm font-medium text-gray-300 mb-1.5" htmlFor="password">
							Password
						</label>
						<input
							id="password"
							type="password"
							value={password}
							onChange={e => setPassword(e.target.value)}
							autoComplete="current-password"
							required
							className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
						/>
					</div>
					<button
						type="submit"
						disabled={submitting || !username || !password}
						className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
					>
						{submitting ? 'Signing in...' : 'Sign in'}
					</button>
				</form>
			</div>
		</div>
	);
}
