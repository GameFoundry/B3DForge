import { promises as fs } from 'fs';
import path from 'path';

export interface UploadResultsOptions {
	orchestratorUrl: string;
	token: string;
	projectSlug: string;
	buildId: string;
	resultsDir: string;
	/** Maximum size of any single file to upload, in bytes. Files larger than this are skipped. */
	maxFileBytes?: number;
}

export interface UploadResultsSummary {
	uploaded: number;
	skipped: number;
	failed: number;
}

/**
 * Recursively upload every file under `resultsDir` to the orchestrator. Each file is sent
 * as a separate POST with `Content-Type: application/octet-stream` and an `X-Relative-Path`
 * header carrying its path relative to `resultsDir`. The orchestrator writes them under
 * `{dataPath}/projects/{slug}/builds/{buildId}/results/...`, where `TestResultsService`
 * picks them up.
 *
 * Failures are logged but don't throw — a partial upload is better than no test results.
 */
export async function uploadResults(opts: UploadResultsOptions): Promise<UploadResultsSummary> {
	const summary: UploadResultsSummary = { uploaded: 0, skipped: 0, failed: 0 };
	const maxFileBytes = opts.maxFileBytes ?? 80 * 1024 * 1024;

	let entries: string[];
	try {
		entries = await listFilesRecursive(opts.resultsDir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return summary;
		throw err;
	}

	if (entries.length === 0) return summary;

	const baseUrl = opts.orchestratorUrl.replace(/\/$/, '');
	const url = `${baseUrl}/api/v1/agent/projects/${encodeURIComponent(opts.projectSlug)}/builds/${encodeURIComponent(opts.buildId)}/result-file`;

	for (const absPath of entries) {
		const relPath = path.relative(opts.resultsDir, absPath).split(path.sep).join('/');
		try {
			const stat = await fs.stat(absPath);
			if (stat.size > maxFileBytes) {
				console.warn(`[results-upload] skipping ${relPath} (${stat.size} bytes > ${maxFileBytes})`);
				summary.skipped++;
				continue;
			}

			const body = await fs.readFile(absPath);
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${opts.token}`,
					'Content-Type': 'application/octet-stream',
					'X-Relative-Path': relPath,
				},
				body,
			});

			if (!response.ok) {
				console.warn(`[results-upload] ${relPath} -> HTTP ${response.status}`);
				summary.failed++;
			} else {
				summary.uploaded++;
			}
		} catch (err) {
			console.warn(`[results-upload] ${relPath} failed:`, err);
			summary.failed++;
		}
	}

	return summary;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				out.push(full);
			}
		}
	}
	return out;
}
