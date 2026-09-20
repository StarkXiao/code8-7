import path from 'node:path';
import crypto from 'node:crypto';
import express, { type Express } from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { requireAuth } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { authRouter } from './modules/auth.routes';
import { workspaceRouter } from './modules/workspace.routes';
import { recipeRouter } from './modules/recipe.routes';
import { versionRouter } from './modules/version.routes';
import { audioRouter } from './modules/audio.routes';
import { vagueItemRouter } from './modules/vagueItem.routes';
import { commentRouter } from './modules/comment.routes';
import { verificationRouter } from './modules/verification.routes';
import { notificationRouter } from './modules/notification.routes';
import { statsRouter } from './modules/stats.routes';
import { runIntegrityScan } from './services/integrity';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 每个请求一个 id，日志与错误响应都能顺着它定位
  app.use((req, res, next) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID();
    (req as express.Request & { id: string }).id = id;
    res.setHeader('x-request-id', id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request & { id: string }).id,
      autoLogging: { ignore: (req) => req.url === '/api/healthz' },
    }),
  );

  app.use(
    cors({
      origin: [env.webOrigin],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  /* ---------------- 健康检查 ---------------- */
  app.get('/api/healthz', (_req, res) => {
    res.json({
      data: {
        status: 'ok',
        asrProvider: env.asrProvider,
        storageDriver: env.storageDriver,
        database: env.isSqlite ? 'sqlite' : 'external',
        uptimeSeconds: Math.round(process.uptime()),
      },
    });
  });

  /**
   * 运维用：手动触发一次音频完整性巡检。
   * 它会遍历磁盘、读文件算校验和，开销不小，因此必须登录后才能调用。
   */
  app.post('/api/admin/integrity-scan', requireAuth, async (_req, res, next) => {
    try {
      res.json({ data: await runIntegrityScan(true) });
    } catch (error) {
      next(error);
    }
  });

  /* ---------------- 业务路由 ---------------- */
  // 只对"口令入口"限流。不能整个 /api/auth 一起限：/auth/me 与 /auth/refresh
  // 是正常使用中会反复调用的，而且一家人往往共用同一个出口 IP，限太狠会误伤自己人。
  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'auth:login' }));
  app.use(
    '/api/auth/register',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'auth:register' }),
  );
  app.use('/api/auth', authRouter);
  app.use('/api/workspaces', workspaceRouter);
  app.use('/api/recipes', recipeRouter);
  app.use('/api', versionRouter);
  app.use('/api', audioRouter);
  app.use('/api', vagueItemRouter);
  app.use('/api', commentRouter);
  app.use('/api', verificationRouter);
  app.use('/api', notificationRouter);
  app.use('/api', statsRouter);

  /* ---------------- 前端静态托管 ---------------- */
  if (env.hasWebBuild) {
    const webDist = env.webDistDir;
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
        next();
        return;
      }
      res.sendFile(path.join(webDist, 'index.html'), (error) => {
        if (error) next();
      });
    });
  }

  /* ---------------- 兜底 ---------------- */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
