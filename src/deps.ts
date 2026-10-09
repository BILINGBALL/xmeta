import { config } from './config.js';
import { fetchToyDetail, fetchToySource, type ToyDetail, type ToySource } from './lib/bili.js';
import { noopCache, redisCache, type Cache } from './lib/cache.js';

/**
 * 外部依赖的注入口。生产用 realBiliDeps，测试可以塞桩，
 * 这样认领的「验证成功」路径不必真去 bilibili.com 抓页面。
 */
export type BiliDeps = {
  fetchToyDetail: (slug: string) => Promise<ToyDetail | null>;
  fetchToySource: (slug: string) => Promise<ToySource>;
};

export const realBiliDeps: BiliDeps = { fetchToyDetail, fetchToySource };

export type AppDeps = {
  bili: BiliDeps;
  /** 读缓存。没配 REDIS_URL 就是空转实现，测试里塞 MemoryCache */
  cache: Cache;
};

export const realDeps: AppDeps = {
  bili: realBiliDeps,
  cache: config.REDIS_URL ? redisCache(config.REDIS_URL) : noopCache,
};
