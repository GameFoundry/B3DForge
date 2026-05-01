import { randomBytes } from 'crypto';

/** Generate a prefixed unique ID */
export function generateId(prefix: string): string {
  const random = randomBytes(6).toString('base64url');
  return `${prefix}-${random}`;
}

/** Generate project ID */
export const generateProjectId = () => generateId('proj');

/** Generate build ID */
export const generateBuildId = () => generateId('build');

/** Generate configuration ID */
export const generateConfigurationId = () => generateId('cfg');

/** Generate watched repository ID */
export const generateWatchedRepoId = () => generateId('repo');

/** Generate user ID */
export const generateUserId = () => generateId('user');

/** Generate session ID (256-bit random, no prefix) */
export const generateSessionId = () => randomBytes(32).toString('base64url');

/** Generate agent token record ID */
export const generateAgentTokenId = () => generateId('agt');
