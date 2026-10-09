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
  /**
   * 读缓存，没有就回源并写进去。**同一个键的并发回源只会发生一次** ——
   * 这就是防惊群的那一道：热键过期的一瞬间，几百个请求不会一起扑向数据库。
   */
  getOrFill<T>(key: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T>;
  del(...keys: string[]): Promise<void>;
  /**
   * 主动连一次，好让「Redis 就绪」早点出现在启动日志里。
   * 没配 Redis 就是空转；调用方**别 await 它** —— 连不上时它要等到超时。
   */
  warmup(): Promise<void>;
  close(): Promise<void>;
};

/** 没配 Redis 时用它 —— 全是空转，调用方不用写 if */
export const noopCache: Cache = {
  enabled: false,
  async get() {
    return undefined;
  },
  async set() {},
  async getOrFill(_key, _ttl, fill) {
    return fill();
  },
  async del() {},
  async warmup() {},
  async close() {},
};

/**
 * 给 TTL 加 0~5 秒抖动。
 *
 * 不加的话，一批同时写入的键会在同一毫秒集体过期 —— 那一刻所有请求一起回源。
 * 抖动之后它们错开了，最多是零散回源。
 */
function withJitter(ttlSeconds: number): number {
  return ttlSeconds + Math.floor(Math.random() * 5);
}

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
    this.store.set(key, { value, exp: Date.now() + withJitter(ttlSeconds) * 1000 });
  }

  /** 单飞：同一个键并发回源时，后面的等第一个的结果 */
  private inflight = new Map<string, Promise<unknown>>();

  getOrFill<T>(key: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const task = (async () => {
      const hit = await this.get<T>(key);
      if (hit !== undefined) return hit;
      const value = await fill();
      await this.set(key, value, ttlSeconds);
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }

  async warmup(): Promise<void> {}

  async close(): Promise<void> {
    this.store.clear();
  }
}

export function redisCache(url: string): Cache {
  /** 进程内单飞表：同一个键的并发回源只留一个 */
  const inflight = new Map<string, Promise<unknown>>();
  const redis = new Redis(url, {
    // **惰性连接**：import 这个模块不建连接。否则测试、脚本这些只 import 的
    // 场景会平白挂一个 socket，进程跑完都退不出去（实测：跑测试直接卡死）。
    lazyConnect: true,
    // 断线时不要排队等，直接失败 —— 排队会把请求卡住
    enableOfflineQueue: false,
    // 单条命令的上限，超了就当 miss。绝不让缓存拖慢接口
    commandTimeout: 200,
    maxRetriesPerRequest: 1,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });

  // 错误日志节流：Redis 挂掉时每个请求都会报错，不节流就是刷屏
  let lastErrorAt = 0;
  redis.on('error', (e: Error) => {
    const now = Date.now();
    if (now - lastErrorAt < 30_000) return;
    lastErrorAt = now;
    console.warn('[xmeta] Redis 出错，读缓存降级（请求照走数据库）：', e.message);
  });
  redis.on('ready', () => console.log('[xmeta] Redis 就绪，读缓存已开启'));

  /**
   * 能不能用 Redis。**绝不能在这里无限等** —— 连不上时只等一次 300ms，
   * 之后 status 会停在 connecting，直接返回 false（请求照走数据库）。
   */
  async function ready(): Promise<boolean> {
    if (redis.status === 'ready') return true;
    if (redis.status === 'wait') {
      try {
        await Promise.race([
          redis.connect(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 300)),
        ]);
      } catch {
        return false;
      }
    }
    // connect() 成功的话 status 已经变了，但 TS 看不到那次副作用
    return String(redis.status) === 'ready';
  }

  return {
    enabled: true,
    async warmup(): Promise<void> {
      await ready();
    },
    async get<T>(key: string): Promise<T | undefined> {
      if (!(await ready())) return undefined;
      try {
        const raw = await redis.get(key);
        return raw === null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      if (!(await ready())) return;
      try {
        await redis.set(key, JSON.stringify(value), 'EX', withJitter(ttlSeconds));
      } catch {
        /* 缓存写失败不该影响主流程 */
      }
    },
    async getOrFill<T>(key: string, ttlSeconds: number, fill: () => Promise<T>): Promise<T> {
      if (!(await ready())) return fill(); // Redis 不在就老实查库
      // 先查缓存；miss 时**进程内**单飞 —— 同一个键的并发回源只发生一次
      const hit = await this.get<T>(key);
      if (hit !== undefined) return hit;

      const running = inflight.get(key);
      if (running) return running as Promise<T>;

      const task = fill()
        .then(async (value) => {
          await this.set(key, value, ttlSeconds);
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, task);
      return task;
    },
    async del(...keys: string[]): Promise<void> {
      if (!(await ready())) return;
      try {
        if (keys.length > 0) await redis.del(...keys);
      } catch {
        /* 同上 */
      }
    },
    async close(): Promise<void> {
      try {
        redis.disconnect(); // 可能压根没连过，disconnect 比 quit 稳
      } catch {
        /* 忽略 */
      }
    },
  };
}
