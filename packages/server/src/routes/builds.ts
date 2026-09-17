import { Router } from 'express';
import type { CreateBuildInput, PaginatedResponse, BuildSummary, TriggerBuildResponse } from '@banshee-forge/shared';
import { isKnownPlatform } from '@banshee-forge/shared';
import { resolveConfigurationPlatforms } from '../services/configuration-platforms.js';
import { BuildRepository } from '../repositories/build-repository.js';
import { BuildGroupRepository } from '../repositories/build-group-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildOrchestrator } from '../services/build-orchestrator.js';
import { BuildTriggerService } from '../services/build-trigger-service.js';
import { AuditLog } from '../auth/audit-log.js';

export function createBuildRoutes(
  buildRepo: BuildRepository,
  groupRepo: BuildGroupRepository,
  projectRepo: ProjectRepository,
  orchestrator: BuildOrchestrator,
  triggerService: BuildTriggerService,
  auditLog?: AuditLog
): Router {
  const router = Router();

  // GET /api/v1/projects/:slug/builds - List builds for project
  router.get('/projects/:slug/builds', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }

      const page = parseInt(req.query.page as string) || 1;
      const pageSize = parseInt(req.query.pageSize as string) || 20;
      const { builds, total } = await buildRepo.findAllForProject(req.params.slug, page, pageSize);

      const response: PaginatedResponse<BuildSummary> = {
        items: builds,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/projects/:slug/builds - Trigger new builds (one per requested platform)
  router.post('/projects/:slug/builds', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }

      const input = req.body as CreateBuildInput;

      // Resolve configuration
      const configurationId = input.configurationId ?? project.defaultConfigurationId;
      const configuration = configurationId
        ? project.configurations?.find(c => c.id === configurationId)
        : undefined;

      // Validate configuration exists if ID was provided
      if (!configuration) {
        res.status(400).json({ error: 'Bad request', message: 'Configuration not found' });
        return;
      }

      // Resolve platforms: requested ones must be known and supported by the configuration.
      const supported = resolveConfigurationPlatforms(configuration);
      const platforms = input.platforms?.length ? input.platforms : supported;
      const unknown = platforms.filter(p => !isKnownPlatform(p));
      if (unknown.length > 0) {
        res.status(400).json({ error: 'Bad request', message: `Unknown platform(s): ${unknown.join(', ')}` });
        return;
      }
      const unsupported = platforms.filter(p => !supported.includes(p));
      if (unsupported.length > 0) {
        res.status(400).json({ error: 'Bad request', message: `Configuration does not support platform(s): ${unsupported.join(', ')}` });
        return;
      }

      const priority = (input as { priority?: number }).priority ?? 0;

      let triggered;
      try {
        triggered = await triggerService.triggerGroup({
          project,
          configuration,
          platforms,
          triggerType: 'manual',
          triggeredBy: input.triggeredBy ?? req.user?.username,
          gitBranch: input.gitBranch,
          gitCommit: input.gitCommit,
          config: input.config,
          cleanBuild: input.cleanBuild,
          autoDeploy: input.autoDeploy,
          priority,
        });
      } catch (error) {
        // Resolving the root commit talks to the remote; a missing branch or unreachable repository is a client-visible failure.
        res.status(400).json({ error: 'Bad request', message: `Could not resolve sources: ${(error as Error).message}` });
        return;
      }

      for (const build of triggered.builds)
        auditLog?.append({ actor: AuditLog.actorOf(req), action: 'build.trigger', target: `${req.params.slug}/${build.id}`, details: { configurationId: build.configurationId, configurationName: configuration.name, platform: build.platform, groupId: triggered.group.id, autoDeploy: triggered.group.autoDeploy } });

      const response: TriggerBuildResponse = { builds: triggered.builds, group: triggered.group };
      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects/:slug/groups/:groupId - Build group (platforms sharing one root commit)
  router.get('/projects/:slug/groups/:groupId', async (req, res, next) => {
    try {
      const group = await groupRepo.findById(req.params.slug, req.params.groupId);
      if (!group) {
        res.status(404).json({ error: 'Not found', message: 'Build group not found' });
        return;
      }
      res.json(group);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/builds/:id - Get build details
  router.get('/builds/:id', async (req, res, next) => {
    try {
      const projects = await projectRepo.findAll();
      for (const project of projects) {
        const build = await buildRepo.findById(project.slug, req.params.id);
        if (build) {
          res.json(build);
          return;
        }
      }
      res.status(404).json({ error: 'Not found', message: 'Build not found' });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/v1/builds/:id - Cancel build
  router.delete('/builds/:id', async (req, res, next) => {
    try {
      const projects = await projectRepo.findAll();
      for (const project of projects) {
        const build = await buildRepo.findById(project.slug, req.params.id);
        if (build) {
          if (build.status === 'pending' || build.status === 'running') {
            // Cancel via orchestrator (handles queue removal + process kill)
            const cancelled = await orchestrator.cancelBuild(req.params.id);
            if (cancelled) {
              const updated = await buildRepo.updateStatus(project.slug, req.params.id, 'cancelled');
              auditLog?.append({ actor: AuditLog.actorOf(req), action: 'build.cancel', target: `${project.slug}/${req.params.id}` });
              res.json(updated);
              return;
            }
          }
          res.status(400).json({ error: 'Bad request', message: 'Build cannot be cancelled' });
          return;
        }
      }
      res.status(404).json({ error: 'Not found', message: 'Build not found' });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/builds/:id/log - Get build log
  router.get('/builds/:id/log', async (req, res, next) => {
    try {
      const projects = await projectRepo.findAll();
      for (const project of projects) {
        const build = await buildRepo.findById(project.slug, req.params.id);
        if (build) {
          const log = await buildRepo.getLog(project.slug, req.params.id);
          // `format=text` serves the log for viewing/downloading whole, which is the escape
          // hatch when the parsed view below is truncated.
          if (req.query.format === 'text') {
            res.type('text/plain').send(log ?? '');
            return;
          }
          res.json({ log: log ?? '' });
          return;
        }
      }
      res.status(404).json({ error: 'Not found', message: 'Build not found' });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/builds/:id/log/parsed - Get parsed log lines
  router.get('/builds/:id/log/parsed', async (req, res, next) => {
    try {
      const { parseLog } = await import('@banshee-forge/shared');
      const projects = await projectRepo.findAll();

      for (const project of projects) {
        const build = await buildRepo.findById(project.slug, req.params.id);
        if (build) {
          const logText = await buildRepo.getLog(project.slug, req.params.id);
          if (!logText) {
            res.json({ lines: [], phases: [], totalLines: 0 });
            return;
          }

          const fromLine = parseInt(req.query.fromLine as string) || 0;
          // A full engine build logs hundreds of thousands of lines once bash xtrace is on.
          // Serializing all of them costs far more than any reader needs, so `limit` keeps the
          // most recent slice; `totalLines` still reports the true length.
          const limit = parseInt(req.query.limit as string) || 0;
          const { lines, phases } = parseLog(logText);
          const selected = lines.slice(fromLine);

          res.json({
            lines: limit > 0 && selected.length > limit ? selected.slice(-limit) : selected,
            phases,
            totalLines: lines.length,
          });
          return;
        }
      }
      res.status(404).json({ error: 'Not found', message: 'Build not found' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
