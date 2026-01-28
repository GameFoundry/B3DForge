import { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import type { ScriptSource } from '@banshee-forge/shared';

interface ScriptEditorProps {
  title: string;
  description?: string;
  placeholder?: string;
  fileName?: string;
  configId?: string;
  script: string;
  source?: ScriptSource;
  repoPath?: string;
  onSave: (script: string) => void;
  onSourceChange?: (source: ScriptSource, repoPath?: string) => void;
  onDelete?: () => void;
  isSaving?: boolean;
  isDeleting?: boolean;
  isSourceSaving?: boolean;
  isTestScript?: boolean;
  readOnly?: boolean;
}

export function ScriptEditor({
  title,
  description,
  placeholder,
  fileName,
  configId,
  script: initialScript,
  source: initialSource = 'local',
  repoPath: initialRepoPath = '',
  onSave,
  onSourceChange,
  onDelete,
  isSaving = false,
  isDeleting = false,
  isSourceSaving = false,
  isTestScript = false,
  readOnly = false,
}: ScriptEditorProps) {
  const [script, setScript] = useState(initialScript);
  const [source, setSource] = useState<ScriptSource>(initialSource);
  const [repoPath, setRepoPath] = useState(initialRepoPath);
  const [hasScriptChanges, setHasScriptChanges] = useState(false);
  const [hasSourceChanges, setHasSourceChanges] = useState(false);

  useEffect(() => {
    setScript(initialScript);
    setHasScriptChanges(false);
  }, [initialScript]);

  useEffect(() => {
    setSource(initialSource);
    setRepoPath(initialRepoPath);
    setHasSourceChanges(false);
  }, [initialSource, initialRepoPath]);

  const handleScriptChange = (value: string) => {
    setScript(value);
    setHasScriptChanges(true);
  };

  const handleSaveScript = () => {
    onSave(script);
    setHasScriptChanges(false);
  };

  const handleSourceChange = (newSource: ScriptSource) => {
    setSource(newSource);
    setHasSourceChanges(true);
  };

  const handleRepoPathChange = (path: string) => {
    setRepoPath(path);
    setHasSourceChanges(true);
  };

  const handleSaveSourceChange = () => {
    if (onSourceChange) {
      onSourceChange(source, source === 'repo' ? repoPath : undefined);
      setHasSourceChanges(false);
    }
  };

  const isLocalSource = source === 'local';

  // Shell language extension for bash
  const languageExtension = StreamLanguage.define(shell);

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-medium text-gray-100">{title}</h3>
              {!isTestScript && (
                <span className="text-xs px-2 py-1 bg-blue-900/50 rounded text-blue-300">
                  Bash
                </span>
              )}
            </div>
            {description && (
              <p className="text-sm text-gray-400 mt-0.5">{description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onDelete && isLocalSource && !readOnly && (
            <button
              onClick={onDelete}
              disabled={isDeleting}
              className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded disabled:opacity-50"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          )}
        </div>
      </div>

      {/* Source Toggle */}
      {onSourceChange && !readOnly && (
        <div className="px-4 py-3 border-b border-gray-700 bg-gray-900/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-400">Source:</span>
              <div className="flex rounded-lg overflow-hidden border border-gray-600">
                <button
                  type="button"
                  onClick={() => handleSourceChange('local')}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    isLocalSource
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  CI Server
                </button>
                <button
                  type="button"
                  onClick={() => handleSourceChange('repo')}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    source === 'repo'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Repository
                </button>
              </div>
            </div>
            {hasSourceChanges && (
              <button
                onClick={handleSaveSourceChange}
                disabled={isSourceSaving || (source === 'repo' && !repoPath.trim())}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded disabled:opacity-50 flex items-center gap-2"
              >
                {isSourceSaving && (
                  <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                Apply
              </button>
            )}
          </div>

          {/* Repo Path Input */}
          {source === 'repo' && (
            <div className="mt-3">
              <label className="block text-sm text-gray-400 mb-1">Path in Repository</label>
              <input
                type="text"
                value={repoPath}
                onChange={(e) => handleRepoPathChange(e.target.value)}
                placeholder={isTestScript ? '.ci/test.sh' : '.ci/build.sh'}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                Path relative to the repository root (e.g., .ci/build.sh or scripts/test.sh)
              </p>
            </div>
          )}
        </div>
      )}

      {/* Script Editor or Repo Info */}
      {isLocalSource ? (
        <>
          <div className="relative">
            <CodeMirror
              value={script}
              onChange={handleScriptChange}
              extensions={[languageExtension]}
              editable={!readOnly}
              placeholder={!readOnly ? (placeholder ?? `Enter your ${isTestScript ? 'test' : 'build'} script here...`) : ''}
              theme="dark"
              height="320px"
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                highlightActiveLine: true,
                foldGutter: true,
                autocompletion: false,
              }}
              className="text-sm [&_.cm-editor]:!bg-gray-900 [&_.cm-gutters]:!bg-gray-900 [&_.cm-gutters]:!border-gray-700"
            />
          </div>

          {/* Save button and file path */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700 bg-gray-900/50">
            <p className="text-xs text-gray-500">
              File: <code className="text-gray-400">configs/{configId ?? '[configId]'}/{fileName ?? (isTestScript ? 'test.sh' : 'build.sh')}</code>
            </p>
            {!readOnly && (
              <button
                onClick={handleSaveScript}
                disabled={isSaving || !hasScriptChanges}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded disabled:opacity-50 flex items-center gap-2"
              >
                {isSaving && (
                  <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                {hasScriptChanges ? 'Save Script' : 'Saved'}
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="px-4 py-6 bg-gray-900/50">
          <div className="flex items-center gap-3 text-gray-300">
            <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <div>
              <p className="text-sm">Script loaded from repository:</p>
              <code className="text-blue-400 text-sm">{repoPath || '(no path set)'}</code>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            The script will be read from the cloned repository during each build.
            Your CI server script is preserved and can be restored by switching back to "CI Server".
          </p>
        </div>
      )}
    </div>
  );
}
