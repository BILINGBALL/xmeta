import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** 源码在 <repo>/toy-side/，src/routes 和 dist/routes 往上一层都是仓库根，所以路径一致 */
const CLIENT_JS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../toy-side/xmeta-client.js',
);

export async function staticRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 把接入脚本挂在服务端，第三方玩具直接：
   *   <script src="https://<你的域名>/xmeta-client.js"></script>
   *
   * 这样 SDK 只有一份，修 bug 不用让每个接入方重新上传自己的副本。
   * 和官方 toy-sdk 从 s1.hdslb.com 加载是一个路子。
   */
  app.get('/xmeta-client.js', async (_req, reply) => {
    let code: string;
    try {
      code = await readFile(CLIENT_JS, 'utf8');
    } catch {
      return reply
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('服务端上没有找到 xmeta-client.js');
    }
    reply.header('Cache-Control', 'public, max-age=300');
    // 玩具是跨域加载这个脚本的，放开来源（脚本内容不含任何机密）
    reply.header('Access-Control-Allow-Origin', '*');
    return reply.type('application/javascript; charset=utf-8').send(code);
  });
}
