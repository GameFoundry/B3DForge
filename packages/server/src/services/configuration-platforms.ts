import type { BuildConfiguration } from '@banshee-forge/shared';
import { PLATFORMS } from '@banshee-forge/shared';

/**
 * Platforms a configuration can be built for. An unset or empty `platforms` list means every
 * platform in `platforms.json`.
 */
export function resolveConfigurationPlatforms(configuration: BuildConfiguration | undefined): string[] {
	const declared = configuration?.platforms;
	if (declared && declared.length > 0) return [...declared];
	return PLATFORMS.map(p => p.id);
}
