import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.js';
import { realDeps, type AppDeps } from './deps.js';
import { AppError } from './errors.js';
import { bridgeRoutes } from './routes/bridge.js';
import { claimRoutes } from './routes/claim.js';
import { staticRoutes } from './routes/static.js';
import { tokenRoutes } from './routes/token.js';
import { wellKnownRoutes } from './routes/wellknown.js';

export async function buildApp(deps: AppDeps = realDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // toyOpenId 是密钥级数据，绝不能进日志
      redact: {
        paths: ['req.body.toyOpenId', 'req.body.code_verifier', 'req.body.code'],
        censor: '[redacted]',
      },
    },
    bodyLimit: 64 * 1024,
    trustProxy: config.TRUST_PROXY,
  });

  await app.register(cors, {
    // toy 的内层 iframe 固定跑在 https://www.bilibilitoy.com
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        },
      });
    }

    // body 不是合法 JSON / 缺 Content-Type 等
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'bad_request', message: (error as Error).message },
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: { code: 'internal_error', message: '服务内部错误' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: `没有这个接口：${request.method} ${request.url}` },
    });
  });

  await app.register(wellKnownRoutes);
  await app.register(staticRoutes);
  await app.register(claimRoutes, { bili: deps.bili });
  await app.register(bridgeRoutes);
  await app.register(tokenRoutes);

  return app;
}
