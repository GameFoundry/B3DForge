import type { BuildStatus } from '@banshee-forge/shared';

const statusStyles: Record<BuildStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  running: 'bg-blue-100 text-blue-800',
  success: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

export function BuildStatusBadge({ status }: { status: BuildStatus }) {
  return (
    <span className={`px-2 py-1 text-xs font-medium rounded-full ${statusStyles[status]}`}>
      {status}
    </span>
  );
}
