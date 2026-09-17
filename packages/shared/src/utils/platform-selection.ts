import type { PlatformAvailability } from '../types/agent.js';

/**
 * Selection state of the platform checkboxes in a trigger dialog. Defaults are applied once per
 * configuration; after the user edits the selection, background availability refreshes may only
 * remove platforms that stopped being valid, never add or restore any.
 */
export interface PlatformSelectionState {
	/** Configuration the defaults were computed for; a different one re-initializes the selection. */
	configurationId: string;
	/** True once the user changed the selection by hand. */
	userEdited: boolean;
	/** True once defaults were computed with availability data present. */
	initializedWithAvailability: boolean;
	selected: string[];
	/** Platforms dropped from the selection because the configuration no longer supports them. */
	removed: string[];
}

export interface PlatformSelectionInput {
	configurationId: string;
	/** Platforms the configuration may be built for. */
	supported: string[];
	/** Undefined while availability is still loading. */
	availability: PlatformAvailability[] | undefined;
}

/** Supported platforms that some agent has serviced at least once. All of them while availability is unknown. */
export function defaultPlatformSelection(supported: string[], availability: PlatformAvailability[] | undefined): string[] {
	if (!availability) return [...supported];
	return supported.filter(id => availability.find(a => a.id === id)?.status !== 'never-seen');
}

export function initialPlatformSelection(input: PlatformSelectionInput): PlatformSelectionState {
	return {
		configurationId: input.configurationId,
		userEdited: false,
		initializedWithAvailability: input.availability !== undefined,
		selected: defaultPlatformSelection(input.supported, input.availability),
		removed: [],
	};
}

/**
 * Bring a selection up to date with fresh inputs. Re-initializes on a configuration change,
 * applies defaults when availability arrives before the user touched anything, and otherwise
 * only strips platforms the configuration stopped supporting.
 */
export function reconcilePlatformSelection(state: PlatformSelectionState, input: PlatformSelectionInput): PlatformSelectionState {
	if (state.configurationId !== input.configurationId)
		return initialPlatformSelection(input);

	if (!state.userEdited && !state.initializedWithAvailability && input.availability !== undefined) {
		return {
			...state,
			initializedWithAvailability: true,
			selected: defaultPlatformSelection(input.supported, input.availability),
			removed: [],
		};
	}

	const removed = state.selected.filter(id => !input.supported.includes(id));
	if (removed.length === 0) return state;
	return {
		...state,
		selected: state.selected.filter(id => input.supported.includes(id)),
		removed: [...state.removed, ...removed],
	};
}

/** Apply a user toggle. Marks the selection as user-edited so later refreshes leave it alone. */
export function togglePlatformSelection(state: PlatformSelectionState, platformId: string, checked: boolean): PlatformSelectionState {
	const selected = checked
		? Array.from(new Set([...state.selected, platformId]))
		: state.selected.filter(id => id !== platformId);
	return { ...state, selected, userEdited: true, removed: [] };
}
