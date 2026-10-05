import { Errors } from '../errors.js';

/**
 * B站 toy 的元数据抓取。
 *
 * 这里用了两个「非官方文档」的通道，都实测过：
 *
 *  1. GET //api.bilibili.com/x/sunflower/artifex/toy/detail?slug=<slug>
 *     匿名可调，返回 toy_id / title / icon / 版本 / **作者 mid**。
 *     slug 不存在时 code=307022。
 *
 *  2. 抓 https://www.bilibili.com/toy/<slug>/index.html（shell 页），
 *     从里面解出内层 iframe 的地址：
 *       https://www.bilibilitoy.com/toy/<slug>/<toy_id>-v<build>/index.html
 *     再抓那个地址，就是作者真正发布的源码。
 *
 * 两条通道都可能变更或限流，所以调用方要能容忍失败；这里不做缓存，
 * 需要缓存的话在调用方加（toy 元数据适合缓存几小时）。
 */

const BILI_API_BASE = 'https://api.bilibili.com';
const DETAIL_PATH = '/x/sunflower/artifex/toy/detail';
const SHELL_BASE = 'https://www.bilibili.com';
/** 内容域。只允许抓这个后缀，防止被塞任意 URL 造成 SSRF。 */
const CONTENT_HOST_SUFFIX = '.bilibilitoy.com';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 4 * 1024 * 1024;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export type ToyDetail = {
  toyId: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  version: number | null;
  authorMid: string | null;
  authorName: string | null;
  authorFace: string | null;
};

type RawDetail = {
  code?: number;
  message?: string;
  data?: {
    id?: number | string;
    title?: string;
    icon_url?: string;
    share_icon_url?: string;
    poster_url?: string;
    version?: number;
    user_info?: { mid?: number | string; name?: string; face?: string };
  };
};

async function fetchText(url: string, allowedHostSuffix?: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw Errors.upstreamFetchFailed(`请求 ${url} 失败`, String(err));
  }

  if (!res.ok) {
    throw Errors.upstreamFetchFailed(`${url} 返回 HTTP ${res.status}`);
  }

  // fetch 会跟随 30x 重定向，但重定向后的落点没被上面的白名单拦到：
  // 这里复检一次最终地址，防止内容源被控制后跳内网地址（SSRF）。
  if (allowedHostSuffix) {
    const finalUrl = new URL(res.url);
    if (finalUrl.protocol !== 'https:' || !finalUrl.hostname.endsWith(allowedHostSuffix)) {
      throw Errors.upstreamBlocked(
        `重定向到了不允许的地址 ${finalUrl.protocol}//${finalUrl.hostname}`,
      );
    }
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_HTML_BYTES) {
    throw Errors.upstreamFetchFailed(`${url} 响应体过大（${buf.byteLength} 字节）`);
  }
  return buf.toString('utf8');
}

/** 查询 toy 元数据。toy 不存在返回 null。 */
export async function fetchToyDetail(slug: string): Promise<ToyDetail | null> {
  const url = `${BILI_API_BASE}${DETAIL_PATH}?slug=${encodeURIComponent(slug)}`;
  const body = await fetchText(url);

  let json: RawDetail;
  try {
    json = JSON.parse(body) as RawDetail;
  } catch {
    throw Errors.upstreamFetchFailed('toy detail 接口返回了非 JSON 内容', body.slice(0, 200));
  }

  // 307022 = 应用不存在或已被删除
  if (json.code === 307022) return null;
  if (json.code !== 0 || !json.data?.id) {
    throw Errors.upstreamFetchFailed(
      `toy detail 接口报错：code=${json.code} message=${json.message ?? ''}`,
    );
  }

  const d = json.data;
  return {
    toyId: String(d.id),
    slug,
    title: d.title ?? '',
    iconUrl: pickIconUrl(d.icon_url, d.share_icon_url, d.poster_url),
    version: typeof d.version === 'number' ? d.version : null,
    authorMid: d.user_info?.mid != null ? String(d.user_info.mid) : null,
    authorName: d.user_info?.name ?? null,
    authorFace: d.user_info?.face ?? null,
  };
}

/**
 * 把单个图标 URL 规范化成 https 可加载的形式。
 * 用于读出库里旧数据时兜底（库里可能存了 http:// 或协议相对地址）。
 */
export function normalizeIconUrl(raw: string | null | undefined): string | null {
  return pickIconUrl(raw);
}

/**
 * 选一个能在 https 页面里正常加载的图标 URL。
 *
 * B站 detail 接口返回的 icon_url 经常没有扩展名（实测 Content-Type 仍是
 * image/jpeg，能看），但偶尔会是 http:// 或空串。toy 页面跑在 https 上，
 * http:// 会被浏览器按混合内容拦掉，所以这里统一升级到 https://。
 *
 * 兜底顺序：icon_url → share_icon_url → poster_url。前两个拿不到再用海报图，
 * 至少不会是个裂图。
 */
function pickIconUrl(...candidates: Array<string | null | undefined>): string | null {
  for (const raw of candidates) {
    if (!raw) continue;
    let url = raw.trim();
    if (!url) continue;
    // 协议相对：//host/path → https://host/path
    if (url.startsWith('//')) url = 'https:' + url;
    // http → https（混合内容会被拦）
    else if (url.startsWith('http://')) url = 'https://' + url.slice('http://'.length);
    else if (!url.startsWith('https://')) continue; // 不认其它协议
    return url;
  }
  return null;
}

/** 从 shell HTML 里解出内层 iframe 的 src */
export function extractContentUrl(shellHtml: string): string | null {
  const m = /<iframe\b[^>]*\bsrc\s*=\s*"([^"]+)"/i.exec(shellHtml);
  if (!m?.[1]) return null;
  // HTML 里 & 会被写成 &amp;
  return m[1].replace(/&amp;/g, '&').trim();
}

/** 只允许抓 *.bilibilitoy.com，挡 SSRF */
function assertAllowedContentUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Errors.upstreamBlocked(`iframe src 不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'https:' || !u.hostname.endsWith(CONTENT_HOST_SUFFIX)) {
    throw Errors.upstreamBlocked(`拒绝抓取 ${u.hostname}（只允许 *${CONTENT_HOST_SUFFIX}）`);
  }
  return u.toString();
}

export type ToySource = {
  shellUrl: string;
  contentUrl: string;
  html: string;
};

/**
 * 抓取作者发布的 toy 源码。
 * 先抓 shell 解出内容地址，再抓内容本身。
 */
export async function fetchToySource(slug: string): Promise<ToySource> {
  const shellUrl = `${SHELL_BASE}/toy/${slug}/index.html`;
  const shellHtml = await fetchText(shellUrl);

  const rawContentUrl = extractContentUrl(shellHtml);
  if (!rawContentUrl) {
    throw Errors.upstreamFetchFailed(
      '没能从 shell 页面里解出 iframe 地址，B站 页面结构可能变了',
      { shellUrl },
    );
  }

  const contentUrl = assertAllowedContentUrl(rawContentUrl);
  const html = await fetchText(contentUrl, CONTENT_HOST_SUFFIX);

  return { shellUrl, contentUrl, html };
}

/**
 * 校验 nonce 是否出现在源码里。
 * nonce 是 [A-Za-z0-9] 子集，不会被 HTML 转义，直接 includes 即可。
 */
export function htmlContainsNonce(html: string, nonce: string): boolean {
  return html.includes(nonce);
}
