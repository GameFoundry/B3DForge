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
  /** `{configId}/{platform}`, or just `{configId}` for a legacy single-platform workspace. */
  label: string;
  mtime: Date;
}

/**
 * Workspace cleanup service.
 *
 * With per-configuration, per-platform workspaces (not per-build), cleanup is simpler:
 * - Each configuration and platform pair has ONE workspace that's reused across builds
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
      const workspaces = await this.listWorkspaces(projectDir);
      const now = Date.now();

      for (const ws of workspaces) {
        const age = now - ws.mtime.getTime();

        // Delete if workspace hasn't been used in maxAgeMs
        if (age > this.config.maxAgeMs) {
          await fs.rm(ws.path, { recursive: true, force: true });
          deleted.push(ws.label);
          await removeIfEmpty(path.dirname(ws.path));
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
   * Every workspace under a project directory. A configuration directory holding a `.git` is a
   * legacy single-platform workspace; otherwise its children are the per-platform workspaces.
   */
  private async listWorkspaces(projectDir: string): Promise<WorkspaceInfo[]> {
    const workspaces: WorkspaceInfo[] = [];
    const configEntries = await fs.readdir(projectDir, { withFileTypes: true });

    for (const configEntry of configEntries) {
      if (!configEntry.isDirectory()) continue;
      const configDir = path.join(projectDir, configEntry.name);

      if (await exists(path.join(configDir, '.git'))) {
        const stat = await fs.stat(configDir);
        workspaces.push({ path: configDir, label: configEntry.name, mtime: stat.mtime });
        continue;
      }

      for (const platformEntry of await fs.readdir(configDir, { withFileTypes: true })) {
        if (!platformEntry.isDirectory()) continue;
        const workspacePath = path.join(configDir, platformEntry.name);
        const stat = await fs.stat(workspacePath);
        workspaces.push({
          path: workspacePath,
          label: `${configEntry.name}/${platformEntry.name}`,
          mtime: stat.mtime,
        });
      }
    }

    return workspaces;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Remove a configuration directory once its last platform workspace is gone. */
async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
  } catch {
    // Non-empty or already gone.
  }
}
