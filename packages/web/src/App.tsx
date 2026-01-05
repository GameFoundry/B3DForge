import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { CreateProject } from './pages/CreateProject';
import { ProjectDetail } from './pages/ProjectDetail';
import { BuildDetail } from './pages/BuildDetail';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="projects/new" element={<CreateProject />} />
            <Route path="projects/:slug" element={<ProjectDetail />} />
            <Route path="builds/:id" element={<BuildDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
