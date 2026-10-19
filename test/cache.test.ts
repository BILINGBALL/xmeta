import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryCache } from '../src/lib/cache.js';

/**
 * 写接口删缓存时，如果正好有一个读请求回源到一半，它可能在删完之后
 * 把旧值 set 回缓存 —— 接下来整个 TTL 都读到旧值。
 *
 * 实测踩过：世界 boss 攻击后页面偶尔显示旧血量，就是这个顺序。
 * del 现在会先等在途回源落地，再删。
 */
test('del 等待在途回源：旧值不能在删除之后又被写回缓存', async () => {
  const cache = new MemoryCache();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // 回源读到旧值后卡住，还没写缓存
  const reading = cache.getOrFill('row', 30, async () => {
    await gate;
    return 'old';
  });

  // 写接口此时落库并删缓存
  const deleting = cache.del('row');

  // 回源放行：它会先 set 一次，然后 del 才能删
  release();

  assert.equal(await reading, 'old');
  assert.equal(await deleting, undefined);
  assert.equal(
    await cache.get('row'),
    undefined,
    '删除之后缓存里不能还有旧值；下一次读必须回源',
  );
});

test('del 之后的下一次读拿到的是新值', async () => {
  const cache = new MemoryCache();
  let value = 'old';
  await cache.getOrFill('row', 30, async () => value);
  assert.equal(await cache.get('row'), 'old');

  value = 'new';
  await cache.del('row');
  assert.equal(await cache.getOrFill('row', 30, async () => value), 'new');
  assert.equal(await cache.get('row'), 'new');
});
