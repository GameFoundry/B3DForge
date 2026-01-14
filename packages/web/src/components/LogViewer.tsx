import { useState, useEffect, useRef, useMemo } from 'react';
import type { LogLine } from '@banshee-forge/shared';

interface LogViewerProps {
  logs: LogLine[];
  isLive?: boolean;
  initialFilter?: 'all' | 'warning' | 'error';
}

export function LogViewer({ logs, isLive = false, initialFilter = 'all' }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState<'all' | 'warning' | 'error'>(initialFilter);
  const [search, setSearch] = useState('');

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // Apply filter
      if (filter === 'warning' && log.level !== 'warning') return false;
      if (filter === 'error' && log.level !== 'error') return false;
      if (search && !log.message.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [logs, filter, search]);

  // Auto-scroll when new logs arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredLogs.length, autoScroll]);

  // Detect manual scroll
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const getLevelClass = (level: string) => {
    switch (level) {
      case 'error': return 'text-red-400';
      case 'warning': return 'text-yellow-400';
      case 'phase': return 'text-blue-400 font-bold';
      default: return 'text-gray-300';
    }
  };

  const warningCount = logs.filter(l => l.level === 'warning').length;
  const errorCount = logs.filter(l => l.level === 'error').length;

  return (
    <div className="flex flex-col h-full bg-gray-900 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-4 p-3 bg-gray-800 border-b border-gray-700">
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 bg-gray-900 border border-gray-600 rounded text-sm text-gray-100 placeholder-gray-500 w-64"
        />

        <div className="flex gap-1">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 rounded text-sm ${
              filter === 'all' ? 'bg-gray-600' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            All ({logs.length})
          </button>
          <button
            onClick={() => setFilter('warning')}
            className={`px-3 py-1 rounded text-sm ${
              filter === 'warning' ? 'bg-yellow-900' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            <span className="text-yellow-400">⚠</span> {warningCount}
          </button>
          <button
            onClick={() => setFilter('error')}
            className={`px-3 py-1 rounded text-sm ${
              filter === 'error' ? 'bg-red-900' : 'bg-gray-700 hover:bg-gray-600'
            }`}
          >
            <span className="text-red-400">✕</span> {errorCount}
          </button>
        </div>

        <div className="flex-1" />

        {isLive && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded"
            />
            Auto-scroll
          </label>
        )}

        {isLive && (
          <span className="flex items-center gap-2 text-sm text-green-400">
            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
            Live
          </span>
        )}
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-4 font-mono text-sm"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-gray-500 text-center py-8">
            {logs.length === 0 ? 'No logs yet...' : 'No matching logs'}
          </div>
        ) : (
          filteredLogs.map((log, i) => (
            <div
              key={`${log.lineNumber}-${i}`}
              className={`${getLevelClass(log.level)} whitespace-pre-wrap hover:bg-gray-800 py-0.5`}
            >
              <span className="text-gray-600 select-none w-12 inline-block text-right mr-4">
                {log.lineNumber}
              </span>
              <span className="text-gray-500 mr-2">[{log.phase}]</span>
              {log.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
