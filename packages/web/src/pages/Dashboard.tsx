import { Link } from 'react-router-dom';
import { useProjects } from '../hooks/useProjects';

export function Dashboard() {
  const { data: projects, isLoading, error } = useProjects();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }
  if (error) return <div className="text-red-400">Error: {error.message}</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-100">Dashboard</h1>
        <Link
          to="/projects/new"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          New Project
        </Link>
      </div>

      {!projects?.length ? (
        <div className="text-center py-12 bg-gray-800 rounded-lg">
          <p className="text-gray-400">No projects yet.</p>
          <Link to="/projects/new" className="text-blue-400 hover:underline">
            Create your first project
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map(project => (
            <Link
              key={project.id}
              to={`/projects/${project.slug}`}
              className="block bg-gray-800 p-4 rounded-lg hover:bg-gray-700 transition-colors border border-gray-700"
            >
              <h3 className="font-semibold text-lg text-gray-100">{project.name}</h3>
              <p className="text-gray-400 text-sm">{project.description}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-gray-500 font-mono">
                  {project.gitBranch}
                </span>
                {project.configurations?.length > 0 && (
                  <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">
                    {project.configurations.length} config{project.configurations.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
