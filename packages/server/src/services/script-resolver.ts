import { promises as fs } from 'fs';
import path from 'path';
import type { BuildConfiguration, Project, ScriptConfig, ScriptPayload } from '@banshee-forge/shared';

/**
 * Turns script configurations into deliverable payloads: inline bodies for scripts stored on the
 * orchestrator, repository paths for scripts read from the checkout.
 */
export class ScriptResolver {
	constructor(private readonly dataPath: string) {}

	/** Fetch scripts are always stored on the orchestrator: per configuration when overridden, else per project. */
	async fetchScript(project: Project, configuration: BuildConfiguration): Promise<ScriptPayload | null> {
		const fetchPath = configuration.overrideFetchScript
			? path.join(this.dataPath, 'projects', project.slug, 'configs', configuration.id, 'fetch.sh')
			: path.join(this.dataPath, 'projects', project.slug, 'fetch.sh');
		return this.readInline(fetchPath);
	}

	async scriptPayload(config: ScriptConfig, projectSlug: string, configurationId: string, defaultFilename: string): Promise<ScriptPayload | null> {
		switch (config.source) {
			case 'repo': {
				if (!config.repoPath) return null;
				return { kind: 'repo', repoPath: config.repoPath };
			}
			case 'custom': {
				if (!config.customPath) return null;
				return this.readInline(config.customPath);
			}
			case 'local':
			default: {
				const localPath = path.join(this.dataPath, 'projects', projectSlug, 'configs', configurationId, defaultFilename);
				return this.readInline(localPath);
			}
		}
	}

	async readInline(filePath: string): Promise<ScriptPayload | null> {
		try {
			const body = await fs.readFile(filePath, 'utf-8');
			return { kind: 'inline', body };
		} catch {
			return null;
		}
	}
}
