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
      // 测试可以塞一个替身进来，模拟断网 / 服务端报错
      if (sandbox.__fetchImpl) return sandbox.__fetchImpl(url);
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
    addEventListener: (ev: string, fn: () => void) => {
      if (ev === 'load') sandbox.__onLoad = fn;
    },
    document: {
      readyState: 'loading',
      hidden: false,
      addEventListener: (ev: string, fn: () => void) => {
        if (ev === 'visibilitychange') sandbox.__onVis = fn;
      },
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
  /** 模拟页面切前台/后台 —— 会触发 visibilitychange */
  sandbox.__setHidden = (h: boolean) => {
    sandbox.document.hidden = h;
    sandbox.__onVis?.();
  };
  /** 模拟 load 事件 —— autoHandle 在这里跑 */
  sandbox.__fireLoad = () => sandbox.__onLoad?.();
  return sandbox;
}

const CFG = { apiBase: 'https://api.example.com', centerToySlug: 'xmeta', clientId: 'xmeta_t' };
/** mySlug() 从 CLIENT_PATH 解出来就是它 */
const MY_SLUG = 'abc123';

/**
 * 往共享槽里放一枚待兑换的授权码 —— 中心 toy 的 bridge.html 就是这么写的。
 * 值结构是一份公开契约，见 README。
 */
function seedCode(sandbox: Record<string, any>, slot: Record<string, unknown>) {
  sandbox.__store.set('xmeta:code', JSON.stringify({
    v: 1,
    clientId: CFG.clientId,
    expiresAt: Date.now() + 60_000,   // 和线上一致：授权码 60 秒
    ts: Date.now(),
    ...slot,
  }));
}

/** 造一轮「正在进行中」的尝试 —— login() 写的就是这两个键 */
function seedAttempt(sandbox: Record<string, any>, state = 'S') {
  sandbox.__store.set('xmeta:pkce:xmeta_t', 'v');
  sandbox.__store.set('xmeta:pkce:xmeta_t:st', state);
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
    'onCodeReady',
    'pendingCode',
    'diagnose',
    'completeLogin',
    'onSession',
    'getSession',
    'getRemainingMs',
    'setSession',
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
  const offCode = XMETA.onCodeReady(() => {});
  offCode();
});

test('configure 缺参数时给出可读的报错', () => {
  const { XMETA } = loadClient();
  assert.throws(
    () => XMETA.configure({ apiBase: 'https://api.example.com' }),
    /请先配置/,
  );
});

// ─────────────────────────────────────────────────────────────
// 检测待兑换的 code：只读、幂等、不消耗
//
// 这一组守着一条**不变式**：
//   槽只在三种终态被删 —— 兑换成功 / 判定过期 / 用户取消。
//   任何「看一眼」都不许删。
//
// 来历：以前的 takeSharedResult() 是先 clearShared() 再校验 state，于是一个
// **没有 verifier 的实例**读一眼也能把结果毁掉，让真正能兑换的实例扑空。
// 这和「后台实例先醒来抢 code」是并列的两个杀手。
// ─────────────────────────────────────────────────────────────

test('检测到待兑换的 code 就通知 onCodeReady，但不兑换也不清槽', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  let got: any = null;
  sb.XMETA.onCodeReady((p: any) => { got = p; });

  const pending = sb.XMETA.handleRedirect();

  assert.ok(pending, '应该检测到待兑换的 code');
  assert.equal(pending.code, 'C');
  assert.ok(got, 'onCodeReady 应该被触发');
  assert.equal(got.code, 'C');
  assert.deepEqual(sb.__fetched, [], '检测不该发任何请求');
  assert.ok(sb.__store.has('xmeta:code'), '槽要原样留着，等用户点');
});

test('同一枚 code 只通知一次（去重标记只在内存里）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  sb.XMETA.handleRedirect();
  sb.XMETA.handleRedirect();
  sb.XMETA.handleRedirect();

  assert.equal(n, 1);
});

test('上一轮的残留不触发通知，也**不清槽**', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  // 槽还在，但本地没有「正在进行的一轮」—— PKCE 记录早被清掉了
  seedCode(sb, { code: 'stale', state: 'stale-state', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  assert.equal(sb.XMETA.handleRedirect(), null);
  assert.equal(n, 0, '没有进行中的一轮就一定不能放行');
  assert.ok(sb.__store.has('xmeta:code'), '看一眼不许删 —— 别的实例可能还要用');
});

test('state 对不上本轮的，不触发也不清槽', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb, 'current-state');
  seedCode(sb, { code: 'old', state: 'a-different-state', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  assert.equal(sb.XMETA.handleRedirect(), null);
  assert.equal(n, 0);
  assert.ok(sb.__store.has('xmeta:code'));
});

test('发给别的 toy 的 code 不认（槽是全局单槽，靠值里的 clientId 分辨）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { clientId: 'xmeta_someone_else', code: 'C', state: 'S', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  assert.equal(sb.XMETA.handleRedirect(), null);
  assert.equal(n, 0);
  assert.ok(sb.__store.has('xmeta:code'), '更不能把别人的结果删了');
});

test('码过期了：不触发，并且清掉（过期是终态）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG, expiresAt: Date.now() - 1 });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  assert.equal(sb.XMETA.handleRedirect(), null);
  assert.equal(n, 0, '死码不该冒出一个点了必然失败的按钮');
  assert.equal(sb.__store.has('xmeta:code'), false, '过期是终态，清掉');
});

// ─────────────────────────────────────────────────────────────
// completeLogin：用户点的那一下才兑换
//
// 这是整条链路上唯一消费那枚一次性 code 的地方，绑在用户手势上 ——
// 只有用户看得见的页面能被点到，后台实例想抢也抢不了。
// ─────────────────────────────────────────────────────────────

test('pendingCode：有 code 时返回它，纯读不消耗', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  const p = sb.XMETA.pendingCode();

  assert.ok(p, '应该返回待兑换的 code');
  assert.equal(p.code, 'C');
  assert.ok(sb.__store.has('xmeta:code'), '纯读，不许删');
  assert.deepEqual(sb.__fetched, [], '更不该发请求');
  assert.equal(sb.XMETA.getSession(), null, '它只是「可兑换」，不是「已连接」');
});

test('pendingCode：没有待兑换的 code 就是 null', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  assert.equal(sb.XMETA.pendingCode(), null);
});

// ─────────────────────────────────────────────────────────────
// 为什么不是「可连接」
//
// 判据有七八条，全都不通过时外面看到的都是同一个 null —— 这正是
// 「每次症状一样、原因不一样」的由来。diagnose() 把卡在哪一条说出来。
// ─────────────────────────────────────────────────────────────

test('diagnose：卡在哪一条，逐条说得清楚', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  const reason = () => sb.XMETA.diagnose().pending.reason;

  assert.equal(reason(), 'no_slot', '槽里什么都没有');

  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });
  assert.equal(reason(), 'no_attempt', '本地没有进行中的一轮');

  seedAttempt(sb, 'current-state');
  assert.equal(reason(), 'state_mismatch', 'state 对不上');

  seedAttempt(sb, 'S');
  assert.equal(reason(), 'ok', '这时候才对');

  seedCode(sb, { clientId: 'xmeta_other', code: 'C', state: 'S', returnSlug: MY_SLUG });
  assert.equal(reason(), 'other_client', '这枚码是发给别的 toy 的');

  seedCode(sb, { code: 'C', state: 'S', returnSlug: 'some-other-toy' });
  assert.equal(reason(), 'other_toy', 'returnSlug 不是自己的');

  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG, expiresAt: Date.now() - 1 });
  assert.equal(reason(), 'expired', '码已经过期');
});

test('diagnose：已连接时直说，不再判 code', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb, 'S');
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));
  sb.XMETA.configure(CFG);   // 重新 configure 以恢复会话

  const d = sb.XMETA.diagnose();
  assert.equal(d.connected, true);
  assert.equal(d.pending.reason, 'already_connected');
});

test('completeLogin：用户点了才发请求，成功后才清槽', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  sb.XMETA.handleRedirect();               // 检测阶段
  assert.deepEqual(sb.__fetched, [], '检测阶段不该发请求');
  assert.ok(sb.__store.has('xmeta:code'), '检测阶段槽还在');

  const session = await sb.XMETA.completeLogin();

  assert.ok(session, '应该拿到 session');
  assert.equal(session.uid, '42');
  assert.equal(sb.__fetched.length, 1);
  assert.equal(sb.__store.has('xmeta:code'), false, '成功是终态，清槽');
  assert.equal(sb.__store.has('xmeta:pkce:xmeta_t'), false, 'PKCE 记录也一并清掉');
  assert.ok(sb.__store.has('xmeta:sess:xmeta_t'), '会话要落到本地');
});

test('completeLogin：没有待兑换的码时抛错，且带机器可读的 code', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  await assert.rejects(
    () => sb.XMETA.completeLogin(),
    (e: any) => e.code === 'no_pending_code',
  );
});

test('completeLogin：没有 PKCE 记录时抛错', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });   // 有码，但没有 attempt

  await assert.rejects(
    () => sb.XMETA.completeLogin(),
    (e: any) => e.code === 'no_pending_code' || e.code === 'no_pkce_record',
  );
});

test('completeLogin：传输失败不清槽，用户还能再点一次', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  sb.__fetchImpl = async () => ({
    ok: false, status: 503,
    json: async () => ({ error: { code: 'internal_error', message: '服务内部错误' } }),
  });

  await assert.rejects(() => sb.XMETA.completeLogin());
  assert.ok(sb.__store.has('xmeta:code'), '可重试的失败必须留着槽');
  assert.ok(sb.__store.has('xmeta:pkce:xmeta_t'), 'PKCE 记录也要留着');
});

test('completeLogin：另一个 tab 抢先兑换了，就采纳它写下的会话', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  sb.__fetchImpl = async () => ({
    ok: false, status: 409,
    json: async () => ({ error: { code: 'code_used', message: '授权码已被使用' } }),
  });
  // 赢的那个实例已经把会话写进同源的 localStorage
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));

  const session = await sb.XMETA.completeLogin();

  assert.ok(session, 'code_used 但会话已存在 → 当成功');
  assert.equal(session.uid, '42');
  assert.equal(sb.__store.has('xmeta:code'), false, '槽该清掉');
});

// ─────────────────────────────────────────────────────────────
// 回到前台
//
// 跳回来时页面要是没有重新加载，还是同一个实例 —— 这时候没人会再喊
// 一次「检测」，得靠 visibilitychange 补上，否则按钮永远不出现。
// ─────────────────────────────────────────────────────────────

test('回到前台立刻检测一次，把待兑换的码通知出来（页面没重载的情形）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedAttempt(sb);

  sb.__setHidden(true);
  // 用户去中心 toy 授权，这段期间结果被写进槽
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });

  let got: any = null;
  sb.XMETA.onCodeReady((p: any) => { got = p; });

  sb.__setHidden(false);      // 用户回来了，同一个实例

  assert.ok(got, '回到前台应该立刻检测到');
  assert.equal(got.code, 'C');
  assert.deepEqual(sb.__fetched, [], '只检测，不兑换');
  assert.ok(sb.__store.has('xmeta:code'), '槽还在，等用户点');
});

test('回到前台时码已被别的实例兑换走，就接手它写下的会话', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', state: 'S', returnSlug: MY_SLUG });
  // 别的实例兑换完写进本地的那份（同源共享）
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));

  sb.__setHidden(false);

  assert.deepEqual(sb.__fetched, [], '不该再去换');
  assert.ok(sb.XMETA.getSession(), '但应该接手别的实例写下的会话');
  assert.equal(sb.XMETA.getSession().uid, '42');
});

// ─────────────────────────────────────────────────────────────
// 等另一个页面实例把会话交出来
//
// 兑换改成手动之后竞态已经不存在了，但「另一个实例点了按钮、这个实例还
// 停在未连接」的窗口还在。它写进同源 localStorage 的会话，等一下就能读到。
// ─────────────────────────────────────────────────────────────

test('另一个实例兑换完之后，这边会把会话接过来', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  sb.__fireLoad();                                  // autoHandle：什么都拿不到
  await new Promise<void>((r) => setTimeout(r, 20));
  assert.equal(sb.XMETA.getSession(), null, '先确认这会儿确实没连上');

  // 另一个页面实例兑换完了，把会话写进同源的 localStorage
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));

  await new Promise<void>((r) => setTimeout(r, 700));   // 等一个轮询周期

  assert.ok(sb.XMETA.getSession(), '应该把另一个实例写下的会话接过来');
  assert.equal(sb.XMETA.getSession().uid, '42');
  assert.deepEqual(sb.__fetched, [], '接过来的，不该再发请求');
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

// ─────────────────────────────────────────────────────────────
// 装上一枚已有的 token（setSession）
//
// 场景：接入方把 token 存在自己的云存储里（按「登录用户 + toy」隔离、
// 跨设备），换台设备打开时读回来装进去就该是「已连接」，不用再过一次桥。
// 有效性只看 exp —— 前端不验签，要不要验是收数据那边的责任。
// ─────────────────────────────────────────────────────────────

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `h.${b64}.s`;
}

test('setSession：装上一枚还没过期的 token', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  let got: any = null;
  sb.XMETA.onSession((s: any) => { got = s; });

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const ok = sb.XMETA.setSession(fakeJwt({ sub: '77', exp }));

  assert.equal(ok, true, '未过期的 token 应该装上');
  assert.ok(got, 'onSession 应该被触发');
  assert.equal(got.uid, '77');
  assert.ok(sb.XMETA.getRemainingMs() > 0, '剩余时间应该是个正数');
  assert.ok(sb.__store.has('xmeta:sess:xmeta_t'), '要落到本地，刷新页面还在');
});

test('setSession：已过期的 token 拒绝，也不产生 session', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  const exp = Math.floor(Date.now() / 1000) - 1;
  assert.equal(sb.XMETA.setSession(fakeJwt({ sub: '77', exp })), false);
  assert.equal(sb.XMETA.getSession(), null);
  assert.equal(sb.__store.has('xmeta:sess:xmeta_t'), false, '过期的不该写进存储');
});

test('setSession：解不开 / 缺 exp / 空值一律拒绝', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);

  assert.equal(sb.XMETA.setSession('not-a-jwt'), false);
  assert.equal(sb.XMETA.setSession(fakeJwt({ sub: '77' })), false, '没有 exp 就不算有效');
  assert.equal(sb.XMETA.setSession(''), false);
  assert.equal(sb.XMETA.setSession(undefined), false);
  assert.equal(sb.XMETA.getSession(), null);
});

test('会话是按 clientId 分桶的，别的 toy 的不认', () => {
  const sb = loadClient();
  sb.__store.set('xmeta:sess:some_other_toy', JSON.stringify({
    jwt: 'a.b.c', uid: '99', expiresAt: Date.now() + 3600_000,
  }));

  sb.XMETA.configure(CFG);

  assert.equal(sb.XMETA.getSession(), null, '不该认别的 toy 存的会话');
});

test('onSession 回调抛错，不该把调用方的脚本一起带走', () => {
  const sb = loadClient();
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'a.b.c', uid: '42', expiresAt: Date.now() + 3600_000,
  }));
  sb.XMETA.configure(CFG);

  // 注册时会立刻同步回调（已经有 session）。回调里抛错 ——
  // 真实场景是回调引用了还没声明的变量。
  assert.doesNotThrow(() => {
    sb.XMETA.onSession(() => {
      throw new Error('回调炸了');
    });
  }, '回调的错不该冒到调用方');

  // 关键：后面的代码还要能正常跑。
  // 出过的事故就是这里注册的事件监听全没挂上，界面上「点了没反应」。
  let reached = false;
  sb.XMETA.onSession(() => { reached = true; });
  assert.equal(reached, true, '后面的注册应该照常执行');
});
