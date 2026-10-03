import { fetchToyDetail, fetchToySource, type ToyDetail, type ToySource } from './lib/bili.js';

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
};

export const realDeps: AppDeps = { bili: realBiliDeps };
