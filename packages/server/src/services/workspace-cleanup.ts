import { promises as fs } from 'fs';
import path from 'path';

export interface CleanupConfig {
  workspaceRoot: string;
  maxAgeMs: number;                 // Delete workspaces not accessed in this time
}

const DEFAULT_CONFIG: CleanupConfig = {
  workspaceRoot: '',
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days - workspaces are per-config now, so longer retention
};

interface WorkspaceInfo {
  path: string;
  configId: string;
  mtime: Date;
}

/**
 * Workspace cleanup service.
 *
 * With per-configuration workspaces (not per-build), cleanup is simpler:
 * - Each configuration has ONE workspace that's reused across builds
 * - We only delete workspaces that haven't been used in maxAgeMs
 * - Orphaned workspaces (config deleted) will naturally age out
 */
export class WorkspaceCleanup {
  private config: CleanupConfig;

  constructor(config: Partial<CleanupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Clean up old/unused workspaces for a specific project.
   * Deletes workspaces not accessed within maxAgeMs.
   */
  async cleanupProject(projectSlug: string): Promise<string[]> {
    const projectDir = path.join(this.config.workspaceRoot, projectSlug);
    const deleted: string[] = [];

    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      const workspaces: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const workspacePath = path.join(projectDir, entry.name);
        const stat = await fs.stat(workspacePath);
        workspaces.push({
          path: workspacePath,
          configId: entry.name,
          mtime: stat.mtime,
        });
      }

      const now = Date.now();

      for (const ws of workspaces) {
        const age = now - ws.mtime.getTime();

        // Delete if workspace hasn't been used in maxAgeMs
        if (age > this.config.maxAgeMs) {
          await fs.rm(ws.path, { recursive: true, force: true });
          deleted.push(ws.configId);
        }
      }
    } catch (err) {
      // Directory might not exist yet
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to cleanup workspaces for ${projectSlug}:`, err);
      }
    }

    return deleted;
  }

  /**
   * Clean up workspaces for all projects.
   */
  async cleanupAll(): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};

    try {
      const entries = await fs.readdir(this.config.workspaceRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        result[entry.name] = await this.cleanupProject(entry.name);
      }
    } catch (err) {
      console.error('Failed to cleanup workspaces:', err);
    }

    return result;
  }

  /**
   * Force delete a specific configuration's workspace.
   * Call this when a configuration is deleted.
   */
  async deleteConfigWorkspace(projectSlug: string, configId: string): Promise<boolean> {
    const workspacePath = path.join(this.config.workspaceRoot, projectSlug, configId);

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to delete workspace for ${projectSlug}/${configId}:`, err);
      }
      return false;
    }
  }
}
