import { Router } from 'express';
import type { ConfigResponse, ConfigUpdateResponse, ServerConfigUpdate } from '@banshee-forge/shared';
import { ConfigService } from '../services/config-service.js';

export function createConfigRoutes(configService: ConfigService): Router {
  const router = Router();

  // GET /api/v1/config - Get current configuration
  router.get('/', (_req, res) => {
    try {
      const config = configService.getConfig();
      const response: ConfigResponse = {
        dataPath: config.dataPath,
        port: config.port,
        configSource: configService.getSource(),
        pendingRestart: configService.hasPendingChanges(),
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // PUT /api/v1/config - Update configuration
  router.put('/', async (req, res) => {
    try {
      const updates: ServerConfigUpdate = req.body;

      // Validate if dataPath is being changed
      if (updates.dataPath) {
        const validation = await configService.validate(updates.dataPath);
        if (!validation.valid) {
          res.status(400).json({
            success: false,
            requiresRestart: false,
            message: validation.message ?? 'Invalid data path',
          } as ConfigUpdateResponse);
          return;
        }
      }

      await configService.save(updates);

      const response: ConfigUpdateResponse = {
        success: true,
        requiresRestart: true,
        message: 'Configuration saved. Restart the server to apply changes.',
      };
      res.json(response);
    } catch (err) {
      res.status(500).json({
        success: false,
        requiresRestart: false,
        message: (err as Error).message,
      } as ConfigUpdateResponse);
    }
  });

  // POST /api/v1/config/validate - Validate a data path
  router.post('/validate', async (req, res) => {
    try {
      const { dataPath } = req.body as { dataPath: string };

      if (!dataPath) {
        res.status(400).json({
          valid: false,
          exists: false,
          writable: false,
          message: 'dataPath is required',
        });
        return;
      }

      const validation = await configService.validate(dataPath);
      res.json(validation);
    } catch (err) {
      res.status(500).json({
        valid: false,
        exists: false,
        writable: false,
        message: (err as Error).message,
      });
    }
  });

  return router;
}
