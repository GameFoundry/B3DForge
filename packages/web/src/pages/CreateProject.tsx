import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useCreateProject } from '../hooks/useProjects';
import type { CreateProjectInput, ScriptType, ScriptConfig, BuildConfiguration, ConfigSchema, ProjectConfig } from '@banshee-forge/shared';

export function CreateProject() {
  const navigate = useNavigate();
  const createProject = useCreateProject();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('master');

  // Build script (always bash): 'repo' or 'local' (CI server)
  const [buildScriptSource, setBuildScriptSource] = useState<'repo' | 'local'>('local');
  const [buildScriptRepoPath, setBuildScriptRepoPath] = useState('.ci/build.sh');

  // Test script (optional, bash or powershell)
  const [hasTestScript, setHasTestScript] = useState(false);
  const [testScriptSource, setTestScriptSource] = useState<'repo' | 'local'>('local');
  const [testScriptRepoPath, setTestScriptRepoPath] = useState('.ci/test.sh');
  const [testScriptType, setTestScriptType] = useState<ScriptType>('bash');

  const [autoBuild, setAutoBuild] = useState(false);
  const [pollInterval, setPollInterval] = useState(300);

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Build script configuration for default config (always bash)
    const buildScript: ScriptConfig = { source: buildScriptSource };
    if (buildScriptSource === 'repo')
      buildScript.repoPath = buildScriptRepoPath;

    // Test script configuration (optional)
    let testScript: ScriptConfig | undefined;
    if (hasTestScript) {
      testScript = { source: testScriptSource };
      if (testScriptSource === 'repo')
        testScript.repoPath = testScriptRepoPath;
    }

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

    // Create a default configuration - server will assign the ID
    const now = new Date().toISOString();
    const defaultConfiguration: BuildConfiguration = {
      id: '', // Server will assign
      name: 'Default',
      description: 'Default build configuration',
      buildScript,
      testScript,
      testScriptType: hasTestScript ? testScriptType : undefined,
      configSchema,
      defaultConfig: defaultConfigValues,
      autoBuild: true,
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
      autoBuild,
      pollInterval,
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
              placeholder="https://github.com/user/repo.git"
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
            />
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

        {/* Build Script */}
        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-200 mb-4">Build Script (Bash)</h2>
          <p className="text-sm text-gray-500 -mt-2 mb-4">
            Build scripts are always executed via bash (Git Bash on Windows).
          </p>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Script Location</label>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  value="local"
                  checked={buildScriptSource === 'local'}
                  onChange={() => setBuildScriptSource('local')}
                  className="text-blue-500"
                />
                <span className="text-gray-300">CI Server</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  value="repo"
                  checked={buildScriptSource === 'repo'}
                  onChange={() => setBuildScriptSource('repo')}
                  className="text-blue-500"
                />
                <span className="text-gray-300">Repository</span>
              </label>
            </div>
          </div>

          {buildScriptSource === 'repo' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Script Path in Repository</label>
              <input
                type="text"
                value={buildScriptRepoPath}
                onChange={(e) => setBuildScriptRepoPath(e.target.value)}
                placeholder=".ci/build.sh"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-sm text-gray-500 mt-2">
                The script will be read from the cloned repository during each build.
              </p>
            </div>
          )}

          {buildScriptSource === 'local' && (
            <div className="bg-gray-700/50 rounded p-4">
              <p className="text-sm text-gray-300 mb-2">
                After creating the project, you can edit the build script in the <strong>Scripts</strong> tab.
              </p>
              <p className="text-xs text-gray-500">
                Stored at: <code className="text-gray-400">data/projects/{generateSlug(name) || '{slug}'}/build.sh</code>
              </p>
            </div>
          )}
        </div>

        {/* Test Script (Optional) */}
        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-gray-200">Test Script (Optional)</h2>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hasTestScript}
                onChange={(e) => setHasTestScript(e.target.checked)}
                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
              />
              <span className="text-sm text-gray-400">Enable test script</span>
            </label>
          </div>

          {hasTestScript && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-2">Script Type</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="bash"
                      checked={testScriptType === 'bash'}
                      onChange={() => setTestScriptType('bash')}
                      className="text-blue-500"
                    />
                    <span className="text-gray-300">Bash</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="powershell"
                      checked={testScriptType === 'powershell'}
                      onChange={() => setTestScriptType('powershell')}
                      className="text-blue-500"
                    />
                    <span className="text-gray-300">PowerShell</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Script Location</label>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="local"
                      checked={testScriptSource === 'local'}
                      onChange={() => setTestScriptSource('local')}
                      className="text-blue-500"
                    />
                    <span className="text-gray-300">CI Server</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      value="repo"
                      checked={testScriptSource === 'repo'}
                      onChange={() => setTestScriptSource('repo')}
                      className="text-blue-500"
                    />
                    <span className="text-gray-300">Repository</span>
                  </label>
                </div>
              </div>

              {testScriptSource === 'repo' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Script Path in Repository</label>
                  <input
                    type="text"
                    value={testScriptRepoPath}
                    onChange={(e) => setTestScriptRepoPath(e.target.value)}
                    placeholder={`.ci/test.${testScriptType === 'powershell' ? 'ps1' : 'sh'}`}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
                  />
                  <p className="text-sm text-gray-500 mt-2">
                    The script will be read from the cloned repository during each build.
                  </p>
                </div>
              )}

              {testScriptSource === 'local' && (
                <div className="bg-gray-700/50 rounded p-4">
                  <p className="text-sm text-gray-300 mb-2">
                    After creating the project, you can edit the test script in the <strong>Scripts</strong> tab.
                  </p>
                  <p className="text-xs text-gray-500">
                    Stored at: <code className="text-gray-400">
                      data/projects/{generateSlug(name) || '{slug}'}/test.{testScriptType === 'powershell' ? 'ps1' : 'sh'}
                    </code>
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Automation */}
        <div className="bg-gray-800 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-200 mb-4">Automation</h2>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={autoBuild}
              onChange={(e) => setAutoBuild(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500"
            />
            <span className="text-gray-300">Enable automatic builds on git changes</span>
          </label>

          {autoBuild && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Poll Interval (seconds)</label>
              <input
                type="number"
                value={pollInterval}
                onChange={(e) => setPollInterval(parseInt(e.target.value) || 300)}
                min={60}
                className="w-32 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
          )}
        </div>

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
