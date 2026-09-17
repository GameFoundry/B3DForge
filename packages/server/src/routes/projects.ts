import { Router } from 'express';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateConfigurationInput,
  UpdateConfigurationInput,
  UpdatePinsInput,
} from '@banshee-forge/shared';
import { isValidBranchName } from '@banshee-forge/shared';
import { ProjectRepository } from '../repositories/project-repository.js';
import { GitPollingService } from '../services/git-polling-service.js';
import { ConfigService } from '../services/config-service.js';
import { PinUpdateError, SubmodulePinService, readGitCredentials } from '../services/submodule-pin-service.js';
import { AuditLog } from '../auth/audit-log.js';

export interface ProjectRoutesOptions {
	/** Reads and updates submodule pins; the pins endpoints are absent without it. */
	pins?: SubmodulePinService;
	/** Supplies the credentials file the pin update pushes with. */
	configService?: ConfigService;
}

export function createProjectRoutes(
	projectRepo: ProjectRepository,
	pollingService?: GitPollingService,
	auditLog?: AuditLog,
	options: ProjectRoutesOptions = {}
): Router {
  const router = Router();

  // GET /api/v1/projects/:slug/pins?branch=<name>[&commit=<sha>]
  // Compare every submodule pin of the branch head (or the given commit) with the head of the
  // submodule's branch, so the Trigger Build modal can offer to update stale pins first.
  router.get('/:slug/pins', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project || !options.pins) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      const branch = String(req.query.branch ?? '').trim() || project.gitBranch;
      const commit = String(req.query.commit ?? '').trim() || undefined;
      if (!isValidBranchName(branch)) {
        res.status(400).json({ error: 'Bad request', message: `'${branch}' is not a valid branch name` });
        return;
      }
      try {
        res.json(await options.pins.inspect({ rootUrl: project.gitUrl, branch, rootCommit: commit }));
      } catch (error) {
        res.status(400).json({ error: 'Bad request', message: `Could not inspect pins: ${(error as Error).message}` });
      }
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/projects/:slug/pins/update  { branch, expectedRootCommit }
  // Write pin commits (children first) so the branch pins the branch heads of every submodule,
  // with plain pushes. 409 when a branch moved since the inspection; nothing is retried.
  router.post('/:slug/pins/update', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project || !options.pins) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      const input = (req.body ?? {}) as Partial<UpdatePinsInput>;
      const branch = (input.branch ?? '').trim();
      if (!isValidBranchName(branch) || !/^[0-9a-f]{40}$/.test(input.expectedRootCommit ?? '')) {
        res.status(400).json({ error: 'Bad request', message: 'branch and expectedRootCommit are required' });
        return;
      }
      try {
        const credentials = await readGitCredentials(options.configService?.getConfig().deploy.credentialsFile);
        const result = await options.pins.updatePins({ rootName: project.name, rootUrl: project.gitUrl, branch, expectedRootCommit: input.expectedRootCommit!, credentials });
        auditLog?.append({ actor: AuditLog.actorOf(req), action: 'pins.update', target: req.params.slug, details: { branch, from: input.expectedRootCommit, to: result.rootCommit, updates: result.updates.map(u => `${u.name}: ${u.from.slice(0, 7)} -> ${u.to.slice(0, 7)}`) } });
        res.json(result);
      } catch (error) {
        if (error instanceof PinUpdateError) {
          res.status(error.conflict ? 409 : 400).json({ error: error.conflict ? 'Conflict' : 'Bad request', message: error.message });
          return;
        }
        res.status(400).json({ error: 'Bad request', message: `Could not update pins: ${(error as Error).message}` });
      }
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects - List all projects
  router.get('/', async (_req, res, next) => {
    try {
      const projects = await projectRepo.findAll();
      res.json({ projects });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/projects - Create project
  router.post('/', async (req, res, next) => {
    try {
      const input = req.body as CreateProjectInput;
      const project = await projectRepo.create(input);
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'project.create', target: project.slug, details: { name: project.name } });
      res.status(201).json(project);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects/:slug - Get project
  router.get('/:slug', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      res.json(project);
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug - Update project
  router.put('/:slug', async (req, res, next) => {
    try {
      const input = req.body as UpdateProjectInput;
      const project = await projectRepo.update(req.params.slug, input);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }

      // Notify polling service if auto-build settings may have changed
      if (pollingService && (
        input.autoBuild !== undefined ||
        input.pollInterval !== undefined ||
        input.watchedRepositories !== undefined ||
        input.gitBranch !== undefined
      ))
        await pollingService.updateProject(req.params.slug);

      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'project.update', target: req.params.slug });
      res.json(project);
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/v1/projects/:slug - Delete project
  router.delete('/:slug', async (req, res, next) => {
    try {
      if (pollingService)
        pollingService.removeProject(req.params.slug);

      const deleted = await projectRepo.delete(req.params.slug);
      if (!deleted) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'project.delete', target: req.params.slug });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Polling endpoints
  // ============================================

  // GET /api/v1/projects/:slug/polling-status - Get polling status
  router.get('/:slug/polling-status', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }

      if (!pollingService) {
        res.json({ enabled: false, pollInterval: project.pollInterval, repositories: [] });
        return;
      }

      const status = await pollingService.getStatus(req.params.slug);
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/projects/:slug/poll-now - Force immediate poll
  router.post('/:slug/poll-now', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }

      if (!pollingService) {
        res.status(400).json({ error: 'Bad request', message: 'Polling service not available' });
        return;
      }

      const status = await pollingService.pollNow(req.params.slug);
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'project.poll-now', target: req.params.slug });
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Configuration endpoints
  // ============================================

  // GET /api/v1/projects/:slug/configurations - List configurations
  router.get('/:slug/configurations', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      res.json({ configurations: project.configurations ?? [] });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/projects/:slug/configurations - Create configuration
  router.post('/:slug/configurations', async (req, res, next) => {
    try {
      const input = req.body as CreateConfigurationInput;
      const config = await projectRepo.createConfiguration(req.params.slug, input);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'configuration.create', target: `${req.params.slug}/${config.id}`, details: { name: config.name } });
      res.status(201).json(config);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects/:slug/configurations/:configId - Get configuration
  router.get('/:slug/configurations/:configId', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug/configurations/:configId - Update configuration
  router.put('/:slug/configurations/:configId', async (req, res, next) => {
    try {
      const input = req.body as UpdateConfigurationInput;
      const config = await projectRepo.updateConfiguration(
        req.params.slug,
        req.params.configId,
        input
      );
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'configuration.update', target: `${req.params.slug}/${req.params.configId}` });
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/v1/projects/:slug/configurations/:configId - Delete configuration
  router.delete('/:slug/configurations/:configId', async (req, res, next) => {
    try {
      const deleted = await projectRepo.deleteConfiguration(req.params.slug, req.params.configId);
      if (!deleted) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'configuration.delete', target: `${req.params.slug}/${req.params.configId}` });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Configuration script endpoints
  // ============================================

  // GET /api/v1/projects/:slug/configurations/:configId/scripts/build
  router.get('/:slug/configurations/:configId/scripts/build', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const script = await projectRepo.getConfigurationBuildScript(
        req.params.slug,
        req.params.configId
      );
      res.json({
        script: script ?? '',
        source: config.buildScript?.source ?? 'local',
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug/configurations/:configId/scripts/build
  router.put('/:slug/configurations/:configId/scripts/build', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const { script } = req.body as { script: string };
      await projectRepo.saveConfigurationBuildScript(
        req.params.slug,
        req.params.configId,
        script
      );

      // Update configuration to use local source if not already
      if (config.buildScript?.source !== 'local') {
        await projectRepo.updateConfiguration(req.params.slug, req.params.configId, {
          buildScript: { source: 'local' },
        });
      }

      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'script.update', target: `${req.params.slug}/${req.params.configId}/build`, details: { length: script?.length ?? 0 } });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects/:slug/configurations/:configId/scripts/test
  router.get('/:slug/configurations/:configId/scripts/test', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const scriptInfo = await projectRepo.getConfigurationTestScript(
        req.params.slug,
        req.params.configId
      );
      res.json({
        script: scriptInfo?.content ?? '',
        source: config.testScript?.source ?? 'local',
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug/configurations/:configId/scripts/test
  router.put('/:slug/configurations/:configId/scripts/test', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const { script } = req.body as { script: string };

      await projectRepo.saveConfigurationTestScript(
        req.params.slug,
        req.params.configId,
        script
      );

      // Update configuration to use local source if not already
      if (config.testScript?.source !== 'local') {
        await projectRepo.updateConfiguration(req.params.slug, req.params.configId, {
          testScript: { source: 'local' },
        });
      }

      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'script.update', target: `${req.params.slug}/${req.params.configId}/test`, details: { length: script?.length ?? 0 } });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/v1/projects/:slug/configurations/:configId/scripts/test
  router.delete('/:slug/configurations/:configId/scripts/test', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      await projectRepo.deleteConfigurationTestScript(req.params.slug, req.params.configId);

      // Clear test script config
      await projectRepo.updateConfiguration(req.params.slug, req.params.configId, {
        testScript: undefined,
      });

      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'script.delete', target: `${req.params.slug}/${req.params.configId}/test` });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Fetch script endpoints (always local bash)
  // ============================================

  // GET /api/v1/projects/:slug/scripts/fetch
  // Project-level fetch script — inherited by all configurations whose
  // `overrideFetchScript` flag is not set.
  router.get('/:slug/scripts/fetch', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      const script = await projectRepo.getProjectFetchScript(req.params.slug);
      res.json({ script: script ?? '' });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug/scripts/fetch
  router.put('/:slug/scripts/fetch', async (req, res, next) => {
    try {
      const project = await projectRepo.findBySlug(req.params.slug);
      if (!project) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      const { script } = req.body as { script: string };
      await projectRepo.saveProjectFetchScript(req.params.slug, script);
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'script.update', target: `${req.params.slug}/fetch`, details: { length: script?.length ?? 0 } });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/projects/:slug/configurations/:configId/scripts/fetch
  router.get('/:slug/configurations/:configId/scripts/fetch', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const script = await projectRepo.getConfigurationFetchScript(
        req.params.slug,
        req.params.configId
      );
      res.json({
        script: script ?? '',
      });
    } catch (error) {
      next(error);
    }
  });

  // PUT /api/v1/projects/:slug/configurations/:configId/scripts/fetch
  router.put('/:slug/configurations/:configId/scripts/fetch', async (req, res, next) => {
    try {
      const config = await projectRepo.getConfiguration(req.params.slug, req.params.configId);
      if (!config) {
        res.status(404).json({ error: 'Not found', message: 'Configuration not found' });
        return;
      }
      const { script } = req.body as { script: string };
      await projectRepo.saveConfigurationFetchScript(
        req.params.slug,
        req.params.configId,
        script
      );
      auditLog?.append({ actor: AuditLog.actorOf(req), action: 'script.update', target: `${req.params.slug}/${req.params.configId}/fetch`, details: { length: script?.length ?? 0 } });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
