import { Redis } from 'ioredis';

/**
 * 读缓存。
 *
 * 只缓存**读** —— 写永远直接落库，所以缓存丢了/挂了只是慢一点，不会脏。
 *
 * 失效策略（两种粒度，故意的）：
 *   · 单格：键是 `kv:row:<toy>:<scope>:<uid>`，**写完立刻删** —— 写的人立刻能看到自己的改动
 *   · 列表：键里带上可见性/tag/分页，**只靠 30 秒 TTL 过期**，不做主动失效。
 *     列表要枚举「哪些页、哪些 tag 受影响了」才删得干净，代价远大于收益；
 *     代价是列表最多旧 30 秒，世界 boss 那种场景可以接受。
 *
 * 一切 Redis 操作都有超时并且**失败即当作 miss** —— 缓存绝不允许把请求带挂。
 */
export type Cache = {
  readonly enabled: boolean;
  /** 命中返回数据；未命中、出错一律返回 undefined（注意和「缓存了一个 null」区分） */
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  close(): Promise<void>;
};

/** 没配 Redis 时用它 —— 全是空转，调用方不用写 if */
export const noopCache: Cache = {
  enabled: false,
  async get() {
    return undefined;
  },
  async set() {},
  async del() {},
  async close() {},
};

/** 测试用：进程内 Map，行为和真缓存一致 */
export class MemoryCache implements Cache {
  readonly enabled = true;
  private store = new Map<string, { value: unknown; exp: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, exp: Date.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

export function redisCache(url: string): Cache {
  const redis = new Redis(url, {
    // 断线时不要排队等，直接失败 —— 排队会把请求卡住
    enableOfflineQueue: false,
    // 单条命令的上限，超了就当 miss。绝不让缓存拖慢接口
    commandTimeout: 200,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });

  redis.on('error', (e: Error) => {
    console.warn('[xmeta] Redis 出错，读缓存降级（请求照走数据库）：', e.message);
  });
  redis.on('ready', () => console.log('[xmeta] Redis 就绪，读缓存已开启'));

  return {
    enabled: true,
    async get<T>(key: string): Promise<T | undefined> {
      try {
        const raw = await redis.get(key);
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch {
        /* 缓存写失败不该影响主流程 */
      }
    },
    async del(...keys: string[]): Promise<void> {
      try {
        if (keys.length > 0) await redis.del(...keys);
      } catch {
        /* 同上 */
      }
    },
    async close(): Promise<void> {
      try {
        await redis.quit();
      } catch {
        /* 忽略 */
      }
    },
  };
}
