#!/usr/bin/env node
//
// 极简压测：固定并发持续打一个地址，输出延迟分位和状态码分布。
//
//   node tools/loadtest.mjs <url> <concurrency> <seconds> [选项]
//
// 选项：
//   --method POST                默认 GET
//   --body '{"a":1}'             请求体（隐含 Content-Type: application/json）
//   --header 'Authorization: x'  可重复
//   --timeout 10000              单请求超时（毫秒）
//
// 输出一行 JSON，方便脚本汇总：
//   { url, concurrency, seconds, total, ok, errors, rps, statuses, p50, p90, p95, p99, max }
//
const args = process.argv.slice(2)
if (args.length < 3) {
  console.error('用法: node loadtest.mjs <url> <concurrency> <seconds> [--method POST] [--body JSON] [--header "K: V"]')
  process.exit(1)
}

const url = args[0]
const concurrency = Number(args[1])
const seconds = Number(args[2])

let method = 'GET'
let body = null
const headers = {}
let timeoutMs = 10_000
/** 总请求数上限。限流接口要量延迟时用它，别让 429 混进分位数 */
let countLimit = Infinity

for (let i = 3; i < args.length; i++) {
  const a = args[i]
  if (a === '--method') method = args[++i]
  else if (a === '--body') { body = args[++i]; }
  else if (a === '--count') countLimit = Number(args[++i])
  else if (a === '--header') {
    const raw = args[++i]
    const at = raw.indexOf(':')
    headers[raw.slice(0, at).trim()] = raw.slice(at + 1).trim()
  } else if (a === '--timeout') timeoutMs = Number(args[++i])
}
if (body !== null && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

const deadline = Date.now() + seconds * 1000
const latencies = []
const statuses = {}
let errors = 0
let sent = 0

function takeSlot() {
  if (sent >= countLimit) return false
  sent++
  return true
}

async function once() {
  const started = performance.now()
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 必须把响应体读完，否则连接不会被释放 —— 测出来的是假并发
    await res.arrayBuffer()
    latencies.push(performance.now() - started)
    statuses[res.status] = (statuses[res.status] || 0) + 1
    return res.status
  } catch (e) {
    errors++
    statuses['ERR'] = (statuses['ERR'] || 0) + 1
  }
}

async function worker() {
  while (Date.now() < deadline) {
    if (!takeSlot()) break
    await once()
  }
}

const startedAt = Date.now()
await Promise.all(Array.from({ length: concurrency }, worker))
const elapsed = (Date.now() - startedAt) / 1000

latencies.sort((a, b) => a - b)
const pct = (p) => {
  if (!latencies.length) return null
  const i = Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)
  return Math.round(latencies[i] * 10) / 10
}

const total = latencies.length + errors
console.log(JSON.stringify({
  url,
  concurrency,
  seconds: Math.round(elapsed * 10) / 10,
  total,
  ok: latencies.length,
  errors,
  rps: Math.round((total / elapsed) * 10) / 10,
  statuses,
  p50: pct(50),
  p90: pct(90),
  p95: pct(95),
  p99: pct(99),
  max: latencies.length ? Math.round(latencies[latencies.length - 1] * 10) / 10 : null,
}))
