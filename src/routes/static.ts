import { createHash } from 'node:crypto';
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
    app.get(route, async (req, reply) => {
      let body: string;
      try {
        body = await readFile(path.join(TOY_SIDE, asset.file), 'utf8');
      } catch {
        return reply
          .status(404)
          .type('text/plain; charset=utf-8')
          .send(`服务端上没有找到 ${asset.file}`);
      }

      // 内容哈希当 ETag，配 no-cache（每次回源校验，没变就 304）。
      //
      // 不用 max-age：这两个文件改完要立刻对所有玩具生效。带 5 分钟缓存的话，
      // 「服务器到底部署了没有」会变成一个说不清的问题 —— 明明 git pull 了，
      // 用户那边还是旧脚本，只能靠猜。实测为此浪费过两轮排查。
      //
      // no-cache 不等于不缓存：命中 ETag 走 304，代价很小。
      const hash = createHash('sha256').update(body).digest('hex');
      const etag = `"${hash.slice(0, 16)}"`;

      reply.header('ETag', etag);
      reply.header('Cache-Control', 'no-cache');
      // 方便一眼看出线上跑的是哪一版：curl -I 就能看到
      reply.header('X-Xmeta-Asset-Hash', hash.slice(0, 8));
      reply.header('Access-Control-Allow-Origin', '*');

      if (req.headers['if-none-match'] === etag) {
        return reply.status(304).send();
      }
      return reply.type(asset.type).send(body);
    });
  }
}
