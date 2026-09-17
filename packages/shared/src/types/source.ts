/**
 * One submodule of the tree a root commit defines, at any depth. The root commit pins every
 * submodule (recursively) by gitlink; a build checks out exactly those pins.
 */
export interface SubmodulePin {
	/** Path relative to the workspace root, using forward slashes. */
	path: string;
	/** The `.gitmodules` name. */
	name: string;
	url: string;
	/** Nesting depth: 1 for a submodule of the root, 2 for its submodules, and so on. */
	depth: number;
	/** Commit the parent pins at this path. */
	pinned: string;
	/**
	 * Branch whose head the pin was compared with: the build branch when the submodule's remote
	 * has it, else the branch its `.gitmodules` entry names. Absent when neither exists; such a
	 * pin is not checked and never updated.
	 */
	branch?: string;
	/** Head of {@link branch} at inspection time. */
	head?: string;
	/** True when the branch head is not the pinned commit. */
	stale: boolean;
}

/** What `GET /projects/:slug/pins` reports for a branch. */
export interface PinInspection {
	branch: string;
	/** Head of the branch in the root repository (or the explicitly requested commit). */
	rootCommit: string;
	/** Every submodule of the tree, parents before children. */
	submodules: SubmodulePin[];
	inspectedAt: string;
}

/** Body of `POST /projects/:slug/pins/update`. */
export interface UpdatePinsInput {
	branch: string;
	/** Root head the inspection saw; the update is refused when the branch moved since. */
	expectedRootCommit: string;
}

/** One pin commit an update pushed. */
export interface PinUpdate {
	/** Repository that received the pin commit (empty path for the root). */
	path: string;
	name: string;
	/** Branch tip before and after. */
	from: string;
	to: string;
	/** Submodules the commit re-pinned, as `path -> commit`. */
	pins: Record<string, string>;
}

/** Result of `POST /projects/:slug/pins/update`. */
export interface UpdatePinsResult {
	branch: string;
	/** New head of the root branch; equals the expected commit when nothing was stale. */
	rootCommit: string;
	updates: PinUpdate[];
}

/** A repository of a resolved tree: the root or a submodule at the commit its parent pins. */
export interface TreeRepository {
	/** Path relative to the workspace root; empty for the root. */
	path: string;
	name: string;
	url: string;
	commit: string;
	depth: number;
}
