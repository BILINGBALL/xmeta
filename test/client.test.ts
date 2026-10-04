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
function loadClient(existingStore?: Map<string, string>): Record<string, any> {
  const store = existingStore ?? new Map<string, string>();
  const fetched: string[] = [];

  const sandbox: Record<string, any> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    // 这几个是宿主提供的全局，不是 JS 内置，vm 上下文里没有
    URLSearchParams,
    URL,
    // 换取 token 走这个。记录调用，便于断言「该不该发请求」
    fetch: async (url: string) => {
      fetched.push(url);
      const payload = Buffer.from(JSON.stringify({ sub: '42' })).toString('base64url');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `h.${payload}.s`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      };
    },
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

  // 暴露给测试用
  sandbox.__store = store;
  sandbox.__fetched = fetched;
  return sandbox;
}

const CFG = { apiBase: 'https://api.example.com', centerToySlug: 'xmeta', clientId: 'xmeta_t' };
/** mySlug() 从 CLIENT_PATH 解出来就是它 */
const MY_SLUG = 'abc123';

function seedRes(sandbox: Record<string, any>, res: Record<string, unknown>) {
  sandbox.__store.set('xmeta:res', JSON.stringify({ ts: Date.now(), ...res }));
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

// ─────────────────────────────────────────────────────────────
// 残留结果的处置
//
// 这一组是针对一个实机 bug 的回归：换身份成功之后退出 B站、再进来，
// 页面加载时报「找不到本次登录的 PKCE 记录」。
//
// 来路是上一轮写回的结果没被消费掉（页面没重载 + 轮询超时），
// 而它的 verifier 早被清掉了。原来的判断写成 `if (expect && ...)`，
// 把「没有正在进行的尝试」当成了放行条件 —— 恰恰那是最该拒绝的。
// ─────────────────────────────────────────────────────────────

test('上一轮残留的结果会被忽略，不拿去换、也不报错', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  // 结果还在，但 PKCE 记录早没了（上一轮换完之后清的）
  seedRes(sb, { code: 'stale-code', st: 'stale-state', returnSlug: MY_SLUG });

  const session = await sb.XMETA.handleRedirect();

  assert.equal(session, null, '残留结果不该换来 session');
  assert.equal(sb.__store.has('xmeta:res'), false, '应该被清掉，免得反复触发');
  assert.deepEqual(sb.__fetched, [], '不该真的发请求去换');
});

test('state 对不上当前这一轮的，同样忽略', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  sb.__store.set('xmeta:pkce:xmeta_t', 'some-verifier')
  sb.__store.set('xmeta:pkce:xmeta_t:st', 'current-state')
  seedRes(sb, { code: 'old-code', st: 'a-different-state', returnSlug: MY_SLUG });

  const session = await sb.XMETA.handleRedirect();

  assert.equal(session, null);
  assert.deepEqual(sb.__fetched, []);
});

test('发给别的玩具的结果不认识', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  sb.__store.set('xmeta:pkce:xmeta_t', 'v');
  sb.__store.set('xmeta:pkce:xmeta_t:st', 'S');
  seedRes(sb, { code: 'C', st: 'S', returnSlug: 'some-other-toy' });

  const session = await sb.XMETA.handleRedirect();
  assert.equal(session, null);
  assert.deepEqual(sb.__fetched, []);
});

test('state 对得上时才真的去换，并拿到 session', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  sb.__store.set('xmeta:pkce:xmeta_t', 'v');
  sb.__store.set('xmeta:pkce:xmeta_t:st', 'S');
  seedRes(sb, { code: 'C', st: 'S', returnSlug: MY_SLUG });

  const session = await sb.XMETA.handleRedirect();

  assert.ok(session, '应该拿到 session');
  assert.equal(session.uid, '42');
  assert.equal(sb.__fetched.length, 1, '应该只发一次请求');
  assert.equal(sb.__store.has('xmeta:res'), false, '用完要清掉');
  assert.equal(sb.__store.has('xmeta:pkce:xmeta_t'), false, 'PKCE 记录也要清掉');
  assert.equal(sb.XMETA.getRemainingMs() > 0, true, '剩余时间应该是个正数');
  assert.ok(sb.__store.has('xmeta:sess:xmeta_t'), '会话要存到本地');
});

// ─────────────────────────────────────────────────────────────
// 会话持久化
//
// 不存的话页面一刷新身份就没了，用户每次进来都得重新走一遍过桥 ——
// 而 token 本来能活 3~24 小时，中间刷新几十次是常态。
// ─────────────────────────────────────────────────────────────

test('重开页面之后身份还在，不用重新授权', () => {
  const first = loadClient();
  first.XMETA.configure(CFG);
  // 模拟上一次成功换取之后存下来的
  first.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c',
    uid: '42',
    expiresAt: Date.now() + 3600_000,
  }));

  // 同一个浏览器环境（同一个 store）重新加载脚本 —— 等价于刷新页面
  const second = loadClient(first.__store);
  second.XMETA.configure(CFG);

  const s = second.XMETA.getSession();
  assert.ok(s, '应该从本地恢复出身份');
  assert.equal(s.uid, '42');
  assert.ok(second.XMETA.getRemainingMs() > 0);
  assert.deepEqual(second.__fetched, [], '恢复身份不该发任何请求');
});

test('恢复身份时会通知 onSession', () => {
  const sb = loadClient();
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));

  let got = null;
  sb.XMETA.configure(CFG);
  sb.XMETA.onSession((s: unknown) => { got = s; });

  assert.ok(got, 'onSession 应该立刻拿到已恢复的身份');
});

test('过期的会话不会被恢复，并且顺手清掉', () => {
  const sb = loadClient();
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() - 1000,
  }));

  sb.XMETA.configure(CFG);

  assert.equal(sb.XMETA.getSession(), null, '过期的不该恢复');
  assert.equal(sb.XMETA.getRemainingMs(), 0);
  assert.equal(sb.__store.has('xmeta:sess:xmeta_t'), false, '应该被清掉');
});

test('logout 会连本地存的会话一起清掉', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));
  sb.XMETA.configure(CFG); // 重新 configure 以恢复
  assert.ok(sb.XMETA.getSession(), '先确认恢复成功');

  sb.XMETA.logout();

  assert.equal(sb.XMETA.getSession(), null);
  assert.equal(sb.__store.has('xmeta:sess:xmeta_t'), false, '存储里也要清掉');
});

test('会话是按 clientId 分桶的，别的玩具的不认', () => {
  const sb = loadClient();
  sb.__store.set('xmeta:sess:some_other_toy', JSON.stringify({
    jwt: 'a.b.c', uid: '99', expiresAt: Date.now() + 3600_000,
  }));

  sb.XMETA.configure(CFG);

  assert.equal(sb.XMETA.getSession(), null, '不该认别的玩具存的会话');
});
