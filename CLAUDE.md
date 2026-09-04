# CLAUDE.md

This file provides guidance to Claude Code when working with the BansheeForge codebase.

## Project Overview

BansheeForge is a continuous integration tool for the Banshee 3D game engine. It handles:

- Building the framework, editor, examples, and tests
- Running unit tests via UnitTestRunner
- Running snapshot tests for all examples (visual regression testing)
- Real-time build log streaming via WebSocket
- Multi-configuration support (Debug, Release, RelWithDebInfo)

Data is stored at `D:\BansheeForgeData` (configurable).

## Technology Stack

- **Backend**: Node.js 20+, Express.js, Socket.IO, TypeScript
- **Frontend**: React 18, Vite, TanStack Query, Tailwind CSS, CodeMirror
- **Package Manager**: pnpm with workspaces (monorepo)
- **Build Execution**: Git Bash scripts on Windows
- **Image Comparison**: pixelmatch for snapshot testing

## Repository Structure

```
BansheeForge/
├── packages/
│   ├── shared/           # Shared TypeScript types and utilities
│   ├── server/           # Express + Socket.IO backend
│   ├── web/              # React + Vite frontend SPA
│   └── agent/            # Build agent (runs on Windows/macOS/Linux workers; macos/ has launchd packaging)
├── package.json          # Root workspace config
├── pnpm-workspace.yaml   # Workspace definition
├── tsconfig.base.json    # Shared TypeScript config
├── config.json           # Server configuration
└── rebuild.sh            # Production build/deploy script
```

## Development Commands

```bash
# Install dependencies
pnpm install

# Run in development (all packages)
pnpm dev

# Build all packages
pnpm build

# Run individual packages
cd packages/server && pnpm dev    # Backend on :3003
cd packages/web && pnpm dev       # Frontend on :3000 (proxied to backend)
```

## Platforms and Agents

- **Target platforms** are global and listed in `packages/shared/src/platforms.json` (`win32`,
  `darwin`, `linux`, `ps5`). They are build targets, not agent operating systems: a Windows
  agent may service `win32` and `ps5`. GPU backends are not part of the platform list; the test
  script picks them per platform.
- Every build has a `platform`. Triggering a build (UI or `POST /projects/:slug/builds` with
  `platforms: [...]`) creates one build per platform. A configuration's `platforms` list limits
  which platforms it may be built for (empty = all). Polling launches `Project.pollingTargets`
  (configuration + platforms pairs).
- Agents declare the platforms they service (`BSF_AGENT_PLATFORMS`, default = host OS id) and
  report `available` in their heartbeat. The dispatcher matches `build.platform` against agent
  platforms, required labels, availability and free slots. A build with no eligible agent stays
  pending indefinitely with a `pendingReason` on the queue entry (shown in the UI).
- **Known agents** (`known-agents.json` in the data dir) remember every agent that ever
  registered so the Trigger Build modal can offer a platform whose only agent is offline (a
  sleeping laptop); such builds queue and wait. `GET /platforms` returns per-platform status
  (`connected` / `offline` / `never-seen`).
- The **macOS agent** only reports itself available while its own user owns `/dev/console`
  (another user logged in at the screen blocks new builds), and holds a `caffeinate` sleep
  assertion while builds run. See DEPLOYMENT.md for the launchd install.

## Key Services

### Backend (`packages/server/src/services/`)

- **BuildOrchestrator**: Manages build lifecycle, queuing, and real-time updates
- **AgentDispatcher / AgentRegistry**: Match pending builds to connected agents by platform, labels and availability
- **BuildQueue**: Priority queue of pending builds, with per-build pending reasons
- **GitPollingService**: Polls watched repositories and launches polling targets
- **TestResultsService**: Parses unit test JSON and snapshot test results
- **ImageComparisonService**: Compares PNG screenshots using pixelmatch
- **ConfigService**: Manages server configuration

### Repositories (`packages/server/src/repositories/`)

- **ProjectRepository**: CRUD for projects and configurations
- **BuildRepository**: Build storage and log management
- **KnownAgentsRepository**: Agents seen at least once (for offline platform availability)
- **TestResultsRepository**: Test result archiving
- **ReferenceRepository**: Snapshot reference images, scoped per configuration *and platform*
  (`references/{slug}/{configId}/{platform}/{category}/{test}.png`)

## Data Storage Structure

```
D:\BansheeForgeData/
├── projects/
│   ├── {projectId}.json              # Project metadata
│   └── {slug}/
│       ├── configs/{configId}/
│       │   ├── fetch.sh              # Git clone/fetch script
│       │   ├── build.sh              # CMake/build script
│       │   └── test.sh               # Test execution script
│       └── builds/{buildId}/
│           ├── build.json            # Build metadata
│           ├── log.txt               # Full build log
│           ├── results/              # Test outputs
│           └── artifacts/            # Build artifacts
└── workspaces/{slug}/{configId}/     # Incremental build workspace
```

## Build Execution Flow

1. Build triggered via API → queued by BuildOrchestrator
2. BuildExecutor resolves workspace: `{workspaces}/{slug}/{configId}`
3. Runs scripts via bash (Git Bash on Windows, Homebrew bash on macOS) with injected environment:
   - `GIT_URL`, `GIT_BRANCH`, `GIT_COMMIT`
   - `BUILD_NUMBER`, `BUILD_ID`, `CONFIGURATION_ID`
   - `PLATFORM` (target: win32/darwin/linux/ps5), `HOST_PLATFORM` (agent OS), `ARCH`
   - `WORKSPACE`, `ARTIFACTS_DIR`, `RESULTS_DIR` (Unix paths)
4. Phases detected via `::phase::NAME` markers in script output
5. Warnings/errors parsed via regex (MSVC, GCC, CMake patterns)
6. Test results parsed from JSON files after completion
7. Real-time updates broadcast via Socket.IO

## API Endpoints

### Projects
- `GET/POST /api/v1/projects` - List/create projects
- `GET/PUT/DELETE /api/v1/projects/:slug` - Project CRUD
- `GET/POST /api/v1/projects/:slug/configurations` - Configuration management
- `GET/PUT /api/v1/projects/:slug/configurations/:id/scripts/:type` - Script management

### Builds
- `POST /api/v1/projects/:slug/builds` - Trigger builds (`platforms: []`, one build per platform; returns `{ builds }`)
- `GET /api/v1/builds/:id` - Get build details
- `GET /api/v1/builds/:id/log` - Get full build log
- `GET /api/v1/queue` - Get queue status

### Platforms & Agents
- `GET /api/v1/platforms` - Platform list with agent availability
- `GET /api/v1/agents` - Connected agents
- `GET/DELETE /api/v1/known-agents[/:name]` - Agents seen before (offline platforms stay selectable)

### Test Results
- `GET /api/v1/projects/:slug/builds/:id/test-results` - Get test results
- `GET /api/v1/projects/:slug/builds/:id/snapshots/:name/comparison` - Image diff

## Socket.IO Events

**Client → Server:**
- `subscribe_build` / `unsubscribe_build` - Join/leave build room

**Server → Client:**
- `build:log` - Log lines batch
- `build:phase` - Phase start/end
- `build:status` - Status change
- `build:complete` - Build finished
- `queue:updated` - Queue state changed

## Code Conventions

- TypeScript strict mode enabled
- ES modules (import/export, not require)
- Async/await for all async operations
- File-based JSON storage with atomic writes
- Unix-style paths for bash scripts (Windows paths converted)

## Frontend Structure

### Pages (`packages/web/src/pages/`)
- Dashboard, CreateProject, ProjectDetail, BuildDetail, Settings

### Key Components
- **LogViewer**: Streaming log display with filtering
- **PhaseTimeline**: Visual build phase progress
- **ScriptEditor**: CodeMirror-based bash editor
- **SnapshotComparisonModal**: Side-by-side image diff

### Data Hooks (`packages/web/src/hooks/`)
- `useProjects`, `useBuilds`, `useBuildSocket`, `useTestResults`

## Data Migrations

`packages/server/src/migrate.ts` runs at server startup and is idempotent. It stamps `platform`
on pre-platform builds, converts configuration `platform` to `platforms[]`, converts
`pollingConfigurationIds` to `pollingTargets`, and moves reference images under a per-platform
directory. Add new one-off migrations there.

## Windows-Specific Notes

- Uses Git Bash for script execution (detected at `C:\Program Files\Git\bin\bash.exe`)
- Windows paths converted to Unix: `C:\foo` → `/c/foo`
- Process kill via `taskkill /pid /f /t` for tree kill
- Atomic file writes with retry for Windows file locking (EPERM, EBUSY)

## Testing

Unit tests run via `UnitTestRunner.exe`:
- Output format: JSON to `results/unit_tests.json`
- Flags: `--headless`, `--test-output-format=json`, `--test-layer=all`

Snapshot tests run each example executable:
- Output: `results/snapshots/{testName}/{testName}_result.json` + PNGs
- Comparison against reference images stored in data directory

## Configuration

Server config in `config.json`:
```json
{
  "dataPath": "D:\\BansheeForgeData",
  "port": 3003
}
```

Environment overrides: `DATA_PATH`, `PORT`
