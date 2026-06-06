import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useCreateProject } from '../hooks/useProjects';
import type { CreateProjectInput, BuildConfiguration, ConfigSchema, ProjectConfig } from '@banshee-forge/shared';

export function CreateProject() {
  const navigate = useNavigate();
  const createProject = useCreateProject();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('master');

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Default config schema and values for the configuration
    const configSchema: ConfigSchema = {
      buildType: {
        type: 'select',
        options: ['Debug', 'Release', 'RelWithDebInfo'],
        default: 'RelWithDebInfo',
        label: 'Build Type',
      },
      runTests: {
        type: 'boolean',
        default: true,
        label: 'Run Tests',
      },
    };

    const defaultConfigValues: ProjectConfig = {
      buildType: 'RelWithDebInfo',
      runTests: true,
    };

    // Create a default configuration - the build/test/fetch scripts and
    // automation settings are filled in from the project page after creation.
    const now = new Date().toISOString();
    const defaultConfiguration: BuildConfiguration = {
      id: '', // Server will assign
      name: 'Default',
      description: 'Default build configuration',
      buildScript: { source: 'local' },
      configSchema,
      defaultConfig: defaultConfigValues,
      createdAt: now,
      updatedAt: now,
    };

    const input: CreateProjectInput = {
      name,
      slug: generateSlug(name),
      description,
      gitUrl,
      gitBranch,
      configurations: [defaultConfiguration],
      autoBuild: false,
      pollInterval: 300,
    };

    try {
      const project = await createProject.mutateAsync(input);
      navigate(`/projects/${project.slug}`);
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <Link to="/" className="text-blue-400 hover:underline text-sm mb-4 inline-block">
        &larr; Back to dashboard
      </Link>

      <h1 className="text-2xl font-bold text-gray-100 mb-6">Create New Project</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-200 mb-4">Basic Information</h2>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Project Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="My Project"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {name && (
              <p className="text-sm text-gray-500 mt-1">
                Slug: <span className="font-mono">{generateSlug(name)}</span>
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A brief description of your project"
              rows={3}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Repository */}
        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-200 mb-4">Repository</h2>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Git URL *</label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              required
              placeholder="https://github.com/user/repo.git or D:/repos/my-project"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              A git URL (https / ssh / git) or a local file-system path to a repository.
            </p>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Branch</label>
            <input
              type="text"
              value={gitBranch}
              onChange={(e) => setGitBranch(e.target.value)}
              placeholder="master"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        <p className="text-sm text-gray-500">
          Build, test and fetch scripts and automation settings can be configured from the
          project page after it is created.
        </p>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Link
            to="/"
            className="px-4 py-2 text-gray-300 hover:text-gray-100"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={createProject.isPending || !name || !gitUrl}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50 flex items-center gap-2"
          >
            {createProject.isPending && (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            Create Project
          </button>
        </div>

        {createProject.isError && (
          <div className="text-red-400 text-sm">
            Error: {createProject.error.message}
          </div>
        )}
      </form>
    </div>
  );
}
