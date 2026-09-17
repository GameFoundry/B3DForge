import type { BuildGroup } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

/**
 * Persists build groups at `builds/{slug}/groups/{groupId}.json`. A group is written complete
 * before any of its builds is queued, so a fast completion can never observe a partial group.
 */
export class BuildGroupRepository {
	constructor(private storage: JsonFileStorage) {}

	private filePath(projectSlug: string, groupId: string): string {
		return `builds/${projectSlug}/groups/${groupId}.json`;
	}

	async findById(projectSlug: string, groupId: string): Promise<BuildGroup | null> {
		return this.storage.read<BuildGroup | null>(this.filePath(projectSlug, groupId), null);
	}

	async save(group: BuildGroup): Promise<void> {
		await this.storage.write(this.filePath(group.projectSlug, group.id), group);
	}

	async update(projectSlug: string, groupId: string, updates: Partial<BuildGroup>): Promise<BuildGroup | null> {
		const group = await this.findById(projectSlug, groupId);
		if (!group) return null;
		Object.assign(group, updates);
		await this.save(group);
		return group;
	}
}
