import { promises as fs } from 'fs';
import path from 'path';

export interface CleanupConfig {
  workspaceRoot: string;
  maxWorkspacesPerProject: number;  // Keep N most recent
  maxAgeMs: number;                 // Delete older than this
}

const DEFAULT_CONFIG: CleanupConfig = {
  workspaceRoot: '',
  maxWorkspacesPerProject: 5,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

interface WorkspaceInfo {
  path: string;
  buildId: string;
  mtime: Date;
}

export class WorkspaceCleanup {
  private config: CleanupConfig;

  constructor(config: Partial<CleanupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

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
          buildId: entry.name,
          mtime: stat.mtime,
        });
      }

      // Sort by modification time (newest first)
      workspaces.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      const now = Date.now();

      for (let i = 0; i < workspaces.length; i++) {
        const ws = workspaces[i];
        const age = now - ws.mtime.getTime();

        // Delete if: older than maxAge OR more than maxWorkspaces
        if (age > this.config.maxAgeMs || i >= this.config.maxWorkspacesPerProject) {
          await fs.rm(ws.path, { recursive: true, force: true });
          deleted.push(ws.buildId);
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
}
