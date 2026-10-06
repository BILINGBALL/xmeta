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
    fetch: async (url: string, init?: any) => {
      fetched.push(url);
      // 测试可以塞一个替身进来，模拟断网 / 服务端报错；init 一并传出，
      // 好断言请求体
      if (sandbox.__fetchImpl) return sandbox.__fetchImpl(url, init);
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
/** 中心 toy 的 toy_id —— App 端原生拼的回跳特征里带的是它 */
const CENTER_TOY_ID = '39945062320128';

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
// 来历：以前的 takeSharedResult() 是先 clearShared() 再校验，于是一个
// **没打算兑换的实例**读一眼也能把结果毁掉，让真正能兑换的实例扑空。
// 这和「后台实例先醒来抢 code」是并列的两个杀手。
// ─────────────────────────────────────────────────────────────

test('检测到待兑换的 code 就通知 onCodeReady，但不兑换也不清槽', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

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
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  sb.XMETA.handleRedirect();
  sb.XMETA.handleRedirect();
  sb.XMETA.handleRedirect();

  assert.equal(n, 1);
});

test('本地没有「进行中的一轮」也认 —— 那份记录可能已经被平台回收了', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  // 槽里有码，本地什么都没有。这正是线上那个 bug 的现场：人在中心 toy
  // 那边挑时长，这段时间里第三方 toy 自己的记录被回收了，回来只读槽。
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  let got: any = null;
  sb.XMETA.onCodeReady((p: any) => { got = p; });

  const pending = sb.XMETA.handleRedirect();

  assert.ok(pending, '只读槽就该认 —— 判据全在槽自己身上');
  assert.equal(got.code, 'C');
  assert.ok(sb.__store.has('xmeta:code'), '槽要留着，等用户点兑换');
});

test('App 里回来：URL 带中心 toy 的回跳特征、槽里有码 → 检测到', () => {
  const sb = loadClient();
  sb.XMETA.configure({ ...CFG, centerToyId: CENTER_TOY_ID });
  // App 内 toy.navigate 不透传 extra，落回来那页的 URL 上只有原生拼的这一串
  sb.location.search = '?from_spmid=toy.toy-detail.' + CENTER_TOY_ID + '.0';
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  let got: any = null;
  sb.XMETA.onCodeReady((p: any) => { got = p; });

  assert.ok(sb.XMETA.handleRedirect(), '应该认这是「回来了」');
  assert.equal(got.code, 'C');
});

test('发给别的 toy 的 code 不认（槽是全局单槽，靠值里的 clientId 分辨）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { clientId: 'xmeta_someone_else', code: 'C', returnSlug: MY_SLUG });

  let n = 0;
  sb.XMETA.onCodeReady(() => { n++; });

  assert.equal(sb.XMETA.handleRedirect(), null);
  assert.equal(n, 0);
  assert.ok(sb.__store.has('xmeta:code'), '更不能把别人的结果删了');
});

test('码过期了：不触发，并且清掉（过期是终态）', () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG, expiresAt: Date.now() - 1 });

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

test('completeLogin：用户点了才发请求，成功后才清槽', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  sb.XMETA.handleRedirect();               // 检测阶段
  assert.deepEqual(sb.__fetched, [], '检测阶段不该发请求');
  assert.ok(sb.__store.has('xmeta:code'), '检测阶段槽还在');

  const session = await sb.XMETA.completeLogin();

  assert.ok(session, '应该拿到 session');
  assert.equal(session.uid, '42');
  assert.equal(sb.__fetched.length, 1);
  assert.equal(sb.__store.has('xmeta:code'), false, '成功是终态，清槽');
  assert.ok(sb.__store.has('xmeta:sess:xmeta_t'), '会话要落到本地');
});

test('兑换只要 code —— 本地什么都不记也换得成', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  // 本地一个字节都没写（模拟平台把该清的都清了）
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  let sent: any = null;
  sb.__fetchImpl = async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: `h.${Buffer.from(JSON.stringify({ sub: '42' })).toString('base64url')}.s`,
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    };
  };

  const session = await sb.XMETA.completeLogin();

  assert.ok(session, '应该换到 session');
  assert.equal(sent.code, 'C');
  assert.equal(sent.client_id, CFG.clientId);
  assert.deepEqual(Object.keys(sent).sort(), ['client_id', 'code', 'grant_type'],
    '请求体就这三样，没有 verifier 之类的东西');
  assert.equal(sb.__store.has('xmeta:code'), false, '成功是终态，清槽');
});

test('已连接时点「重新申请」：新码照样认，把旧凭证换掉', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  // 手上已经有一枚还能用的凭证
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'old.jwt', uid: '42', expiresAt: Date.now() + 3600_000,
  }));
  sb.XMETA.configure(CFG); // 再 configure 一次，让会话恢复进来
  assert.ok(sb.XMETA.getSession(), '先确认确实已经连上了');

  // 用户点了「重新申请」，从中心 toy 带着新码回来
  seedCode(sb, { code: 'NEW', returnSlug: MY_SLUG });

  let got: any = null;
  sb.XMETA.onCodeReady((p: any) => { got = p; });

  assert.ok(sb.XMETA.handleRedirect(), '已连接也必须认出这枚新码');
  assert.equal(got.code, 'NEW');

  const session = await sb.XMETA.completeLogin();

  assert.equal(sb.__fetched.length, 1, '必须真去兑换，而不是直接返回旧会话');
  assert.notEqual(session.jwt, 'old.jwt', '拿到的应该是新凭证');
  assert.equal(sb.__store.has('xmeta:code'), false, '成功是终态，清槽');
});

test('已连接但槽里没码：completeLogin 仍然幂等地返回已有会话', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  sb.__store.set('xmeta:sess:xmeta_t', JSON.stringify({
    jwt: 'old.jwt', uid: '42', expiresAt: Date.now() + 3600_000,
  }));
  sb.XMETA.configure(CFG);

  const session = await sb.XMETA.completeLogin();

  assert.ok(session, '不该抛错');
  assert.equal(session.jwt, 'old.jwt');
  assert.deepEqual(sb.__fetched, [], '没有码就不该发请求');
});

test('completeLogin：没有待兑换的码时抛错，且带机器可读的 code', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  await assert.rejects(
    () => sb.XMETA.completeLogin(),
    (e: any) => e.code === 'no_pending_code',
  );
});

test('completeLogin：传输失败不清槽，用户还能再点一次', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

  sb.__fetchImpl = async () => ({
    ok: false, status: 503,
    json: async () => ({ error: { code: 'internal_error', message: '服务内部错误' } }),
  });

  await assert.rejects(() => sb.XMETA.completeLogin());
  assert.ok(sb.__store.has('xmeta:code'), '可重试的失败必须留着槽');
});

test('completeLogin：另一个 tab 抢先兑换了，就采纳它写下的会话', async () => {
  const sb = loadClient();
  sb.XMETA.configure(CFG);
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

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

  sb.__setHidden(true);
  // 用户去中心 toy 授权，这段期间结果被写进槽
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });

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
  seedCode(sb, { code: 'C', returnSlug: MY_SLUG });
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
// 有效性只看 exp —— 客户端验不了签，真正的校验在接入方服务端。
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
