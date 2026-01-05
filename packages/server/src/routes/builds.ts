import { Router } from 'express';
import type { CreateBuildInput, PaginatedResponse, BuildSummary } from '@banshee-forge/shared';
import { BuildRepository } from '../repositories/build-repository.js';
import { ProjectRepository } from '../repositories/project-repository.js';
import { BuildOrchestrator } from '../services/build-orchestrator.js';

export function createBuildRoutes(
  buildRepo: BuildRepository,
  projectRepo: ProjectRepository,
  orchestrator: BuildOrchestrator
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

  // POST /api/v1/projects/:slug/builds - Trigger new build
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
      if (input.configurationId && !configuration) {
        res.status(400).json({ error: 'Bad request', message: 'Configuration not found' });
        return;
      }

      // Use configuration's defaultConfig if available
      const defaultConfig = configuration?.defaultConfig ?? {};
      const configurationName = configuration?.name ?? 'default';

      const build = await buildRepo.create(req.params.slug, {
        ...input,
        configurationId: configurationId ?? '',
        gitBranch: input.gitBranch ?? project.gitBranch,
        config: input.config ?? defaultConfig,
      }, 'manual', configurationName);

      // Trigger build execution via orchestrator
      const priority = (input as any).priority ?? 0;
      await orchestrator.triggerBuild(req.params.slug, build.id, priority);

      res.status(201).json(build);
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
      const { parseLog } = await import('../services/log-parser.js');
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
          const { lines, phases } = parseLog(logText);

          res.json({
            lines: lines.slice(fromLine),
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
