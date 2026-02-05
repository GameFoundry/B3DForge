import { Link, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="min-h-screen bg-gray-900">
      <nav className="bg-gray-800 border-b border-gray-700">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex justify-between h-16">
            <div className="flex">
              <Link to="/" className="flex items-center gap-2 text-xl font-bold text-gray-100">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="w-7 h-7">
                  <defs>
                    <linearGradient id="flame" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f97316"/>
                      <stop offset="100%" stopColor="#dc2626"/>
                    </linearGradient>
                  </defs>
                  <path d="M6 20h20v3c0 1-1 2-2 2H8c-1 0-2-1-2-2v-3z" fill="#94a3b8"/>
                  <path d="M4 18h24v2H4z" fill="#cbd5e1"/>
                  <rect x="9" y="16" width="14" height="2" rx="0.5" fill="#e2e8f0"/>
                  <rect x="15" y="4" width="2" height="12" rx="0.5" fill="#a78bfa" transform="rotate(-30 16 10)"/>
                  <rect x="10" y="2" width="8" height="5" rx="1" fill="#7c3aed" transform="rotate(-30 14 4.5)"/>
                  <circle cx="10" cy="14" r="1" fill="url(#flame)"/>
                  <circle cx="22" cy="12" r="0.8" fill="url(#flame)"/>
                  <circle cx="8" cy="11" r="0.6" fill="#fbbf24"/>
                </svg>
                BansheeForge
              </Link>
              <div className="ml-10 flex items-center space-x-4">
                <Link to="/" className="text-gray-400 hover:text-gray-100">
                  Projects
                </Link>
                <Link to="/settings" className="text-gray-400 hover:text-gray-100">
                  Settings
                </Link>
              </div>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-[1800px] mx-auto py-6 px-4">
        <Outlet />
      </main>
    </div>
  );
}
