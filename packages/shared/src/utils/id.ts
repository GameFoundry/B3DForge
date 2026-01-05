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
