/**
 * 静态检查：页面里引用的每个 id 是不是真的存在，脚本能不能解析，
 * 配置是不是这台 toy 的。
 *
 * 跑法：node _test/check-page.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// _test 可能在 demo 目录里面，也可能被挪到外面（方便打包上传）。
// 两种位置都找一下，以「哪一层有 index.html」为准。
function findDemoRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '新建文件夹'),
    path.resolve(__dirname, '..'),
  ]
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidates[1]
}
const ROOT = findDemoRoot()

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(ROOT, 'demo.js'), 'utf8')

const failures = []
const ok = (msg) => console.log('  ✓ ' + msg)
const bad = (msg) => { failures.push(msg); console.log('  ✗ ' + msg) }

// 1. 脚本能解析
try {
  new Function(js)
  ok('demo.js 语法能解析')
} catch (e) {
  bad('demo.js 语法错误：' + e.message)
}

// 2. id 唯一
const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1])
const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
if (dup.length) bad('重复的 id：' + Array.from(new Set(dup)).join(', '))
else ok('id 没有重复（共 ' + ids.length + ' 个）')

// 3. 脚本里 $('x') / getElementById('x') 都真的存在
const refs = new Set()
for (const re of [
  /\$\('([^']+)'\)/g,
  /getElementById\('([^']+)'\)/g,
  /querySelector\('#([A-Za-z0-9_-]+)'\)/g,
  /querySelectorAll\('#([A-Za-z0-9_-]+)/g,
]) {
  for (const m of js.matchAll(re)) refs.add(m[1])
}
const missing = Array.from(refs).filter((id) => !ids.includes(id))
if (missing.length) bad('脚本引用了页面上不存在的 id：' + missing.join(', '))
else ok('脚本引用的 ' + refs.size + ' 个 id 全部存在')

// 4. 标签按钮和面板一一对应
const tabBtns = Array.from(html.matchAll(/data-tab-btn="([^"]+)"/g)).map((m) => m[1])
const tabPanels = Array.from(html.matchAll(/data-tab-panel="([^"]+)"/g)).map((m) => m[1])
if (tabBtns.slice().sort().join() !== tabPanels.slice().sort().join()) {
  bad('标签按钮和面板对不上：' + tabBtns.join(',') + ' vs ' + tabPanels.join(','))
} else {
  ok('4 个标签和面板一一对应')
}

// 5. 依赖文件都在
for (const file of ['demo.js', 'xmeta-ui.css']) {
  if (fs.existsSync(path.join(ROOT, file))) ok('依赖文件存在：' + file)
  else bad('缺文件：' + file)
}
if (!/https:\/\/www\.oxth\.com:8443\/xmeta-client\.js/.test(html)) {
  bad('index.html 里没有引入 https://www.oxth.com:8443/xmeta-client.js')
} else {
  ok('引入了线上的 xmeta-client.js')
}
if (!/s1\.hdslb\.com\/bfs\/seed\/toy\/app\/sdk\/toy-sdk\.js/.test(html)) {
  bad('index.html 里没有引入 B站 toy SDK')
} else {
  ok('引入了 B站 toy SDK')
}

// 6. 配置
const cfg = {
  apiBase: /apiBase:\s*'([^']+)'/.exec(js),
  centerToySlug: /centerToySlug:\s*'([^']+)'/.exec(js),
  centerToyId: /centerToyId:\s*'([^']+)'/.exec(js),
  clientId: /clientId:\s*'([^']+)'/.exec(js),
}
for (const [k, m] of Object.entries(cfg)) {
  if (!m) bad('配置里找不到 ' + k)
}
if (cfg.apiBase && cfg.apiBase[1] !== 'https://www.oxth.com:8443') {
  bad('apiBase 不是线上地址：' + cfg.apiBase[1])
}
if (cfg.centerToySlug && cfg.centerToySlug[1] !== 'xmeta') {
  bad('centerToySlug 不是 xmeta：' + cfg.centerToySlug[1])
}
if (cfg.centerToyId && cfg.centerToyId[1] !== '39945062320128') {
  bad('centerToyId 不是中心 toy：' + cfg.centerToyId[1])
}
if (cfg.clientId && cfg.clientId[1] !== 'xmeta_OXSY7nxlpKooXGd0oS95Cg') {
  bad('clientId 不是这台 toy 的：' + cfg.clientId[1])
}
if (!failures.length) ok('apiBase / 中心 toy / clientId 配置正确')

// 7. 没留占位符
if (/PUT_CLIENT_ID_HERE|PUT_NONCE_HERE|your-api\.example\.com/.test(html + js)) {
  bad('页面里还有占位符')
} else {
  ok('没有遗留占位符')
}

if (failures.length) {
  console.error('\n静态检查失败：' + failures.length + ' 项')
  process.exitCode = 1
} else {
  console.log('\n静态检查通过。')
}
