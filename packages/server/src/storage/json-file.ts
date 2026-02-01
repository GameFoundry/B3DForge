import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 100;

async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  delayMs = RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      // Only retry on transient Windows errors (file locked, permission denied)
      if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') {
        throw error;
      }
      lastError = err;
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

export class JsonFileStorage {
  constructor(private basePath: string) {}

  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async read<T>(filePath: string, defaultValue: T): Promise<T> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultValue;
      }
      throw error;
    }
  }

  async write<T>(filePath: string, data: T): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await this.ensureDir(path.dirname(fullPath));

    // Atomic write: write to temp file, then rename
    const tempPath = `${fullPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      // Retry rename on Windows file locking errors
      await retry(() => fs.rename(tempPath, fullPath));
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async delete(filePath: string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      await retry(() => fs.unlink(fullPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const fullPath = path.join(this.basePath, dirPath);
    try {
      await fs.rm(fullPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async readText(filePath: string): Promise<string | null> {
    const fullPath = path.join(this.basePath, filePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async writeText(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.basePath, filePath);
    await this.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
  }
}
