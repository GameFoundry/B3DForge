export * from './types/index.js';
export * from './utils/index.js';

// Runtime values consumed by the web bundle must be re-exported by name: Rollup
// cannot statically resolve names re-exported through the CJS __exportStar helper.
export { DEFAULT_SNAPSHOT_CATEGORY } from './types/test.js';
export { DEFAULT_DEPLOY_BRANCH, DEFAULT_STAGING_BRANCH } from './types/project.js';
export { DEPLOY_SCRIPT_NAME, isValidBranchName } from './types/deployment.js';
export { initialPlatformSelection, reconcilePlatformSelection, togglePlatformSelection, defaultPlatformSelection } from './utils/platform-selection.js';
export { PLATFORMS, DEFAULT_PLATFORM, isKnownPlatform, getPlatformLabel } from './platforms.js';
export type { PlatformInfo } from './platforms.js';
