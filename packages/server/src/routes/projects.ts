import { Router } from 'express';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateConfigurationInput,
  UpdateConfigurationInput,
} from '@banshee-forge/shared';
import { ProjectRepository } from '../repositories/project-repository.js';

export function createProjectRoutes(projectRepo: ProjectRepository): Router {
  const router = Router();

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
      res.json(project);
    } catch (error) {
      next(error);
    }
  });

  // DELETE /api/v1/projects/:slug - Delete project
  router.delete('/:slug', async (req, res, next) => {
    try {
      const deleted = await projectRepo.delete(req.params.slug);
      if (!deleted) {
        res.status(404).json({ error: 'Not found', message: 'Project not found' });
        return;
      }
      res.json({ success: true });
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

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  // ============================================
  // Fetch script endpoints (always local bash)
  // ============================================

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
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
