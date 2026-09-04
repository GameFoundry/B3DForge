import platformsJson from './platforms.json';

/**
 * A build target platform. Distinct from the OS an agent runs on: a Windows agent may service
 * `win32` and `ps5` builds, while a macOS agent services `darwin`. The full list lives in
 * `platforms.json`; ids are used as directory names and environment values so they must stay
 * filesystem-safe.
 */
export interface PlatformInfo {
	id: string;
	label: string;
}

/** Every platform BansheeForge knows about, global across projects. */
export const PLATFORMS: readonly PlatformInfo[] = platformsJson as PlatformInfo[];

/** Platform that builds recorded before per-platform builds existed are attributed to. */
export const DEFAULT_PLATFORM = 'win32';

export function isKnownPlatform(id: string): boolean {
	return PLATFORMS.some(p => p.id === id);
}

export function getPlatformLabel(id: string): string {
	return PLATFORMS.find(p => p.id === id)?.label ?? id;
}
