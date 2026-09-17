/** One `[submodule "name"]` section of a `.gitmodules` file. */
export interface GitmodulesEntry {
	name: string;
	path: string;
	url: string;
	/** Branch to follow, when the section declares one. */
	branch?: string;
	/** `update` policy, when declared (`none` marks an optional submodule that is never checked out). */
	update?: string;
}

/**
 * Parse the sections of a `.gitmodules` file. Sections without both `path` and `url` are dropped,
 * since Git cannot check them out either.
 */
export function parseGitmodules(text: string): GitmodulesEntry[] {
	const entries: GitmodulesEntry[] = [];
	let current: Partial<GitmodulesEntry> | null = null;

	const flush = () => {
		if (current && current.name !== undefined && current.path && current.url)
			entries.push({ name: current.name, path: current.path, url: current.url, branch: current.branch, update: current.update });
		current = null;
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;

		const section = line.match(/^\[submodule\s+"(.*)"\]$/);
		if (section) {
			flush();
			current = { name: section[1] };
			continue;
		}
		if (!current) continue;

		const assignment = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/);
		if (!assignment) continue;
		const key = assignment[1].toLowerCase();
		const value = assignment[2].trim();
		if (key === 'path') current.path = value.replace(/\\/g, '/').replace(/\/+$/, '');
		else if (key === 'url') current.url = value;
		else if (key === 'branch') current.branch = value;
		else if (key === 'update') current.update = value;
	}
	flush();

	return entries;
}

/**
 * Resolve a `.gitmodules` URL against the parent repository URL the way Git does: `../Foo.git`
 * names a sibling of the parent repository, `./Foo.git` a path beneath it.
 */
export function resolveSubmoduleUrl(parentUrl: string, submoduleUrl: string): string {
	if (!submoduleUrl.startsWith('./') && !submoduleUrl.startsWith('../')) return submoduleUrl;

	let base = parentUrl.replace(/\/+$/, '');
	let relative = submoduleUrl;
	while (relative.startsWith('../')) {
		relative = relative.slice(3);
		const up = Math.max(base.lastIndexOf('/'), base.lastIndexOf(':'));
		base = up >= 0 ? base.slice(0, up) : base;
	}
	if (relative.startsWith('./')) relative = relative.slice(2);
	return `${base}/${relative}`;
}
