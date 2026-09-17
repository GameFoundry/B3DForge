import { promises as fs } from 'fs';
import path from 'path';
import type { AgentFilesSentEvent, DeployFilesRequest, DeploymentFile } from '@banshee-forge/shared';
import { DEPLOY_DIR_NAME } from './deployment-inputs.js';
import { uploadDeploymentFile } from './deploy-uploader.js';

export interface FileSenderConfig {
	orchestratorUrl: string;
	token: string;
	/** Root of the per-build directories holding `deploy/`. */
	buildsRoot: string;
}

/**
 * Answers a `deploy:send-files` request: streams every listed file of a build's deploy
 * directory to the orchestrator, one after another, and reports the outcome. Nothing is
 * executed on the agent; the orchestrator verifies each file against the hash recorded when
 * the build finished.
 */
export class FileSender {
	readonly buildId: string;
	private cancelled = false;

	constructor(private readonly request: DeployFilesRequest, private readonly config: FileSenderConfig) {
		this.buildId = request.buildId;
	}

	cancel(): void {
		this.cancelled = true;
	}

	async run(): Promise<AgentFilesSentEvent> {
		const deployDir = path.join(this.config.buildsRoot, this.request.buildId, DEPLOY_DIR_NAME);
		const sent: DeploymentFile[] = [];
		const failed = (error: string): AgentFilesSentEvent => ({ deploymentId: this.request.deploymentId, status: 'failed', sent, error });

		for (const file of this.request.files) {
			if (this.cancelled) return failed('Transfer cancelled');

			const filePath = path.resolve(deployDir, file.path);
			if (!filePath.startsWith(deployDir + path.sep)) return failed(`Refusing path outside the deploy directory: ${file.path}`);
			try {
				await fs.access(filePath);
			} catch {
				return failed(`${file.path} no longer exists on the agent; the build's files were removed`);
			}

			try {
				let lastLogged = 0;
				const uploaded = await uploadDeploymentFile({
					orchestratorUrl: this.config.orchestratorUrl,
					token: this.config.token,
					deploymentId: this.request.deploymentId,
					filePath,
					relativePath: file.path,
					onProgress: (sentBytes, totalBytes) => {
						// One console line per 256 MiB keeps large archives visible without flooding the log.
						if (sentBytes - lastLogged >= 256 * 1024 ** 2 || sentBytes === totalBytes) {
							lastLogged = sentBytes;
							console.log(`[deploy-files] ${file.path}: ${(sentBytes / 1024 ** 2).toFixed(0)}/${(totalBytes / 1024 ** 2).toFixed(0)} MiB`);
						}
					},
				});
				sent.push(uploaded);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return failed(`Upload of ${file.path} failed: ${message}`);
			}
		}
		return { deploymentId: this.request.deploymentId, status: 'success', sent };
	}
}
