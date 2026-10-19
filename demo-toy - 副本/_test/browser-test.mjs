/**
 * 用一个真的 Chrome（无头）把 demo 页面跑起来，走完主要交互。
 *
 * 页面里的两个外部脚本换成本地文件，接口指向 _test/mock-server.mjs，
 * 其余（SDK、页面、DOM 事件）都是真的。
 *
 * 跑法：node _test/browser-test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMockServer, CLIENT_ID, MY_UID } from './mock-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────────
// 一个很小的 CDP 客户端
// ─────────────────────────────────────────────
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')))
    })
    this.ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch (e) { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
        return
      }
      const list = this.handlers.get(msg.method) || []
      for (const fn of list) {
        try { fn(msg.params || {}, msg.sessionId) } catch (e) { /* 忽略 */ }
      }
    })
    this.ws.addEventListener('close', () => { this.closed = true })
  }

  send(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 已断开'))
    const id = ++this.id
    const msg = { id, method, params: params || {} }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(msg))
    })
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }

  close() {
    try { this.ws.close() } catch (e) { /* 忽略 */ }
  }
}

// ─────────────────────────────────────────────
// 启动 / 关闭 Chrome
// ─────────────────────────────────────────────
async function launchChrome() {
  if (!fs.existsSync(CHROME)) {
    throw new Error('找不到 Chrome：' + CHROME + '（可以用 CHROME_PATH 指定）')
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xmeta-demo-chrome-'))
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=430,940',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore' })

  const portFile = path.join(profile, 'DevToolsActivePort')
  let raw = ''
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(portFile)) {
      raw = fs.readFileSync(portFile, 'utf8').trim()
      if (raw) break
    }
    if (child.exitCode !== null) throw new Error('Chrome 提前退出了')
    await sleep(100)
  }
  if (!raw) throw new Error('等不到 DevToolsActivePort')

  const [port, wsPath] = raw.split('\n')
  const cdp = new CDP('ws://127.0.0.1:' + port + wsPath)
  await cdp.ready

  return {
    cdp,
    async close() {
      try { await cdp.send('Browser.close') } catch (e) { /* 忽略 */ }
      cdp.close()
      if (child.exitCode === null) child.kill()
      await sleep(150)
      try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
    },
  }
}

async function openPage(browser, url, initSource) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const errors = []
  const warnings = []

  browser.cdp.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid !== sessionId) return
    const d = p.exceptionDetails || {}
    errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常')
  })
  browser.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId) return
    const text = (p.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ')
    if (p.type === 'error') errors.push(text)
    if (p.type === 'warning') warnings.push(text)
  })
  browser.cdp.on('Log.entryAdded', (p, sid) => {
    if (sid !== sessionId) return
    const e = p.entry || {}
    // favicon 404 之类和页面逻辑无关的忽略掉
    if (e.level === 'error' && !/favicon/i.test((e.text || '') + ' ' + (e.url || ''))) {
      errors.push(e.text || ('log error ' + e.url))
    }
  })

  await browser.cdp.send('Page.enable', {}, sessionId)
  // 让页面成为前台标签，避免浏览器把定时器节流成 1 次/秒
  try { await browser.cdp.send('Page.bringToFront', {}, sessionId) } catch (e) { /* 忽略 */ }
  await browser.cdp.send('Runtime.enable', {}, sessionId)
  await browser.cdp.send('Log.enable', {}, sessionId)

  if (initSource) {
    await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initSource }, sessionId)
  }

  return {
    sessionId,
    errors,
    warnings,
    async goto(target) {
      await browser.cdp.send('Page.navigate', { url: target }, sessionId)
      for (let i = 0; i < 100; i++) {
        try {
          const r = await this.eval('document.readyState')
          if (r === 'complete') return
        } catch (e) { /* 导航过程中执行上下文会重建，下一轮再问 */ }
        await sleep(100)
      }
      throw new Error('页面加载超时')
    },
    async eval(expression) {
      const r = await browser.cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, sessionId)
      if (r.exceptionDetails) {
        const d = r.exceptionDetails
        throw new Error('页面脚本出错：' +
          ((d.exception && (d.exception.description || d.exception.value)) || d.text))
      }
      return r.result ? r.result.value : undefined
    },
    async waitFor(expression, timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        try {
          last = await this.eval(expression)
          if (last) return last
        } catch (e) { last = e.message }
        await sleep(120)
      }
      throw new Error('等不到条件：' + expression + '（最后结果：' + JSON.stringify(last) + '）')
    },
    async click(selector) {
      await this.eval('document.querySelector(' + JSON.stringify(selector) + ').click()')
    },
    async text(selector) {
      return this.eval('(document.querySelector(' + JSON.stringify(selector) + ') || {}).textContent || ""')
    },
    async setDark(on) {
      await browser.cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }],
      }, sessionId)
      await sleep(250)
    },
    async screenshot(name) {
      const r = await browser.cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
      }, sessionId)
      const dir = path.join(__dirname, 'screenshots')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), Buffer.from(r.data, 'base64'))
      return path.join(dir, name)
    },
  }
}

function sessionInit(origin, session, extra) {
  return `
    try {
      window.__XMETA_DEMO_OVERRIDE__ = Object.assign(
        { apiBase: ${JSON.stringify(origin)} },
        ${JSON.stringify(extra || {})}
      );
      localStorage.setItem(
        'xmeta:sess:${CLIENT_ID}',
        JSON.stringify(${JSON.stringify(session)})
      );
    } catch (e) { /* about:blank 上没有 localStorage */ }
  `
}

function guestInit(origin) {
  return `
    try {
      window.__XMETA_DEMO_OVERRIDE__ = { apiBase: ${JSON.stringify(origin)} };
      localStorage.removeItem('xmeta:sess:${CLIENT_ID}');
      localStorage.removeItem('xmeta:code');
    } catch (e) { /* 忽略 */ }
  `
}

function rowOf(state, scope, uid) {
  return (state.rows || []).find((r) => r.scope === scope && String(r.uid) === String(uid))
}

function logsOf(state, scope, uid) {
  return ((state.logs || {})[scope + ':' + uid] || []).slice()
}

// ─────────────────────────────────────────────
// 测试主体
// ─────────────────────────────────────────────
async function testOnline(origin, session) {
  console.log('· 已连接页面：加载并检查大厅')
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, sessionInit(origin, session, {
      // 测试里把冷却缩短，不用真的等 5 秒；线上默认还是 5 秒
      actionCooldownMs: 300,
    }))
    await page.goto(origin + '/index-test.html')

    await page.waitFor("document.querySelector('#app') && document.querySelector('#app').getAttribute('data-mode') === 'game'")
    try {
      await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)
    } catch (e) {
      console.log('  data-ready =', await page.eval("document.querySelector('#app').getAttribute('data-ready')"))
      console.log('  errBox     =', await page.text('#errBox'))
      console.log('  页面错误   =', page.errors)
      console.log('  页面警告   =', page.warnings)
      console.log('  请求       =', await page.eval('JSON.stringify(window.__XMETA_DEMO__.state.reqs.slice(0,8))'))
      throw e
    }

    assert.equal((await page.text('#vState')).trim(), '已连接')
    assert.equal((await page.text('#vUid')).trim(), MY_UID)
    assert.ok(Number(await page.text('#onlineCount')) >= 2, '在线人数应该包含房主、小明和我')

    const overflow = await page.eval('document.documentElement.scrollWidth - window.innerWidth')
    assert.ok(overflow <= 1, '430px 宽度下不应该横向溢出（多出 ' + overflow + 'px）')

    const listText = await page.text('#playerList')
    assert.match(listText, /房主/)
    assert.match(listText, /小明/)
    assert.match(listText, /测试玩家/)

    // 聊天输入框和发送按钮要并排：输入框有正常宽度，按钮不能把它挤出去
    const chatLayout = await page.eval(`(() => {
      const f = document.querySelector('#chatForm').getBoundingClientRect();
      const i = document.querySelector('#chatInput').getBoundingClientRect();
      const b = document.querySelector('#btnSend').getBoundingClientRect();
      return {
        f: { l: f.left, r: f.right, w: f.width },
        i: { l: i.left, r: i.right, w: i.width },
        b: { l: b.left, r: b.right, w: b.width }
      };
    })()`)
    assert.ok(chatLayout.i.w > 120, '输入框应该有正常宽度，实际 ' + chatLayout.i.w)
    assert.ok(chatLayout.b.w < chatLayout.i.w, '发送按钮不能被撑得比输入框还长')
    assert.ok(
      chatLayout.i.l >= chatLayout.f.l - 1 && chatLayout.b.r <= chatLayout.f.r + 1,
      '输入框和按钮不能超出聊天框'
    )

    // 聊天历史：第一页是最近 100 条消息（按 changed=text1 筛过），
    // 更早的要点「加载更早」才出来
    await page.waitFor(
      "(document.querySelector('#chatList').textContent || '').includes('消息 119')",
      8000
    )
    let chatText = await page.text('#chatList')
    assert.match(chatText, /消息 119/)
    assert.ok(!chatText.includes('消息 0'), '第一页不该有最老的那条')
    assert.equal(
      await page.eval("document.querySelector('#btnOlderChat').classList.contains('xm-hidden')"),
      false,
      '还有更早的消息时应该显示「加载更早」'
    )
    await page.click('#btnOlderChat')
    await page.waitFor(
      "(document.querySelector('#chatList').textContent || '').includes('消息 0')",
      8000
    )
    chatText = await page.text('#chatList')
    assert.match(chatText, /消息 0/, '点「加载更早」后应该能读到更早的消息')

    const hpText = (await page.text('#hpNow')).trim()
    assert.equal(hpText.replace(/,/g, ''), '98766', 'Boss 血量应该扣掉种子数据里的 1234')

    const boardText = await page.text('#board')
    assert.match(boardText, /房主/)
    assert.match(boardText, /-700/)
    assert.match(boardText, /-534/)

    // 伤害榜：一人一条 damage 数据，累计数要和 Boss 掉的血对上
    await page.waitFor(
      "(document.querySelector('#boardHint').textContent || '').includes('已掉')",
      8000
    )
    assert.match(await page.text('#boardHint'), /1,234/)

    await page.setDark(false)
    await page.screenshot('01-lobby.png')
    await page.click('[data-tab-btn="boss"]')
    await page.setDark(true)
    await page.screenshot('02-boss-dark.png')
    await page.setDark(false)
    await page.click('[data-tab-btn="lobby"]')

    // 打一下 Boss
    const before = Number((await page.text('#hpNow')).replace(/,/g, ''))
    await page.click('#btnAttack')
    await page.waitFor(
      'Number((document.querySelector("#hpNow").textContent || "0").replace(/,/g, "")) < ' + before,
      8000
    )
    let state = (await (await fetch(origin + '/test/state')).json())
    let lobby = rowOf(state, 'lobby', '1001')
    assert.ok(Number(lobby.tagInt2) < before, 'Boss 血量应该在服务端也减少了')
    const hits = logsOf(state, 'lobby', '1001').filter(
      (e) => e.action === 'update' && e.actorUid === MY_UID && e.changed.includes('tagInt2')
    )
    assert.ok(hits.length >= 1, '应该留下一条我打 Boss 的日志')

    // 榜单累计要跟着这一刀涨，并且等于 Boss 总共掉的血
    const hpAfterAttack = Number(rowOf(state, 'lobby', '1001').tagInt2)
    const expectedTotal = 100000 - hpAfterAttack
    let boardTotal = 0
    for (let i = 0; i < 40; i++) {
      const txt = await page.text('#boardHint')
      const m = txt.match(/[\d,]+/)
      boardTotal = m ? Number(m[0].replace(/,/g, '')) : 0
      if (boardTotal === expectedTotal) break
      await sleep(150)
    }
    assert.equal(boardTotal, expectedTotal, '伤害榜累计要等于 Boss 掉的血')

    // 连发两条：第二条也要有头像和昵称，不能被「同一个人省略头像」吞掉
    const msg = '自动化测试消息 ' + Date.now()
    const msg2 = '第二条连着发 ' + Date.now()
    for (const text of [msg, msg2]) {
      await page.eval(`
        (function () {
          const input = document.querySelector('#chatInput');
          input.value = ${JSON.stringify(text)};
          document.querySelector('#chatForm').requestSubmit();
        })()
      `)
      await page.waitFor(
        '(document.querySelector("#chatList").textContent || "").includes(' + JSON.stringify(text) + ')',
        8000
      )
    }

    const lastTwo = await page.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('#chatList .demo-msg')).slice(-2);
      return rows.map((r) => ({
        name: ((r.querySelector('.demo-msg__head b') || {}).textContent || '').trim(),
        avatarText: ((r.querySelector('.demo-msg__avatar') || {}).textContent || '').trim(),
        hasAvatarImg: !!r.querySelector('.demo-msg__avatar img')
      }));
    })()`)
    assert.equal(lastTwo.length, 2)
    for (const row of lastTwo) {
      assert.ok(row.name.length > 0, '每条消息都要显示昵称')
      assert.ok(row.hasAvatarImg || row.avatarText.length > 0, '每条消息都要显示头像')
    }

    state = await (await fetch(origin + '/test/state')).json()
    let lobbyLogs = logsOf(state, 'lobby', '1001')
    for (const text of [msg, msg2]) {
      assert.ok(
        lobbyLogs.some((e) => e.changed.includes('text1') && e.after && e.after.text1 === text && e.actorUid === MY_UID),
        '聊天应该写进大厅数据的日志'
      )
    }

    // 我的：背包
    await page.click('[data-tab-btn="me"]')
    await page.waitFor("document.querySelector('#gold').textContent !== '—'")
    const goldBefore = Number((await page.text('#gold')).replace(/,/g, ''))
    await page.click('#btnWork')
    await page.waitFor(
      'Number((document.querySelector("#gold").textContent || "0").replace(/,/g, "")) > ' + goldBefore,
      8000
    )
    state = await (await fetch(origin + '/test/state')).json()
    const bag = rowOf(state, 'bag', MY_UID)
    assert.ok(bag && Number(bag.tagInt2) > 0, '背包金币应该通过 inc 加上去')
    assert.equal(bag.isPublic, false, '背包必须是私有的')

    // 打工顺手捡东西时会给「捡道具」也上冷却；等它过期再点
    await sleep(450)
    await page.click('#btnFind')
    await page.waitFor('document.querySelectorAll("#bagItems .demo-item").length > 0', 8000)
    state = await (await fetch(origin + '/test/state')).json()
    const bag2 = rowOf(state, 'bag', MY_UID)
    assert.ok(bag2.extra && Array.isArray(bag2.extra.items) && bag2.extra.items.length >= 1, '道具应该写进 extra')

    // 我的：小窝
    await page.eval(`
      (function () {
        const chip = Array.from(document.querySelectorAll('.demo-chip')).find((b) => b.textContent.includes('月夜'));
        if (!chip) throw new Error('找不到月夜主题');
        chip.click();
        const input = document.querySelector('#homeMotto');
        input.value = '自动化测试的小窝';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#btnSaveHome').click();
      })()
    `)
    await page.waitFor(
      'document.querySelector("#homePreview").textContent.includes("自动化测试的小窝")',
      8000
    )
    state = await (await fetch(origin + '/test/state')).json()
    const home = rowOf(state, 'home', MY_UID)
    assert.equal(home.text2, 'moon', '小窝主题应该保存成 moon')
    assert.equal(home.text1, '自动化测试的小窝')
    await page.screenshot('03-me.png')

    // 危险动作要点两下：先确认按钮变成「再点一次」，第二下才真的删
    await page.click('#btnClearBag')
    assert.match(await page.text('#btnClearBag'), /再点一次/)
    await page.click('#btnClearBag')
    await page.waitFor(
      'Number((document.querySelector("#gold").textContent || "0").replace(/,/g, "")) === 0',
      8000
    )
    state = await (await fetch(origin + '/test/state')).json()
    const bag3 = rowOf(state, 'bag', MY_UID)
    assert.ok(bag3 && Number(bag3.tagInt2) === 0, '删掉后应该自动重建一个空背包')

    // 串门：弹出对方的小窝，再把被串门次数 +1
    await page.click('[data-tab-btn="lobby"]')
    await page.waitFor('document.querySelectorAll("#playerList .demo-player").length >= 2')
    const hostBefore = Number((rowOf((await (await fetch(origin + '/test/state')).json()), 'home', '1001') || {}).tagInt1 || 0)
    await page.eval(`
      (function () {
        const card = Array.from(document.querySelectorAll('#playerList .demo-player'))
          .find((c) => c.textContent.includes('房主'));
        if (!card) throw new Error('房主不在列表里');
        card.querySelector('button').click();
      })()
    `)

    await page.waitFor(
      "!document.querySelector('#homeModal').classList.contains('xm-hidden')",
      8000
    )
    assert.match(await page.text('#homeModalName'), /房主/)
    assert.match(await page.text('#homeModalTheme'), /月夜屋顶/)
    assert.match(await page.text('#homeModalMotto'), /月下喝茶/)

    let visited = false
    for (let i = 0; i < 40; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      const h = rowOf(state, 'home', '1001')
      if (Number(h.tagInt1) > hostBefore) { visited = true; break }
      await sleep(150)
    }
    assert.ok(visited, '串门应该给房主的小窝加 1')

    await page.waitFor(
      'Number((document.querySelector("#homeModalVisits").textContent || "0").replace(/,/g, "")) === ' +
        (hostBefore + 1),
      8000
    )
    assert.match(
      await page.text('#playerList'),
      new RegExp('被串门 ' + (hostBefore + 1) + ' 次'),
      '列表里的人数也要跟着涨'
    )

    // 列表有 30 秒缓存；再拉一次不能让「被串门次数」从 8 退回 7
    await page.eval('window.__XMETA_DEMO__.refreshHomes()')
    await sleep(600)
    assert.equal(
      Number((await page.text('#homeModalVisits')).replace(/,/g, '')),
      hostBefore + 1,
      '旧的列表缓存不能把串门次数刷回去'
    )
    assert.match(
      await page.text('#playerList'),
      new RegExp('被串门 ' + (hostBefore + 1) + ' 次'),
      '列表缓存刷新后也要保持新值'
    )

    await page.click('[data-close-home]')
    await page.waitFor("document.querySelector('#homeModal').classList.contains('xm-hidden')")

    // 心跳：确认在线状态不是只靠初始日志，而是真的在定时写
    let heartbeatSeen = false
    for (let i = 0; i < 100; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      if (logsOf(state, 'lobby', '1001').some(
        (e) => e.action === 'update' && e.actorUid === MY_UID && e.changed.includes('tagInt1')
      )) { heartbeatSeen = true; break }
      await sleep(200)
    }
    assert.ok(heartbeatSeen, '定时心跳应该在大厅那条数据上留下日志')

    // 调试面板
    await page.click('[data-tab-btn="debug"]')
    await page.waitFor('document.querySelectorAll("#reqList .demo-req").length > 0')
    const claims = await page.text('#claims')
    assert.match(claims, /41072244021248/, '凭证 payload 里应该有 aud = toyId')
    const reqText = await page.text('#reqList')
    assert.match(reqText, /PATCH/)
    assert.match(reqText, /\/api\/kv\/lobby/)
    await page.screenshot('04-debug.png')

    await sleep(500)
    const realErrors = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e))
    assert.deepEqual(realErrors, [], '页面不应该有 console error / 未捕获异常')

    console.log('  ✓ 大厅 / 聊天 / Boss / 背包 / 小窝 / 串门 / 调试面板都正常')
  } finally {
    await browser.close()
  }
}

async function testLoginFlow(origin) {
  console.log('· 未连接页面：模拟从中心 toy 回来，自动兑换凭证')
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, guestInit(origin))
    await page.goto(origin + '/index-test.html')

    await page.waitFor("document.querySelector('#app').getAttribute('data-mode') === 'guest'")
    assert.equal((await page.text('#btnLogin')).trim(), '申请联机凭证')
    assert.match(await page.text('#viewGuest'), /不用交换账号/)
    await page.screenshot('05-guest.png')

    // 模拟中心 toy 把一枚一次性 code 写进约定槽，然后跳回来
    await page.eval(`
      (function () {
        localStorage.setItem('xmeta:code', JSON.stringify({
          v: 1,
          clientId: ${JSON.stringify(CLIENT_ID)},
          code: 'code-browser-test-1',
          returnSlug: null,
          expiresAt: Date.now() + 60000,
          ts: Date.now()
        }));
        XMETA.handleRedirect();
      })()
    `)

    await page.waitFor("document.querySelector('#app').getAttribute('data-mode') === 'game'", 15000)
    await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)
    assert.equal((await page.text('#vUid')).trim(), MY_UID)
    await page.screenshot('06-after-login.png')

    const state = await (await fetch(origin + '/test/state')).json()
    assert.ok(
      state.tokenLog.some((t) => t.code === 'code-browser-test-1'),
      '应该用 code 调过 /api/oauth/token'
    )

    const realErrors = page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e))
    assert.deepEqual(realErrors, [], '登录流程不应该有 console error')
    console.log('  ✓ 检测 code → 自动兑换 → 进入大厅')
  } finally {
    await browser.close()
  }
}

async function testExpiry(origin) {
  console.log('· 凭证过期：应该出现「重新申请」提示')
  const session = await (await fetch(origin + '/test/session?uid=' + MY_UID + '&ttl=9')).json()
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, sessionInit(origin, session))
    await page.goto(origin + '/index-test.html')
    await page.waitFor("document.querySelector('#app').getAttribute('data-mode') === 'game'")
    await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)
    await page.waitFor(
      "!document.querySelector('#authBanner').classList.contains('xm-hidden')",
      20000
    )
    assert.match(await page.text('#authBanner'), /凭证过期/)
    assert.match(await page.text('#vState'), /需要重新申请/)
    await page.screenshot('07-expired.png')
    console.log('  ✓ 到期后自动停下轮询，并给出重新申请入口')
  } finally {
    await browser.close()
  }
}

async function testRace(origin, session) {
  console.log('· 竞态：攻击后晚到的旧轮询 / 心跳不能把血量覆盖回去')
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, sessionInit(origin, session, {
      // 把定时轮询拉长，确保断言之前不会有新一轮请求把旧响应顺手修正。
      pollMs: 60000,
      heartbeatMs: 60000,
      homeRefreshMs: 60000,
    }))
    await page.goto(origin + '/index-test.html')
    await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)
    const setDelay = (getRow, heartbeat) => fetch(origin + '/test/delay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ getRow, heartbeat }),
    })
    await setDelay(900, 900)

    const before = Number((await page.text('#hpNow')).replace(/,/g, ''))

    // 先发起一次轮询（它的 GET 会拍到攻击前的行，然后慢慢回）
    await page.eval('void window.__XMETA_DEMO__.refresh()')
    // 再触发一次心跳（响应也慢）
    await page.eval('void window.__XMETA_DEMO__.heartbeat()')

    // 收集飘出来的伤害数字
    await page.eval(`
      window.__lastDmg = null;
      const box = document.querySelector('#dmgFloat');
      new MutationObserver(() => {
        const n = box.querySelector('.demo-dmg__num');
        if (n) window.__lastDmg = n.textContent;
      }).observe(box, { childList: true, subtree: true });
    `)

    await page.click('#btnAttack')

    // 等服务端真的扣血
    let state
    let serverHp = before
    for (let i = 0; i < 60; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      const row = rowOf(state, 'lobby', '1001')
      serverHp = Number(row.tagInt2)
      if (serverHp < before) break
      await sleep(100)
    }
    assert.ok(serverHp < before, '攻击应该扣掉服务端的血量')

    // 等慢响应回来（GET 和心跳各 900ms），再看页面上的血量
    await sleep(1400)
    state = await (await fetch(origin + '/test/state')).json()
    const finalServerHp = Number(rowOf(state, 'lobby', '1001').tagInt2)
    const domHp = Number((await page.text('#hpNow')).replace(/,/g, ''))
    assert.equal(domHp, finalServerHp, '晚到的旧响应不能覆盖攻击后的血量')

    const floatText = await page.eval('window.__lastDmg')
    assert.ok(floatText, '应该看到飘出的伤害数字')
    assert.equal(
      Math.abs(Number(floatText)),
      before - finalServerHp,
      '飘出的伤害要和实际扣血一致'
    )

    await setDelay(0, 0)
    console.log('  ✓ 旧轮询和心跳没有覆盖新血量，伤害数字与实际扣血一致')
  } finally {
    await browser.close()
  }
}

async function testCooldown(origin, session) {
  console.log('· 冷却：攻击 / 打工 在间隔内连点只会发一次')
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, sessionInit(origin, session, {
      actionCooldownMs: 1000,
    }))
    await page.goto(origin + '/index-test.html')
    await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)

    const countUpdates = (state, scope) => logsOf(state, scope, MY_UID)
      .filter((e) => e.action === 'update' && e.changed.includes('tagInt2')).length

    let state = await (await fetch(origin + '/test/state')).json()
    const baseAttack = countUpdates(state, 'damage')

    // 连点两下：第二下会被 busy / 冷却挡住
    await page.click('#btnAttack')
    await page.click('#btnAttack')
    let afterAttack = baseAttack
    for (let i = 0; i < 50; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      afterAttack = countUpdates(state, 'damage')
      if (afterAttack > baseAttack) break
      await sleep(100)
    }
    await sleep(400)
    state = await (await fetch(origin + '/test/state')).json()
    afterAttack = countUpdates(state, 'damage')
    assert.equal(afterAttack, baseAttack + 1, '连点第二下不能再发一次攻击')
    assert.match(await page.text('#btnAttack'), /（\d+s）/, '冷却期间按钮上要显示剩余秒数')

    // 等冷却过去，再点一下应该能打出去
    await sleep(1200)
    await page.click('#btnAttack')
    let afterCooldown = afterAttack
    for (let i = 0; i < 50; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      afterCooldown = countUpdates(state, 'damage')
      if (afterCooldown > afterAttack) break
      await sleep(100)
    }
    assert.equal(afterCooldown, afterAttack + 1, '冷却结束后应该能再打一次')

    // 打工同理
    await page.click('[data-tab-btn="me"]')
    await page.waitFor("document.querySelector('#gold').textContent !== '—'")
    state = await (await fetch(origin + '/test/state')).json()
    const baseWork = countUpdates(state, 'bag')

    await page.click('#btnWork')
    await page.click('#btnWork')
    let afterWork = baseWork
    for (let i = 0; i < 50; i++) {
      state = await (await fetch(origin + '/test/state')).json()
      afterWork = countUpdates(state, 'bag')
      if (afterWork > baseWork) break
      await sleep(100)
    }
    await sleep(400)
    state = await (await fetch(origin + '/test/state')).json()
    afterWork = countUpdates(state, 'bag')
    assert.equal(afterWork, baseWork + 1, '连点第二下不能再打一次工')
    assert.match(await page.text('#btnWork'), /（\d+s）/, '打工冷却也要显示剩余秒数')

    console.log('  ✓ 连点被挡住，按钮显示剩余秒数')
  } finally {
    await browser.close()
  }
}

async function testCountdown(origin) {
  console.log('· 倒计时：本地秒表逐秒走，不依赖心跳 / 轮询')
  const session = await (await fetch(origin + '/test/session?uid=' + MY_UID + '&ttl=70')).json()
  const browser = await launchChrome()
  try {
    const page = await openPage(browser, null, sessionInit(origin, session, {
      // 把网络请求全部拉远：这 4 秒里没有任何心跳 / 轮询
      pollMs: 60000,
      heartbeatMs: 60000,
      homeRefreshMs: 60000,
    }))
    await page.goto(origin + '/index-test.html')
    await page.waitFor("document.querySelector('#app').getAttribute('data-ready') === '1'", 15000)

    const samples = []
    for (let i = 0; i < 20; i++) {
      samples.push({
        text: (await page.text('#vLeft')).trim(),
        bar: parseFloat(await page.eval("document.querySelector('#vTokenBar').style.width")),
      })
      await sleep(200)
    }

    const toSec = (t) => {
      const p = t.split(':').map(Number)
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]
    }

    const distinct = []
    for (const s of samples) {
      if (!s.text || s.text === '—') continue
      if (!distinct.length || distinct[distinct.length - 1].text !== s.text) distinct.push(s)
    }
    assert.ok(distinct.length >= 3, '倒计时应该每秒变化，实际看到 ' + distinct.length + ' 个值')
    for (let i = 1; i < distinct.length; i++) {
      assert.equal(
        toSec(distinct[i - 1].text) - toSec(distinct[i].text),
        1,
        '每次只减 1 秒，不能跳秒：' + distinct[i - 1].text + ' → ' + distinct[i].text
      )
    }

    const bars = samples.map((s) => s.bar).filter(Number.isFinite)
    assert.ok(bars.length >= 2, '进度条应该有宽度')
    assert.ok(bars[bars.length - 1] < bars[0], '进度条应该随时间减少')

    console.log('  ✓ 逐秒变化，没有跳秒；进度条连续减少（4 秒内没有任何网络请求）')
  } finally {
    await browser.close()
  }
}

async function main() {
  const mock = await startMockServer(0)
  console.log('mock 服务：' + mock.origin)
  try {
    const session = await (await fetch(mock.origin + '/test/session?uid=' + MY_UID)).json()
    await testOnline(mock.origin, session)
    await testLoginFlow(mock.origin)
    await testExpiry(mock.origin)
    await testRace(mock.origin, session)
    await testCooldown(mock.origin, session)
    await testCountdown(mock.origin)
    console.log('\n全部通过。')
  } finally {
    await mock.close()
  }
}

main().catch((e) => {
  console.error('\n测试失败：', e)
  process.exitCode = 1
})
