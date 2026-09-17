import { execFile } from 'child_process';

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface GitOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Extra `-c key=value` configuration applied to this invocation only. */
	config?: Record<string, string>;
}

/** Thrown by {@link git} when the command exits non-zero. */
export class GitError extends Error {
	constructor(public readonly args: string[], public readonly result: GitResult, cwd?: string) {
		super(`git ${args.join(' ')} failed (exit ${result.exitCode})${cwd ? ` in ${cwd}` : ''}: ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = 'GitError';
	}
}

/** Run git and capture its output without raising on failure. */
export function gitRaw(args: string[], options: GitOptions = {}): Promise<GitResult> {
	const configArgs = Object.entries(options.config ?? {}).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
	return new Promise((resolve) => {
		execFile('git', [...configArgs, ...args], {
			cwd: options.cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
			timeout: options.timeoutMs ?? 10 * 60 * 1000,
			windowsHide: true,
			maxBuffer: 64 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			const exitCode = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code as number | undefined) ?? 1 : 0;
			resolve({ exitCode: typeof exitCode === 'number' ? exitCode : 1, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** Run git and return trimmed stdout. Throws {@link GitError} on a non-zero exit. */
export async function git(args: string[], options: GitOptions = {}): Promise<string> {
	const result = await gitRaw(args, options);
	if (result.exitCode !== 0) throw new GitError(args, result, options.cwd);
	return result.stdout.trim();
}

/** Resolve the tip of a remote branch without a local clone, or null if the branch does not exist. */
export async function gitRemoteBranchHead(url: string, branch: string, options: GitOptions = {}): Promise<string | null> {
	const output = await git(['ls-remote', '--heads', url, `refs/heads/${branch}`], { timeoutMs: 60_000, ...options });
	// One line per matching ref: "<sha>\trefs/heads/<branch>". Exact ref match, as ls-remote also
	// matches branches whose names end with the pattern.
	for (const line of output.split('\n')) {
		const [sha, ref] = line.split('\t');
		if (ref === `refs/heads/${branch}` && sha) return sha;
	}
	return null;
}

export function isFullSha(value: string): boolean {
	return /^[0-9a-f]{40}$/.test(value);
}
