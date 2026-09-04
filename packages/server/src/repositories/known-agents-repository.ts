import type { AgentRegistration, KnownAgent } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

interface KnownAgentsFile {
	agents: KnownAgent[];
}

const FILE_PATH = 'known-agents.json';

/**
 * Persists every agent that has ever registered, keyed by name. Live agents are tracked by
 * `AgentRegistry`; this record is what lets the UI offer a platform whose only agent is
 * currently offline (typically a laptop that is asleep), so a build can be queued and wait for
 * the agent to come back.
 */
export class KnownAgentsRepository {
	constructor(private storage: JsonFileStorage) {}

	async list(): Promise<KnownAgent[]> {
		const data = await this.storage.read<KnownAgentsFile>(FILE_PATH, { agents: [] });
		return data.agents;
	}

	/** Insert or refresh the record for a registering agent. Returns the stored entry. */
	async upsert(registration: AgentRegistration): Promise<KnownAgent> {
		const data = await this.storage.read<KnownAgentsFile>(FILE_PATH, { agents: [] });
		const now = new Date().toISOString();
		const existing = data.agents.find(a => a.name === registration.name);

		const entry: KnownAgent = {
			name: registration.name,
			platform: registration.platform,
			arch: registration.arch,
			hostname: registration.hostname,
			platforms: [...registration.platforms],
			labels: [...registration.labels],
			firstSeenAt: existing?.firstSeenAt ?? now,
			lastSeenAt: now,
		};

		if (existing) {
			Object.assign(existing, entry);
		} else {
			data.agents.push(entry);
		}

		await this.storage.write<KnownAgentsFile>(FILE_PATH, data);
		return entry;
	}

	/** Touch `lastSeenAt` for an agent that is disconnecting, so "last seen" reflects the drop. */
	async touch(name: string): Promise<void> {
		const data = await this.storage.read<KnownAgentsFile>(FILE_PATH, { agents: [] });
		const existing = data.agents.find(a => a.name === name);
		if (!existing) return;
		existing.lastSeenAt = new Date().toISOString();
		await this.storage.write<KnownAgentsFile>(FILE_PATH, data);
	}

	async remove(name: string): Promise<boolean> {
		const data = await this.storage.read<KnownAgentsFile>(FILE_PATH, { agents: [] });
		const before = data.agents.length;
		data.agents = data.agents.filter(a => a.name !== name);
		if (data.agents.length === before) return false;
		await this.storage.write<KnownAgentsFile>(FILE_PATH, data);
		return true;
	}
}
