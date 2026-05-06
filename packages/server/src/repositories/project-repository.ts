import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  BuildConfiguration,
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from '@banshee-forge/shared';
import { generateProjectId, generateConfigurationId, slugify } from '@banshee-forge/shared';
import { JsonFileStorage } from '../storage/json-file.js';

interface ProjectsFile {
  projects: Project[];
}

export interface ScriptInfo {
  content: string;
}

export class ProjectRepository {
  private readonly filePath = 'projects/projects.json';

  constructor(private storage: JsonFileStorage) {}

  async findAll(): Promise<Project[]> {
    const data = await this.storage.read<ProjectsFile>(this.filePath, { projects: [] });
    return data.projects;
  }

  async findById(id: string): Promise<Project | null> {
    const projects = await this.findAll();
    return projects.find(p => p.id === id) ?? null;
  }

  async findBySlug(slug: string): Promise<Project | null> {
    const projects = await this.findAll();
    return projects.find(p => p.slug === slug) ?? null;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const projects = await this.findAll();

    // Generate slug if not unique
    let slug = slugify(input.name);
    let suffix = 1;
    while (projects.some(p => p.slug === slug)) {
      slug = `${slugify(input.name)}-${suffix++}`;
    }

    const now = new Date().toISOString();

    // Process configurations - assign IDs to any that don't have them
    const configurations = (input.configurations ?? []).map(cfg => ({
      ...cfg,
      id: cfg.id || generateConfigurationId(),
      createdAt: cfg.createdAt || now,
      updatedAt: cfg.updatedAt || now,
    }));

    // Set defaultConfigurationId if not provided
    const defaultConfigurationId = input.defaultConfigurationId
      ?? (configurations.length > 0 ? configurations[0].id : undefined);

    const project: Project = {
      ...input,
      id: generateProjectId(),
      slug,
      configurations,
      defaultConfigurationId,
      createdAt: now,
      updatedAt: now,
    };

    projects.push(project);
    await this.storage.write<ProjectsFile>(this.filePath, { projects });

    return project;
  }

  async update(slug: string, input: UpdateProjectInput): Promise<Project | null> {
    const data = await this.storage.read<ProjectsFile>(this.filePath, { projects: [] });
    const index = data.projects.findIndex(p => p.slug === slug);

    if (index === -1) return null;

    const updated: Project = {
      ...data.projects[index],
      ...input,
      updatedAt: new Date().toISOString(),
    };

    data.projects[index] = updated;
    await this.storage.write<ProjectsFile>(this.filePath, data);

    return updated;
  }

  async delete(slug: string): Promise<boolean> {
    const data = await this.storage.read<ProjectsFile>(this.filePath, { projects: [] });
    const index = data.projects.findIndex(p => p.slug === slug);

    if (index === -1) return false;

    data.projects.splice(index, 1);
    await this.storage.write<ProjectsFile>(this.filePath, data);

    // Also delete project-specific data
    await this.storage.deleteDir(`projects/${slug}`);
    await this.storage.deleteDir(`builds/${slug}`);

    return true;
  }


  // ============================================
  // Configuration CRUD methods
  // ============================================

  async getConfigurations(slug: string): Promise<BuildConfiguration[]> {
    const project = await this.findBySlug(slug);
    if (!project) return [];
    return project.configurations ?? [];
  }

  async getConfiguration(slug: string, configId: string): Promise<BuildConfiguration | null> {
    const project = await this.findBySlug(slug);
    if (!project) return null;
    return project.configurations?.find(c => c.id === configId) ?? null;
  }

  async createConfiguration(slug: string, input: CreateConfigurationInput): Promise<BuildConfiguration | null> {
    const project = await this.findBySlug(slug);
    if (!project) return null;

    const now = new Date().toISOString();
    const config: BuildConfiguration = {
      ...input,
      id: generateConfigurationId(),
      createdAt: now,
      updatedAt: now,
    };

    const configurations = [...(project.configurations ?? []), config];
    const defaultConfigurationId = project.defaultConfigurationId ?? config.id;

    await this.update(slug, { configurations, defaultConfigurationId });
    return config;
  }

  async updateConfiguration(
    slug: string,
    configId: string,
    input: UpdateConfigurationInput
  ): Promise<BuildConfiguration | null> {
    const project = await this.findBySlug(slug);
    if (!project) return null;

    const configurations = project.configurations ?? [];
    const index = configurations.findIndex(c => c.id === configId);
    if (index === -1) return null;

    const updated: BuildConfiguration = {
      ...configurations[index],
      ...input,
      updatedAt: new Date().toISOString(),
    };

    configurations[index] = updated;
    await this.update(slug, { configurations });
    return updated;
  }

  async deleteConfiguration(slug: string, configId: string): Promise<boolean> {
    const project = await this.findBySlug(slug);
    if (!project) return false;

    const configurations = project.configurations ?? [];
    const index = configurations.findIndex(c => c.id === configId);
    if (index === -1) return false;

    // Cannot delete the last configuration
    if (configurations.length === 1)
      throw new Error('Cannot delete the only configuration');

    configurations.splice(index, 1);

    // Update defaultConfigurationId if we deleted it
    let defaultConfigurationId = project.defaultConfigurationId;
    if (defaultConfigurationId === configId)
      defaultConfigurationId = configurations[0].id;

    await this.update(slug, { configurations, defaultConfigurationId });

    // Delete configuration scripts
    await this.storage.deleteDir(`projects/${slug}/configs/${configId}`);

    return true;
  }

  // ============================================
  // Configuration-aware script methods
  // ============================================

  async getConfigurationBuildScript(slug: string, configId: string): Promise<string | null> {
    return this.storage.readText(`projects/${slug}/configs/${configId}/build.sh`);
  }

  async saveConfigurationBuildScript(slug: string, configId: string, content: string): Promise<void> {
    await this.storage.writeText(`projects/${slug}/configs/${configId}/build.sh`, content);
  }

  async getConfigurationTestScript(slug: string, configId: string): Promise<ScriptInfo | null> {
    const content = await this.storage.readText(`projects/${slug}/configs/${configId}/test.sh`);
    if (content === null) return null;
    return { content };
  }

  async saveConfigurationTestScript(
    slug: string,
    configId: string,
    content: string
  ): Promise<void> {
    await this.storage.writeText(`projects/${slug}/configs/${configId}/test.sh`, content);
  }

  async deleteConfigurationTestScript(slug: string, configId: string): Promise<void> {
    await this.storage.delete(`projects/${slug}/configs/${configId}/test.sh`);
  }

  // ============================================
  // Fetch script methods (always local bash)
  // ============================================

  /**
   * Project-level fetch script. Used by every configuration that does not
   * set `overrideFetchScript` to true.
   */
  async getProjectFetchScript(slug: string): Promise<string | null> {
    return this.storage.readText(`projects/${slug}/fetch.sh`);
  }

  async saveProjectFetchScript(slug: string, content: string): Promise<void> {
    await this.storage.writeText(`projects/${slug}/fetch.sh`, content);
  }

  async deleteProjectFetchScript(slug: string): Promise<void> {
    await this.storage.delete(`projects/${slug}/fetch.sh`);
  }

  /**
   * Per-configuration fetch script. Only used when the configuration sets
   * `overrideFetchScript` to true.
   */
  async getConfigurationFetchScript(slug: string, configId: string): Promise<string | null> {
    return this.storage.readText(`projects/${slug}/configs/${configId}/fetch.sh`);
  }

  async saveConfigurationFetchScript(slug: string, configId: string, content: string): Promise<void> {
    await this.storage.writeText(`projects/${slug}/configs/${configId}/fetch.sh`, content);
  }

  async deleteConfigurationFetchScript(slug: string, configId: string): Promise<void> {
    await this.storage.delete(`projects/${slug}/configs/${configId}/fetch.sh`);
  }
}
