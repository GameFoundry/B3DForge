import http from 'http';
import https from 'https';
import { createReadStream, promises as fs } from 'fs';
import type { DeploymentFile } from '@banshee-forge/shared';
import { hashFile } from './deployment-inputs.js';

export interface DeployUploadOptions {
	orchestratorUrl: string;
	token: string;
	deploymentId: string;
	/** Absolute path of the file to send. */
	filePath: string;
	/** Path the orchestrator stores the file under, relative to the deploy directory. */
	relativePath: string;
	/** Called with the running byte count while the body streams. */
	onProgress?: (sentBytes: number, totalBytes: number) => void;
}

/**
 * Stream one deploy file to `POST /api/v1/agent/deployments/:id/files`. The file is hashed
 * first so the request can carry `X-Content-Sha256` and an exact `Content-Length`; the
 * orchestrator rejects the upload unless both match what arrived. Node's http client is used
 * rather than `fetch` so the body streams from disk with a fixed length instead of being
 * chunk-encoded or buffered.
 */
export async function uploadDeploymentFile(options: DeployUploadOptions): Promise<DeploymentFile> {
	const stat = await fs.stat(options.filePath);
	const sha256 = await hashFile(options.filePath);
	const url = new URL(`${options.orchestratorUrl.replace(/\/$/, '')}/api/v1/agent/deployments/${encodeURIComponent(options.deploymentId)}/files`);
	const transport = url.protocol === 'https:' ? https : http;

	await new Promise<void>((resolve, reject) => {
		const request = transport.request(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${options.token}`,
				'Content-Type': 'application/octet-stream',
				'Content-Length': stat.size,
				'X-Relative-Path': options.relativePath,
				'X-Content-Sha256': sha256,
			},
		}, response => {
			let body = '';
			response.setEncoding('utf-8');
			response.on('data', chunk => { body += chunk; });
			response.on('end', () => {
				if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
					resolve();
					return;
				}
				let message = body;
				try { message = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* plain text */ }
				reject(new Error(`HTTP ${response.statusCode ?? 0}: ${message || 'upload rejected'}`));
			});
			response.on('error', reject);
		});
		request.on('error', reject);

		let sent = 0;
		const source = createReadStream(options.filePath);
		source.on('data', (chunk: Buffer | string) => {
			sent += chunk.length;
			options.onProgress?.(sent, stat.size);
		});
		source.on('error', err => { request.destroy(err); reject(err); });
		source.pipe(request);
	});

	return { path: options.relativePath, size: stat.size, sha256 };
}
