import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import fs from 'fs';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonFileStorage } from './storage/json-file.js';
import { ProjectRepository } from './repositories/project-repository.js';
import { BuildRepository } from './repositories/build-repository.js';
import { createProjectRoutes } from './routes/projects.js';
import { createBuildRoutes } from './routes/builds.js';
import { createConfigRoutes } from './routes/config.js';
import { createTestRoutes } from './routes/tests.js';
import { createReferenceRoutes } from './routes/references.js';
import { BuildOrchestrator } from './services/build-orchestrator.js';
import { GitPollingService } from './services/git-polling-service.js';
import { ConfigService } from './services/config-service.js';
import { TestResultsService } from './services/test-results-service.js';
import { ImageComparisonService } from './services/image-comparison-service.js';
import { AgentRegistry } from './services/agent-registry.js';
import { AgentDispatcher } from './services/agent-dispatcher.js';
import { TestResultsRepository } from './repositories/test-results-repository.js';
import { ReferenceRepository } from './repositories/reference-repository.js';
import { UsersRepository } from './auth/users-repository.js';
import { SessionsRepository } from './auth/sessions-repository.js';
import { AgentTokensRepository } from './auth/agent-tokens-repository.js';
import { createAuthMiddlewares, parseCookieHeader, resolveSessionUser, SESSION_COOKIE_NAME } from './auth/middleware.js';
import { createAuthRoutes } from './auth/routes.js';
import { createAgentRoutes } from './routes/agents.js';
import { createAgentTokenRoutes } from './routes/agent-tokens.js';
import { createAgentDataRoutes } from './routes/agent-data.js';
import { setupAgentNamespace } from './sockets/agent-namespace.js';
import { AuditLog } from './auth/audit-log.js';
import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// App root is three directories up from compiled dist/src
const APP_ROOT = path.join(__dirname, '..', '..', '..');

// Initialize config service and load configuration
const configService = new ConfigService(APP_ROOT);
const { config, source: configSource } = await configService.load();

const PORT = config.port;
const DATA_PATH = config.dataPath;
const BIND_HOST = config.bindHost;

console.log(`Configuration loaded from: ${configSource}`);
console.log(`Data path: ${DATA_PATH}`);
console.log(`Bind: ${BIND_HOST}:${PORT}`);

// Run any pending data migrations before any repository touches the on-disk state.
await runMigrations(DATA_PATH);

// Initialize storage and repositories
const storage = new JsonFileStorage(DATA_PATH);
const projectRepo = new ProjectRepository(storage);
const buildRepo = new BuildRepository(storage);
const testResultsRepo = new TestResultsRepository(storage);
const referenceRepo = new ReferenceRepository(storage, DATA_PATH);

// Initialize auth repositories and middleware
const usersRepo = new UsersRepository(storage);
const sessionsRepo = new SessionsRepository(storage);
const agentTokensRepo = new AgentTokensRepository(storage);
const auditLog = new AuditLog(DATA_PATH);
const { requireUser, requireAgent } = createAuthMiddlewares(usersRepo, sessionsRepo, agentTokensRepo);

// Periodically clean up expired sessions
setInterval(() => {
  sessionsRepo.deleteExpired().catch(err => console.error('Failed to clean expired sessions:', err));
}, 60 * 60 * 1000).unref();

// Warn if there are no users (otherwise nobody can log in)
const userCount = await usersRepo.count();
if (userCount === 0) {
  console.warn('');
  console.warn('  WARNING: no users exist. Nobody can log in until you create one.');
  console.warn('  Run:  pnpm --filter @banshee-forge/server cli user add <username>');
  console.warn('');
}

// Initialize services
const testResultsService = new TestResultsService(testResultsRepo);
const imageComparisonService = new ImageComparisonService();

// Create Express app
const app = express();
// Trust the first proxy hop so req.ip and Secure-cookie behaviour work behind Caddy/nginx.
app.set('trust proxy', 1);
app.use(helmet({
  // The React app uses inline styles in places; CSP would need careful tuning.
  // Disable for now and let the reverse proxy add baseline headers if desired.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// Create HTTP server with Socket.IO
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  // Same-origin only: web client is served by the same Express server in production,
  // and via the Vite dev proxy in development. No cross-origin clients.
  cors: { origin: false, credentials: true }
});

// Initialize orchestrator + agent dispatch chain
const orchestrator = new BuildOrchestrator(io, buildRepo, projectRepo, testResultsService, {
  dataPath: DATA_PATH,
});
const agentRegistry = new AgentRegistry();
const agentDispatcher = new AgentDispatcher(
  orchestrator.getQueue(),
  agentRegistry,
  orchestrator,
  buildRepo,
  projectRepo,
  { dataPath: DATA_PATH },
);
orchestrator.setDispatcher(agentDispatcher);

// Initialize git polling service
const pollingService = new GitPollingService(projectRepo, buildRepo, orchestrator, io);

// Public auth endpoints (login is rate-limited inside; /me is self-gated)
app.use('/api/v1/auth', createAuthRoutes(usersRepo, sessionsRepo, { cookieSecure: config.cookieSecure }));

// Health check is public so monitors can hit it without credentials
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Agent data uploads use bearer-token auth (requireAgent), so mount before requireUser.
app.use('/api/v1/agent', createAgentDataRoutes({ dataPath: DATA_PATH }, requireAgent));

// All API endpoints below this line require an authenticated user
app.use('/api/v1', requireUser);

app.use('/api/v1/projects', createProjectRoutes(projectRepo, pollingService, auditLog));
app.use('/api/v1', createBuildRoutes(buildRepo, projectRepo, orchestrator, auditLog));
app.use('/api/v1', createAgentRoutes(agentRegistry));
app.use('/api/v1/agent-tokens', createAgentTokenRoutes(agentTokensRepo, auditLog));
app.use('/api/v1/config', createConfigRoutes(configService, auditLog));
app.use('/api/v1', createTestRoutes(
	testResultsService,
	testResultsRepo,
	imageComparisonService,
	referenceRepo,
	projectRepo,
	buildRepo,
	DATA_PATH
));
app.use('/api/v1', createReferenceRoutes(
	referenceRepo,
	testResultsRepo,
	projectRepo,
	buildRepo,
	DATA_PATH,
	auditLog
));

// Queue status endpoint (also requires auth via the middleware above)
app.get('/api/v1/queue', (_req, res) => {
  res.json(orchestrator.getQueueStatus());
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Serve static files from the web client build (only if dist exists)
const webClientPath = path.join(APP_ROOT, 'packages', 'web', 'dist');
const webClientExists = fs.existsSync(webClientPath);

if (webClientExists) {
  app.use(express.static(webClientPath));

  // Handle client-side routing - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/'))
      return next();
    res.sendFile(path.join(webClientPath, 'index.html'));
  });
}

// Wire up the /agents namespace (bearer-token authed) for agent connections.
setupAgentNamespace(io, agentTokensRepo, agentRegistry, agentDispatcher, orchestrator);

// Authenticate every Socket.IO connection via the session cookie
io.use(async (socket, next) => {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    const user = await resolveSessionUser(sessionId, usersRepo, sessionsRepo);
    if (!user)
      return next(new Error('Unauthorized'));
    (socket.data as Record<string, unknown>).user = user;
    next();
  } catch (err) {
    next(err as Error);
  }
});

// Socket.IO connection handler
io.on('connection', (socket) => {
  const user = (socket.data as { user?: { username: string } }).user;
  console.log(`Client connected: ${socket.id}${user ? ` (user: ${user.username})` : ''}`);

  socket.on('subscribe_build', (buildId: string) => {
    socket.join(`build:${buildId}`);
  });

  socket.on('unsubscribe_build', (buildId: string) => {
    socket.leave(`build:${buildId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Export for potential programmatic use
export { io, projectRepo, buildRepo, orchestrator, pollingService, testResultsService, testResultsRepo, referenceRepo, imageComparisonService };

// Start server
async function start() {
  // Initialize orchestrator (recover pending builds)
  await orchestrator.initialize();

  // Start git polling for auto-builds
  await pollingService.initialize();

  httpServer.listen(PORT, BIND_HOST, () => {
    const localUrl = `http://${BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST}:${PORT}`;
    console.log(`BansheeForge server listening on ${BIND_HOST}:${PORT}`);
    console.log(`  - API: ${localUrl}/api/v1`);
    console.log(`  - UI:  ${webClientExists ? localUrl : 'Not built (run: pnpm run build from packages/web)'}`);
    console.log(`Data directory: ${DATA_PATH}`);
    if (configService.hasPendingChanges()) {
      console.log('Note: There are pending configuration changes. Restart to apply.');
    }
  });
}

start().catch(console.error);
