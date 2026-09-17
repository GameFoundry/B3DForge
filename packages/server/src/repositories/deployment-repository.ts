import path from 'path';
import type { Deployment, DeploymentStatus, PromotionRecord } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

/** Index entry, enough to list deployments without opening every detail file. */
export interface DeploymentIndexEntry {
	id: string;
	buildId: string;
	groupId?: string;
	platform: string;
	status: DeploymentStatus;
	rootCommit: string;
	targetBranch?: string;
	createdAt: string;
	finishedAt?: string;
}

interface DeploymentsIndexFile {
	deployments: DeploymentIndexEntry[];
}

/**
 * Persists deployments under `deployments/{slug}/{deploymentId}/` (detail, log, received deploy
 * files, produced artifacts) and promotion journals under `deployments/{slug}/promotions/`
 * keyed by root commit and target branch.
 */
export class DeploymentRepository {
	constructor(private storage: JsonFileStorage) {}

	private indexPath(projectSlug: string): string {
		return `deployments/${projectSlug}/index.json`;
	}

	private detailPath(projectSlug: string, deploymentId: string): string {
		return `deployments/${projectSlug}/${deploymentId}/deployment.json`;
	}

	/** Absolute directory holding a deployment's files. */
	directory(projectSlug: string, deploymentId: string): string {
		return path.join(this.storage.getBasePath(), 'deployments', projectSlug, deploymentId);
	}

	/** Absolute directory the agent's deploy files land in; `deploy.sh` runs with it as `DEPLOY_DIR`. */
	inputsDirectory(projectSlug: string, deploymentId: string): string {
		return path.join(this.directory(projectSlug, deploymentId), 'inputs');
	}

	/** Absolute directory `deploy.sh` leaves its artifacts in (`DEPLOY_OUTPUT_DIR`). */
	outputDirectory(projectSlug: string, deploymentId: string): string {
		return path.join(this.directory(projectSlug, deploymentId), 'output');
	}

	async findById(projectSlug: string, deploymentId: string): Promise<Deployment | null> {
		return this.storage.read<Deployment | null>(this.detailPath(projectSlug, deploymentId), null);
	}

	async list(projectSlug: string): Promise<DeploymentIndexEntry[]> {
		const data = await this.storage.read<DeploymentsIndexFile>(this.indexPath(projectSlug), { deployments: [] });
		return [...data.deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async listForBuild(projectSlug: string, buildId: string): Promise<Deployment[]> {
		const entries = (await this.list(projectSlug)).filter(e => e.buildId === buildId);
		const deployments: Deployment[] = [];
		for (const entry of entries) {
			const deployment = await this.findById(projectSlug, entry.id);
			if (deployment) deployments.push(deployment);
		}
		return deployments;
	}

	async save(deployment: Deployment): Promise<void> {
		// Detail first (source of truth), then the index that can be rebuilt from it.
		await this.storage.write(this.detailPath(deployment.projectSlug, deployment.id), deployment);

		const indexPath = this.indexPath(deployment.projectSlug);
		const data = await this.storage.read<DeploymentsIndexFile>(indexPath, { deployments: [] });
		const entry: DeploymentIndexEntry = {
			id: deployment.id,
			buildId: deployment.buildId,
			groupId: deployment.groupId,
			platform: deployment.platform,
			status: deployment.status,
			rootCommit: deployment.rootCommit,
			targetBranch: deployment.targetBranch,
			createdAt: deployment.createdAt,
			finishedAt: deployment.finishedAt,
		};
		const index = data.deployments.findIndex(e => e.id === deployment.id);
		if (index === -1) data.deployments.push(entry);
		else data.deployments[index] = entry;
		await this.storage.write(indexPath, data);
	}

	async appendLog(projectSlug: string, deploymentId: string, content: string): Promise<void> {
		await this.storage.appendText(`deployments/${projectSlug}/${deploymentId}/log.txt`, content);
	}

	async getLog(projectSlug: string, deploymentId: string): Promise<string | null> {
		return this.storage.readText(`deployments/${projectSlug}/${deploymentId}/log.txt`);
	}

	/* ─────────── promotion journal ─────────── */

	/** One journal per root commit and target branch; branch names may contain `/`, so they are encoded. */
	private promotionPath(projectSlug: string, rootCommit: string, targetBranch: string): string {
		return `deployments/${projectSlug}/promotions/${rootCommit}/${encodeURIComponent(targetBranch)}.json`;
	}

	async findPromotion(projectSlug: string, rootCommit: string, targetBranch: string): Promise<PromotionRecord | null> {
		return this.storage.read<PromotionRecord | null>(this.promotionPath(projectSlug, rootCommit, targetBranch), null);
	}

	async savePromotion(projectSlug: string, record: PromotionRecord): Promise<void> {
		await this.storage.write(this.promotionPath(projectSlug, record.rootCommit, record.targetBranch), record);
	}
}
