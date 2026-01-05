import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonFileStorage } from './storage/json-file.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { BuildRepository } from './repositories/build-repository.js';
import { createProjectRoutes } from './routes/projects.js';
import { createBuildRoutes } from './routes/builds.js';
import { BuildOrchestrator } from './services/build-orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3003;
const DATA_PATH = process.env.DATA_PATH ?? path.join(__dirname, '..', '..', '..', 'data');

// Initialize storage and repositories
const storage = new JsonFileStorage(DATA_PATH);
const projectRepo = new ProjectRepository(storage);
const buildRepo = new BuildRepository(storage);

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP server with Socket.IO
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: '*' }
});

// Initialize orchestrator
const orchestrator = new BuildOrchestrator(io, buildRepo, projectRepo, {
  workspaceRoot: path.join(DATA_PATH, 'workspaces'),
  dataPath: DATA_PATH,
  defaultTimeoutMs: 60 * 60 * 1000,
  maxWorkspacesPerProject: 5,
});

// API routes - pass orchestrator to build routes
app.use('/api/v1/projects', createProjectRoutes(projectRepo));
app.use('/api/v1', createBuildRoutes(buildRepo, projectRepo, orchestrator));

// Queue status endpoint
app.get('/api/v1/queue', (_req, res) => {
  res.json(orchestrator.getQueueStatus());
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe_build', (buildId: string) => {
    socket.join(`build:${buildId}`);
    console.log(`Client ${socket.id} subscribed to build ${buildId}`);
  });

  socket.on('unsubscribe_build', (buildId: string) => {
    socket.leave(`build:${buildId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Export for potential programmatic use
export { io, projectRepo, buildRepo, orchestrator };

// Start server
async function start() {
  // Initialize orchestrator (recover pending builds)
  await orchestrator.initialize();

  httpServer.listen(PORT, () => {
    console.log(`BansheeForge server listening on port ${PORT}`);
    console.log(`Data directory: ${DATA_PATH}`);
  });
}

start().catch(console.error);
