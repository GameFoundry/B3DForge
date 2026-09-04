import { PLATFORMS } from '@banshee-forge/shared';
import type { PlatformAvailability } from '@banshee-forge/shared';

interface PlatformSelectorProps {
	/** Selected platform ids. */
	value: string[];
	onChange: (platforms: string[]) => void;
	/** Restrict the offered platforms (e.g. those a configuration supports). Defaults to all. */
	allowed?: string[];
	/** When given, platforms without any known agent are disabled and each shows its agent state. */
	availability?: PlatformAvailability[];
	disabled?: boolean;
	compact?: boolean;
}

/** Checkbox group over the global platform list. */
export function PlatformSelector({ value, onChange, allowed, availability, disabled, compact }: PlatformSelectorProps) {
	const platforms = PLATFORMS.filter(p => !allowed || allowed.length === 0 || allowed.includes(p.id));

	const toggle = (id: string, checked: boolean) => {
		const next = checked
			? Array.from(new Set([...value, id]))
			: value.filter(p => p !== id);
		onChange(next);
	};

	return (
		<div className={compact ? 'flex flex-wrap gap-x-4 gap-y-1' : 'space-y-2'}>
			{platforms.map(platform => {
				const state = availability?.find(a => a.id === platform.id);
				const selectable = !availability || state?.status !== 'never-seen';
				const checked = value.includes(platform.id);
				return (
					<label
						key={platform.id}
						className={`flex items-center gap-2 ${selectable && !disabled ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
						title={state ? describeAvailability(state) : undefined}
					>
						<input
							type="checkbox"
							checked={checked}
							disabled={disabled || !selectable}
							onChange={(e) => toggle(platform.id, e.target.checked)}
							className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
						/>
						<span className="text-sm text-gray-200">{platform.label}</span>
						{state && <AvailabilityBadge state={state} />}
					</label>
				);
			})}
		</div>
	);
}

function describeAvailability(state: PlatformAvailability): string {
	if (state.status === 'never-seen') return 'No agent has ever registered for this platform';
	return state.agents
		.map(a => {
			if (!a.connected) return `${a.name}: offline (last seen ${new Date(a.lastSeenAt).toLocaleString()})`;
			return a.available ? `${a.name}: connected` : `${a.name}: ${a.unavailableReason ?? 'unavailable'}`;
		})
		.join('\n');
}

function AvailabilityBadge({ state }: { state: PlatformAvailability }) {
	if (state.status === 'never-seen') {
		return <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">no agent</span>;
	}
	if (state.status === 'offline') {
		return <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300">agent offline, build will wait</span>;
	}
	const ready = state.agents.some(a => a.connected && a.available);
	if (!ready) {
		const reason = state.agents.find(a => a.connected && !a.available)?.unavailableReason ?? 'busy';
		return <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300">{reason}</span>;
	}
	return <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/40 text-green-300">connected</span>;
}
