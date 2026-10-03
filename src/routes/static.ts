import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** 源码在 <repo>/toy-side/，src/routes 和 dist/routes 往上一层都是仓库根，所以路径一致 */
const TOY_SIDE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../toy-side',
);

type Asset = { file: string; type: string };

/**
 * 玩具端共用的静态资源。挂在服务端而不是让每个玩具各自存一份：
 * 这样只有一份，修 bug 不用挨个通知接入方重新上传。
 * 和官方 toy-sdk 从 s1.hdslb.com 加载是一个路子。
 */
const ASSETS: Record<string, Asset> = {
  '/xmeta-client.js': { file: 'xmeta-client.js', type: 'application/javascript; charset=utf-8' },
  '/xmeta-ui.css': { file: 'xmeta-ui.css', type: 'text/css; charset=utf-8' },
};

export async function staticRoutes(app: FastifyInstance): Promise<void> {
  for (const [route, asset] of Object.entries(ASSETS)) {
    app.get(route, async (_req, reply) => {
      let body: string;
      try {
        body = await readFile(path.join(TOY_SIDE, asset.file), 'utf8');
      } catch {
        return reply
          .status(404)
          .type('text/plain; charset=utf-8')
          .send(`服务端上没有找到 ${asset.file}`);
      }
      reply.header('Cache-Control', 'public, max-age=300');
      // 玩具是跨域加载这些资源的，放开来源（内容里不含任何机密）
      reply.header('Access-Control-Allow-Origin', '*');
      return reply.type(asset.type).send(body);
    });
  }
}
