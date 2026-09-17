import type { Build, BuildConfiguration, BuildGroup, Project, ProjectConfig, TriggerType } from '@banshee-forge/shared';
import { generateBuildGroupId } from '@banshee-forge/shared';
import { BuildRepository } from '../repositories/build-repository.js';
import { BuildGroupRepository } from '../repositories/build-group-repository.js';
import { BuildOrchestrator } from './build-orchestrator.js';
import { SubmodulePinService } from './submodule-pin-service.js';

export interface TriggerGroupInput {
	project: Project;
	configuration: BuildConfiguration;
	/** Fixed group membership: exactly these platforms, in this order. */
	platforms: string[];
	triggerType: TriggerType;
	triggeredBy?: string;
	gitBranch?: string;
	gitCommit?: string;
	config?: ProjectConfig;
	cleanBuild?: boolean;
	autoDeploy?: boolean;
	priority?: number;
}

export interface TriggeredGroup {
	group: BuildGroup;
	builds: Build[];
}

/**
 * The single path that turns a trigger (manual, polling) into builds. Resolves the root commit
 * once for the whole group (every submodule is pinned by it), records the group with its
 * complete membership, creates every member, and only then queues them, so no member can
 * finish before the group exists.
 */
export class BuildTriggerService {
	constructor(
		private buildRepo: BuildRepository,
		private groupRepo: BuildGroupRepository,
		private orchestrator: BuildOrchestrator,
		private pins: SubmodulePinService,
	) {}

	async triggerGroup(input: TriggerGroupInput): Promise<TriggeredGroup> {
		const { project, configuration } = input;
		const branch = input.gitBranch || configuration.gitBranch || project.gitBranch;
		const rootCommit = await this.pins.resolveRootCommit(project.gitUrl, branch, input.gitCommit);

		const group: BuildGroup = {
			id: generateBuildGroupId(),
			projectSlug: project.slug,
			configurationId: configuration.id,
			buildIds: [],
			platforms: [...input.platforms],
			gitBranch: branch,
			rootCommit,
			triggerType: input.triggerType,
			triggeredBy: input.triggeredBy,
			autoDeploy: input.autoDeploy ?? false,
			createdAt: new Date().toISOString(),
		};

		const builds: Build[] = [];
		for (const platform of input.platforms) {
			const build = await this.buildRepo.create(project.slug, {
				configurationId: configuration.id,
				gitBranch: branch,
				gitCommit: rootCommit,
				config: input.config ?? configuration.defaultConfig ?? {},
				triggeredBy: input.triggeredBy,
				cleanBuild: input.cleanBuild,
			}, input.triggerType, configuration.name, platform, { groupId: group.id });
			builds.push(build);
			group.buildIds.push(build.id);
		}

		await this.groupRepo.save(group);

		for (const build of builds)
			await this.orchestrator.triggerBuild(project.slug, build.id, input.priority ?? 0);

		return { group, builds };
	}
}
