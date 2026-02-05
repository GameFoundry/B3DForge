import { Link, Outlet } from 'react-router-dom';
import { useBuildNotifications } from '../hooks/useBuildNotifications';
import { useNotificationPermission } from '../hooks/useNotificationPermission';

function NotificationBell() {
  const { permission, requestPermission } = useNotificationPermission();

  if (permission === 'unsupported' || permission === 'granted')
    return null;

  const isDenied = permission === 'denied';
  const title = isDenied
    ? 'Notifications blocked - enable in browser settings'
    : 'Enable desktop notifications';

  return (
    <button
      onClick={isDenied ? undefined : requestPermission}
      title={title}
      className={`relative p-1.5 rounded transition-colors ${
        isDenied
          ? 'text-gray-600 cursor-not-allowed'
          : 'text-gray-400 hover:text-gray-100 hover:bg-gray-700'
      }`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
        <path fillRule="evenodd" d="M10 2a6 6 0 00-6 6c0 1.887-.454 3.665-1.257 5.234a.75.75 0 00.515 1.076 32.91 32.91 0 003.256.508 3.5 3.5 0 006.972 0 32.903 32.903 0 003.256-.508.75.75 0 00.515-1.076A11.448 11.448 0 0116 8a6 6 0 00-6-6zM8.05 14.943a33.54 33.54 0 003.9 0 2 2 0 01-3.9 0z" clipRule="evenodd" />
      </svg>
      {!isDenied && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-amber-500 rounded-full" />
      )}
      {isDenied && (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 absolute bottom-0.5 right-0 text-red-500">
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      )}
    </button>
  );
}

export function Layout() {
  useBuildNotifications();

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
            <div className="flex items-center">
              <NotificationBell />
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
