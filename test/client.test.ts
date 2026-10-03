import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 接入脚本的冒烟测试。
 *
 * 只做一件事：**确认它在浏览器里能加载完、并把 XMETA 挂到 window 上**。
 *
 * 这个测试是有来历的：有一次改 login/doExchange 时用整段替换，
 * 把 applyTokens / getRemainingMs / logout 三个函数一起删掉了。
 * 语法检查过（它们只是被引用，不是语法错），服务端测试也过（那些
 * 只测 API）。但浏览器一加载就抛 ReferenceError —— 因为
 * `global.XMETA = { logout: logout }` 引用了未定义的东西，赋值失败，
 * XMETA 根本没挂上去。用户看到的是「can not find variable: XMETA」。
 */

const SRC = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../toy-side/xmeta-client.js'),
  'utf8',
);

const CLIENT_PATH = '/toy/abc123/index.html';

/** 造一个够用的浏览器环境，把脚本真正跑起来 */
function loadClient(): Record<string, any> {
  const store = new Map<string, string>();

  const sandbox: Record<string, any> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    navigator: { userAgent: 'node-test' },
    location: {
      href: 'https://www.bilibilitoy.com' + CLIENT_PATH,
      pathname: CLIENT_PATH,
      search: '',
      hash: '',
      protocol: 'https:',
    },
    history: { replaceState: () => {} },
    // 脚本尾部会在 window 上挂 load 监听（等调用方的 configure 跑完）
    addEventListener: () => {},
    document: {
      readyState: 'loading',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    crypto: {
      getRandomValues: (a: Uint8Array) => a,
      subtle: { digest: async () => new ArrayBuffer(32) },
    },
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

test('接入脚本能加载，并把 XMETA 挂到 window 上', () => {
  const sandbox = loadClient();
  assert.ok(
    sandbox.XMETA,
    'XMETA 没挂上去 —— 脚本在加载期就抛错了（多半是引用了不存在的变量）',
  );
});

test('XMETA 暴露的接口齐全', () => {
  const { XMETA } = loadClient();
  const expected = [
    'configure',
    'login',
    'handleRedirect',
    'onSession',
    'onError',
    'getSession',
    'getRemainingMs',
    'logout',
  ];
  for (const name of expected) {
    assert.equal(typeof XMETA[name], 'function', `XMETA.${name} 应该是函数`);
  }
});

test('configure 之后几个同步接口都能正常调用', () => {
  const { XMETA } = loadClient();
  XMETA.configure({
    apiBase: 'https://api.example.com',
    centerToySlug: 'xmeta',
    clientId: 'xmeta_test',
  });

  assert.equal(XMETA.getRemainingMs(), 0, '没登录时剩余时间应该是 0');
  assert.equal(XMETA.getSession(), null, '没登录时不该有 session');
  XMETA.logout(); // 不该抛

  // 订阅/退订都要能跑通
  const off = XMETA.onSession(() => {});
  off();
  const offErr = XMETA.onError(() => {});
  offErr();
});

test('configure 缺参数时给出可读的报错', () => {
  const { XMETA } = loadClient();
  assert.throws(
    () => XMETA.configure({ apiBase: 'https://api.example.com' }),
    /请先配置/,
  );
});
