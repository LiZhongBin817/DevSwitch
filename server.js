#!/usr/bin/env node
'use strict';

/**
 * 本地开发「登录 + 租户/组合切换」工具 —— 本地服务
 *
 * 职责：
 *  1. 托管前端页面（public/）
 *  2. 提供反向代理 /api/proxy —— 把页面上的请求转发到你本地运行的后端服务，
 *     彻底绕开浏览器 CORS 限制，并可透传 Cookie / 自定义头
 *  3. 提供 /api/state 读写配置（存到 data/state.json，方便直接改文件）
 *  4. 提供 /api/ping 探测后端服务是否在线
 *
 * 零依赖，只用 Node 内置模块（需要 Node >= 18，使用全局 fetch）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录允许用环境变量覆盖（相对路径按项目根解析）。
// 一键演示（start-demo.js）就靠它把配置写到 data-demo/ 里，
// 免得跑一次演示就把你真实的 data/state.json 里的后端地址改掉。
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(ROOT, process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SEED_FILE = path.join(ROOT, 'config.json');

const PORT = Number(process.env.PORT || 4599);
const HOST = process.env.HOST || '127.0.0.1';
const BODY_LIMIT = 8 * 1024 * 1024;

/**
 * 启动时要不要自己打开浏览器。
 *
 * 三种情况不开：
 *  1. 没设 OPEN_BROWSER=1 —— 手敲 node server.js 时不该抢焦点，
 *     你可能正在远程/服务里跑。
 *  2. 带了 --no-browser —— DevSwitch.exe 用这种方式明确说「浏览器我来开」。
 *     它用命令行参数而不是环境变量传，因为 Windows 上同时存在
 *     HTTPS_PROXY / https_proxy 这类大小写重复键时，.NET 的
 *     ProcessStartInfo.EnvironmentVariables 一读就抛异常，
 *     会让启动器在拉起 node 之前就崩掉（踩过，见 launcher/Program.cs 的注释）。
 *
 * 为什么不让 exe 和 node 各开一次：会开出两个标签页，用户以为点重了。
 */
const OPEN_BROWSER_OFF =
  process.argv.includes('--no-browser') || process.env.OPEN_BROWSER !== '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'accept-encoding',
]);

const DEFAULT_STATE = {
  target: 'http://127.0.0.1:8080',
  requestTimeoutMs: 30000,
  // 后端主机名写 localhost / 127.0.0.1 连不上时，自动换另一个再试一次。
  // 本机同时跑着只绑 IPv4 和只绑 IPv6 的后端是常态，关掉它就得手工改地址。
  autoLoopback: true,
  login: {
    enabled: true,
    method: 'POST',
    path: '/pds-std/api/login',
    contentType: 'json',
    bodyTemplate: '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
    tokenSource: 'cookie',
    tokenHeaderName: 'Authorization',
    tokenPath: 'data.accessToken',
    successPath: 'retCode',
    successValue: 'T200',
    headersTemplate: '{}',
    saveCookies: true,
  },
  tenantSwitch: {
    enabled: true,
    method: 'POST',
    path: '/pds-std/api/switchTenant',
    contentType: 'form',
    bodyTemplate: '{\n  "tenantId": "{{tenantId}}"\n}',
    successPath: 'retCode',
    successValue: 'T200',
    headersTemplate: '{}',
  },
  tenantList: {
    enabled: true,
    method: 'GET',
    path: '/pds-std/api/pf/tenant/all',
    listPath: 'data',
    idField: 'tenantId',
    nameField: 'name',
    successPath: 'retCode',
    successValue: 'T200',
  },
  authHeader: { enabled: true, name: 'Authorization', valueTemplate: 'Bearer {{token}}' },
  tenantHeader: { enabled: true, name: 'X-Tenant-Id', valueTemplate: '{{tenantId}}' },
  extraHeaders: '{}',
  accounts: [
    { id: 'acc_admin', name: '管理员', username: 'admin', password: '123456', note: '本地超管' },
  ],
  tenants: [
    { id: 't_demo', name: '演示租户', code: 'demo' },
  ],
  combos: [],
  activeComboId: null,
};

/* ------------------------------- 工具函数 ------------------------------- */

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 和 sendJSON 一样，但允许随响应下发若干条 Set-Cookie。
 * 用 writeHead 的第二参数形式（数组），避免多个 Set-Cookie 被合并成一条。
 */
function sendJSONWithCookies(res, code, obj, cookies = []) {
  const body = JSON.stringify(obj);
  const headers = {};
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendHTML(res, code, html) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * 把若干条 Set-Cookie 原文，转成可以直接下发的 Set-Cookie 头。
 *
 * 抽出来是因为有两个地方要用：面板自己那个主机名（/api/browser-cookie），
 * 以及另一个主机名（/__cookie-bridge 的 iframe）。两边规则几乎一致，
 * 唯一的差别是 SameSite —— 见 crossSite 参数。
 *
 * @param {string[]} list 后端下发的 Set-Cookie 原文数组
 * @param {{crossSite?: boolean}} [opts]
 *   crossSite=true 时用 SameSite=None; Secure。这是桥唯一的可行写法，
 *   原因（实测，不是推测）：桥页面跑在跨站 iframe 里，属于「第三方上下文」，
 *   Chrome 对那里写 Cookie 有硬限制 —— 实测 Lax / 不带 SameSite / 不带 Secure
 *   的 SameSite=None 全部被静默丢弃，只有 `SameSite=None; Secure` 能落地。
 *   而 localhost / 127.0.0.1 被浏览器当作可信来源（secure context），
 *   所以挂在 http 上也不会被拒 —— 正好能用。
 */
function buildCookieHeaders(list, opts = {}) {
  const crossSite = opts.crossSite === true;
  const headers = [];
  const written = [];
  const skipped = [];
  const httpOnly = [];
  const sameSite = crossSite ? 'SameSite=None; Secure' : 'SameSite=Lax';
  for (const item of list) {
    const c = splitCookie(item);
    if (!c) {
      skipped.push({ raw: String(item).slice(0, 40), why: '不是 name=value 形式' });
      continue;
    }
    // Cookie 值里出现分号 / 换行 / 非 ASCII 都会让 Node 直接抛错，先挡掉
    if (!/^[\w%.\-~+/=:]*$/.test(c.value) || c.value.length > 8000) {
      skipped.push({ name: c.name, why: '值里含不安全的字符' });
      continue;
    }
    // 不写 Domain：保持 host-only，这样 Cookie 只属于当前这个主机名。
    let line = `${c.name}=${c.value}; Path=/; ${sameSite}`;
    if (c.httpOnly) {
      line += '; HttpOnly';
      httpOnly.push(c.name);
    }
    headers.push(line);
    written.push(c.name);
  }
  return { headers, written, skipped, httpOnly };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[warn] 读取 state.json 失败，改用默认配置：', e.message);
  }
  let seed = DEFAULT_STATE;
  try {
    if (fs.existsSync(SEED_FILE)) {
      seed = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) };
    }
  } catch (e) {
    console.warn('[warn] 读取 config.json 失败：', e.message);
  }
  return seed;
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function joinUrl(base, p) {
  if (/^https?:\/\//i.test(p)) return p;
  const b = String(base || '').replace(/\/+$/, '');
  return b + (p.startsWith('/') ? p : '/' + p);
}

/* ---------------- 回环主机名的等价与自动兜底 ---------------- */

/**
 * 本机回环的几种写法。它们指向同一台机器，但对 HTTP 客户端来说是
 * 彼此独立的「主机名」，谁也替不了谁 —— 这是下面所有兜底逻辑的前提。
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function isLoopbackHost(h) {
  const s = String(h || '').toLowerCase();
  return s === 'localhost' || s === '127.0.0.1' || s === '::1' || s === '[::1]';
}

function hostOf(base) {
  try {
    return new URL(base).hostname;
  } catch {
    return '';
  }
}

/** 换掉 URL 里的主机名，协议 / 端口 / 路径 / 查询串原样保留 */
function withHost(base, host) {
  try {
    const u = new URL(base);
    // 注意：IPv6 必须带方括号，写成 '::1' 会被 URL 直接忽略（实测）
    u.hostname = host;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return base;
  }
}

/**
 * 同一个 base 的等价回环写法，按「最可能连通」排序。
 *
 * 为什么需要：本机可能同时跑着几个后端，有的只 listen 了 127.0.0.1（IPv4），
 * 有的只 listen 了 ::1（IPv6）。用户填的那个地址只对得上一半，碰到另一半就是
 * 干脆的 ECONNREFUSED —— 但在用户眼里它们是「同一个后端」，只是写法不同。
 *
 * 实测（Node 22，Happy Eyeballs 默认开启）：
 *   localhost → 只绑 IPv4  ✅        localhost → 只绑 IPv6  ✅
 *   127.0.0.1 → 只绑 IPv4  ✅        127.0.0.1 → 只绑 IPv6  ❌ ECONNREFUSED
 * 因为 localhost 会展开成 ::1 + 127.0.0.1 两个地址逐个试，是超集；
 * 而 127.0.0.1 是字面量，就只有一个地址可试。
 *
 * 顺序：用户写的那个排第一（填对了零代价，不改变他的语义），
 * 然后 localhost（超集，命中率最高），最后 [::1]、127.0.0.1 收尾。
 *
 * 非回环主机名原样返回，绝不去猜用户的外网/内网域名。
 */
function loopbackVariants(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return [base];
  }
  if (!isLoopbackHost(u.hostname)) return [base];

  const first = u.hostname.toLowerCase() === '::1' ? '[::1]' : u.hostname.toLowerCase();
  const ordered = [first, ...LOOPBACK_HOSTS];
  const out = [];
  const seen = new Set();
  for (const h of ordered) {
    const b = withHost(base, h);
    if (!b || seen.has(b)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

/**
 * 连接层错误码。
 *
 * Happy Eyeballs 会把所有地址都试完才抛聚合错误（cause.errors 数组），
 * 所以要看数组里的每一项，而不是只看 cause.code。
 */
function connErrorCode(e) {
  const c = e && e.cause;
  if (!c) return '';
  if (c.code) return c.code;
  if (Array.isArray(c.errors) && c.errors.length) {
    const codes = c.errors.map((x) => x && x.code).filter(Boolean);
    if (!codes.length) return '';
    // 只有「所有地址都是连接被拒」才值得换个回环主机名再试一次；
    // 混杂了别的错误（比如证书问题）说明不是绑定地址的问题。
    return codes.every((x) => x === 'ECONNREFUSED') ? 'ECONNREFUSED' : codes.join(',');
  }
  return '';
}

/**
 * 这个错误是否值得换一个回环主机名重试。
 *
 * 只认连接层的「对面没人在听」类错误。超时不重试 —— 超时说明服务在线只是慢，
 * 换主机名只会让用户多等一轮，还可能把「后端卡住」误报成「地址不对」。
 */
function shouldTryLoopbackPeer(e) {
  return ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(connErrorCode(e));
}

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  for (const [k, v] of h.entries()) out[k] = v;
  return out;
}

/**
 * 把 "Authorization=xxx; Path=/; HttpOnly" 拆成字段。
 * 只关心名字、值，以及两个会决定浏览器收不收的属性。
 */
function splitCookie(raw) {
  const parts = String(raw || '').split(';');
  const head = parts.shift() || '';
  const eq = head.indexOf('=');
  if (eq <= 0) return null;
  const name = head.slice(0, eq).trim();
  const value = head.slice(eq + 1).trim();
  if (!name) return null;
  let httpOnly = false;
  let secure = false;
  for (const p of parts) {
    const k = p.trim().toLowerCase();
    if (k === 'httponly') httpOnly = true;
    else if (k === 'secure') secure = true;
  }
  return { name, value, httpOnly, secure };
}

/* --------------------------- 反代：核心转发逻辑 --------------------------- */

async function doProxy({ method = 'GET', url, headers = {}, body, timeoutMs, base, autoLoopback }) {
  const fwd = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (v === undefined || v === null || v === '') continue;
    fwd[k] = String(v);
  }
  fwd['Accept-Encoding'] = 'identity';

  const init = {
    method: String(method || 'GET').toUpperCase(),
    headers: fwd,
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30000)),
  };

  if (!['GET', 'HEAD'].includes(init.method) && body !== undefined && body !== null && body !== '') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // url 本身是绝对地址时，base 完全不参与拼接，也就没有「换个回环名再试」的余地
  const absolute = /^https?:\/\//i.test(String(url || ''));
  const bases = absolute || autoLoopback === false ? [base] : loopbackVariants(base);

  let res = null;
  let fullUrl = '';
  let lastErr = null;
  const attempts = [];

  for (let i = 0; i < bases.length; i++) {
    const candidateBase = bases[i];
    const candidateUrl = joinUrl(candidateBase, url);

    let parsed;
    try {
      parsed = new URL(candidateUrl);
    } catch {
      throw new Error('目标地址不合法：' + candidateUrl);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https 协议');

    const t0 = Date.now();
    try {
      res = await fetch(candidateUrl, init);
      fullUrl = candidateUrl;
      const host = parsed.hostname;
      attempts.push({ host, base: candidateBase, ok: true, ms: Date.now() - t0 });
      if (i > 0) {
        // 兜底生效了：说明用户填的主机名对这个后端不成立。这条日志很重要 ——
        // 下次再遇到「明明填对了却连不上」能立刻定位到是哪个名字起的作用。
        console.log(
          `[loopback] ${hostOf(base)} 连不上，已自动改用 ${host}（${String(lastErr && connErrorCode(lastErr)).trim() || '连接失败'}）`
        );
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      fullUrl = candidateUrl;
      attempts.push({ host: parsed.hostname, base: candidateBase, ok: false, ms: Date.now() - t0, code: connErrorCode(e) });
      // 超时不重试、非连接层错误不重试、已经是最后一个候选就抛出
      if (!shouldTryLoopbackPeer(e) || i === bases.length - 1) break;
    }
  }

  if (lastErr) {
    // 把「试过哪些主机名」一并带出去。只看一句 ECONNREFUSED 根本分不清
    // 是后端没启动，还是地址写错了 —— 这是本项目最容易误判的地方。
    //
    // 注意这里**必须**无条件赋值，哪怕只试了一个。早先写成 `if (attempts.length > 1)`
    // 里才挂，结果关掉 autoLoopback 时前端拿不到这个字段，只能退回去用
    // loopbackVariants(base) 猜，界面上就显示「已尝试 [::1] → localhost → 127.0.0.1」
    // —— 三个名字一个都没真试过，纯属误导。哪怕只有一个，也要如实说一个。
    lastErr.attemptedHosts = attempts.map((a) => a.host);
    if (attempts.length > 1) {
      const tried = attempts.map((a) => `${a.host}${a.code ? `(${a.code})` : ''}`).join(' → ');
      lastErr.message = `${lastErr.message}（已尝试 ${tried}）`;
    }
    throw lastErr;
  }

  const started = Date.now();
  const buf = Buffer.from(await res.arrayBuffer());
  const durationMs = Date.now() - started;

  const text = buf.toString('utf8');
  let json;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    try {
      json = JSON.parse(text);
    } catch {
      /* 保底按文本处理 */
    }
  }

  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie() || [];
  } else if (res.headers.get('set-cookie')) {
    cookies = [res.headers.get('set-cookie')];
  }

  let reachedHost = '';
  let resolvedBase = '';
  try {
    const u = new URL(fullUrl);
    reachedHost = u.hostname;
    resolvedBase = `${u.protocol}//${u.host}`;
  } catch { /* 忽略 */ }

  // 「填的地址」与「真连上的地址」不一致 → 说明兜底生效了，要如实告诉用户
  const askedHost = hostOf(base);
  const hostSwitched = !!reachedHost && !!askedHost && reachedHost !== askedHost;

  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url: fullUrl,
    // 实际连上的主机名与控制台基址 —— 前端据此如实提示
    // 「你填的是 127.0.0.1，实际连的是 localhost」这类错位。
    host: reachedHost,
    resolvedBase,
    askedHost,
    hostSwitched,
    // true 表示用户填的主机名连不上、靠自动换名才通。这类情况在界面上
    // 值得一直显示：否则下次他手动改回 127.0.0.1 又会踩同一个坑。
    loopbackFallback: hostSwitched && attempts.length > 1,
    attempts,
    durationMs,
    headers: headersToObject(res.headers),
    cookies,
    text: text.length > 400000 ? text.slice(0, 400000) + '\n…（内容过长已截断）' : text,
    json,
    bytes: buf.length,
  };
}

/* -------------------------------- 路由 -------------------------------- */

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // 配置读写
    if (pathname === '/api/state') {
      if (req.method === 'GET') return sendJSON(res, 200, loadState());
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        const next = JSON.parse(body || '{}');
        saveState(next);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        ensureDataDir();
        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
        return sendJSON(res, 200, { ok: true, state: loadState() });
      }
    }

    // 后端连通性探测
    //
    // 探测本身也走回环兜底：用户填 127.0.0.1、后端只绑了 ::1 时，
    // 真请求（/api/proxy）能通但「检测」报不可达就自相矛盾了。
    // 这里顺便回报「填的是谁、真连上的是谁」，让顶栏能如实显示。
    if (pathname === '/api/ping') {
      const target = url.searchParams.get('target') || loadState().target;
      const started = Date.now();
      const candidates = loopbackVariants(target);
      const tried = [];
      let hit = null;
      let lastErr = null;

      for (let i = 0; i < candidates.length; i++) {
        const base = candidates[i];
        let host = '';
        try {
          host = new URL(base).hostname;
        } catch {
          lastErr = new Error('目标地址不合法：' + base);
          break;
        }
        try {
          const r = await fetch(joinUrl(base, '/'), {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(6000),
          });
          hit = { r, base, host };
          tried.push({ host, ok: true });
          break;
        } catch (e) {
          lastErr = e;
          tried.push({ host, ok: false, code: connErrorCode(e) });
          if (!shouldTryLoopbackPeer(e) || i === candidates.length - 1) break;
        }
      }

      if (hit) {
        const askedHost = hostOf(target);
        return sendJSON(res, 200, {
          ok: true,
          reachable: true,
          status: hit.r.status,
          durationMs: Date.now() - started,
          // 关键回显：填的地址 vs 实际连上的地址
          askedHost,
          host: hit.host,
          hostSwitched: !!askedHost && askedHost !== hit.host,
          resolvedBase: hit.base,
          tried: tried.map((t) => t.host),
        });
      }

      const askedHost = hostOf(target);
      return sendJSON(res, 200, {
        ok: false,
        reachable: false,
        error: lastErr && lastErr.name === 'TimeoutError' ? '连接超时' : (lastErr && lastErr.message) || '不可达',
        durationMs: Date.now() - started,
        askedHost,
        tried: tried.map((t) => `${t.host}${t.code ? `(${t.code})` : ''}`),
      });
    }

    // 把会话写进浏览器自己的 Cookie 罐
    //
    // 为什么非要绕到服务端来做：后端下发的是
    //   Set-Cookie: Authorization=eyJ...; Path=/; HttpOnly
    // 前端 JS 用 document.cookie 写不回去 —— HttpOnly 这个标记 JS 根本设不了，
    // 而且 value 里一旦出现特殊字符还会被静默吞掉。只有响应头能原样落地。
    //
    // 另一个关键是「Cookie 不区分端口」：写在 localhost:4599 上的 host-only
    // Cookie，浏览器会照样发给 localhost:8080。所以这里不用、也不该设 Domain，
    // 保持 host-only 就是想要的效果。
    if (pathname === '/api/browser-cookie') {
      // GET：报告浏览器「现在真的会发给面板」的 Cookie —— 这是唯一能证明
      // 写入成功的证据。HttpOnly 的读不到但服务端收得到，所以只能问服务端。
      if (req.method === 'GET') {
        const jar = String(req.headers.cookie || '')
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((pair) => {
            const i = pair.indexOf('=');
            return i > 0 ? { name: pair.slice(0, i), value: pair.slice(i + 1) } : null;
          })
          .filter(Boolean);
        return sendJSON(res, 200, {
          ok: true,
          host: req.headers.host || '',
          jar,
          names: jar.map((c) => c.name),
        });
      }

      if (req.method !== 'POST' && req.method !== 'DELETE') {
        return sendJSON(res, 405, { error: '仅支持 GET / POST / DELETE' });
      }

      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return sendJSON(res, 400, { error: '请求体必须是 JSON' });
      }

      const list = Array.isArray(payload.cookies) ? payload.cookies : [];

      if (req.method === 'DELETE') {
        // 清空：把同名 Cookie 立刻过期掉。名字从请求体来，也可以不带（清全部已知项）
        const names = (Array.isArray(payload.names) ? payload.names : [])
          .map((n) => String(n || '').trim())
          .filter((n) => /^[\w.\-]+$/.test(n));
        const expired = names.map((n) => `${n}=; Path=/; Max-Age=0; SameSite=Lax`);
        return sendJSONWithCookies(res, 200, { ok: true, cleared: names }, expired);
      }

      // 写入规则统一走 buildCookieHeaders —— 与 /__cookie-bridge 用同一份实现，
      // 否则会出现「面板这边写进去了、桥那边悄悄跳过」这种极难排查的错位。
      const out = buildCookieHeaders(list);
      return sendJSONWithCookies(res, 200, {
        ok: true,
        host: req.headers.host || '',
        written: out.written,
        skipped: out.skipped,
        httpOnly: out.httpOnly,
      }, out.headers);
    }

    // 把会话写进「另一个主机名」
    //
    // localhost 和 127.0.0.1 在浏览器眼里是两个毫不相干的站点，Cookie 绝不互通。
    // 设 Domain 也没用 —— 127.0.0.1 不是 localhost 的子域，浏览器会直接拒收。
    // 唯一能让两个主机名都有登录态的办法：让浏览器分别向它们各发一次请求。
    //
    // 所以这里做一个「桥」页面：面板用隐藏 iframe 打开另一个主机名下的它，
    // 页面里的 JS 再把 Cookie 发回同一主机名的端点，Set-Cookie 就落在那个主机上了。
    //
    // Cookie 值不写在 URL 里（会进访问日志），而是由父窗口用 postMessage 递进来。
    if (pathname === '/__cookie-bridge') {
      if (req.method === 'GET') {
        // 页面本身。它只负责：等父窗口的 Cookie → 发给自己所在主机名 → 回报结果。
        return sendHTML(res, 200, `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>写入登录态…</title>
<style>body{font:13px/1.6 system-ui;padding:14px;color:#334;margin:0}</style></head>
<body>
<div id="msg">等待数据…</div>
<script>
(function () {
  var msg = document.getElementById('msg');
  function report(p) { try { parent.postMessage(Object.assign({ __cookieBridge: 1 }, p), '*'); } catch (e) {} }

  window.addEventListener('message', async function (ev) {
    var d = ev.data || {};
    if (!d || !d.__cookieBridge || !d.kind) return;
    if (d.kind !== 'write' && d.kind !== 'clear') return;
    var body = d.kind === 'clear' ? { names: d.names || [] } : { cookies: d.cookies || [] };
    msg.textContent = d.kind === 'clear' ? '正在清除…' : '正在写入…';
    try {
      var r = await fetch('/__cookie-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var j = await r.json();
      var n = (j.written || j.cleared || []).length;
      msg.textContent = j.ok ? (d.kind === 'clear' ? '已清除 ' + n + ' 个' : '已写入 ' + n + ' 个') : '失败';
      report({
        kind: 'done', action: d.kind, ok: !!j.ok, host: location.host,
        written: j.written || [], cleared: j.cleared || [], skipped: j.skipped || [],
      });
    } catch (e) {
      msg.textContent = '失败：' + e.message;
      report({ kind: 'done', action: d.kind, ok: false, host: location.host, error: e.message });
    }
  });

  // 告诉父窗口「我准备好了，可以发数据了」
  report({ kind: 'ready', host: location.host });
})();
</script>
</body></html>`);
      }

      if (req.method === 'POST') {
        const raw = await readBody(req);
        let payload;
        try { payload = JSON.parse(raw || '{}'); }
        catch { return sendJSON(res, 400, { error: '请求体必须是 JSON' }); }
        // 清除：给的是 names，下发的是一组立刻过期的同名 Cookie。
        // 过期属性必须跟当初写入时**完全一致**（SameSite=None; Secure），
        // 否则浏览器认为这是另一个 Cookie，旧的原封不动留着。
        if (Array.isArray(payload.names)) {
          const names = payload.names
            .map((n) => String(n || '').trim())
            .filter((n) => /^[\w.\-]+$/.test(n));
          const expired = names.map((n) => `${n}=; Path=/; Max-Age=0; SameSite=None; Secure`);
          return sendJSONWithCookies(res, 200, {
            ok: true,
            host: req.headers.host || '',
            cleared: names,
          }, expired);
        }
        // 桥页面跑在跨站 iframe 里，必须用 SameSite=None; Secure，否则浏览器静默丢弃
        const out = buildCookieHeaders(
          Array.isArray(payload.cookies) ? payload.cookies : [],
          { crossSite: true }
        );
        return sendJSONWithCookies(res, 200, {
          ok: true,
          host: req.headers.host || '',
          written: out.written,
          skipped: out.skipped,
          httpOnly: out.httpOnly,
        }, out.headers);
      }

      return sendJSON(res, 405, { error: '仅支持 GET / POST' });
    }

    // 通用反向代理
    if (pathname === '/api/proxy') {
      if (req.method !== 'POST') return sendJSON(res, 405, { error: '仅支持 POST' });
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return sendJSON(res, 400, { error: '请求体必须是 JSON' });
      }
      const state = loadState();
      const base = payload.base || state.target;
      try {
        const result = await doProxy({
          ...payload,
          base,
          // state.autoLoopback === false 可以关掉自动换名，尊重用户的精确控制
          autoLoopback: state.autoLoopback !== false,
        });
        return sendJSON(res, 200, { ok: true, ...result });
      } catch (e) {
        const code = connErrorCode(e);
        const msg =
          e.name === 'TimeoutError'
            ? `请求超时（>${payload.timeoutMs || state.requestTimeoutMs}ms）`
            : `${e.message}${code && !e.message.includes(code) ? `（${code}）` : ''}`;
        return sendJSON(res, 200, {
          ok: false,
          error: msg,
          url: joinUrl(base, payload.url || ''),
          askedHost: hostOf(base),
          // 连不上时把「试过哪些回环主机名」交出去，界面上能一眼看出
          // 是后端没启动、还是这个主机名根本不对。
          // 没拿到就是没拿到，宁可给空数组也不要用候选列表充数 ——
          // 那会让界面谎称「试过三个」，而实际只试了一个。
          attemptedHosts: e.attemptedHosts || [],
          loopbackHint: isLoopbackHost(hostOf(base))
            ? 'localhost 与 127.0.0.1 已被自动互相尝试过；仍不通说明后端没在这个端口上监听'
            : '',
          durationMs: 0,
        });
      }
    }

    // 浏览器「真的打开了」的探针。
    //
    // 打开浏览器这个动作在本机是没有回执的：cmd /c start 一律返回 0，
    // 哪怕 URL 根本没人接管（实测 start 打开一个不存在的协议也是 exit=0）。
    // 所以不能拿退出码当成功判据，只能靠「浏览器有没有回来请求」来确认 ——
    // 于是让它先请求 /__open，这个地址被请求到就说明浏览器确实起来了。
    // 随后 302 回首页，用户地址栏里看到的仍是干净的 /，不会留下奇怪参数。
    if (pathname === '/__open') {
      markBrowserOpened();
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: '禁止访问' });
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(filePath).pipe(res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    sendJSON(res, 404, { error: '未知接口' });
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message });
    else res.end();
  }
};

// 同时监听两个回环地址
//
// 只绑 127.0.0.1 是不够的：面板要用隐藏 iframe 把会话「桥」到另一个主机名上，
// 而 Windows 上 localhost 通常先解析到 ::1。若服务没在 ::1 上应答，从
// 127.0.0.1 打开的页面就桥不到 localhost，那半边永远是空罐。
//
// 所以固定同时听 127.0.0.1 和 ::1。setHOST 只是决定控制台里推荐哪个地址。
const LISTEN_HOSTS = ['127.0.0.1', '::1'];
/**
 * 「面板本来就在跑，这次只是复用」的专用退出码。
 * DevSwitch.bat 认这个码就静默关窗口 —— 它不是错误，没必要让人再按一次键。
 */
const EXIT_ALREADY_RUNNING = 2;
let readyCount = 0;
let listenFailed = 0;
/** 真正监听成功的地址。可能只有一个（另一个被占或 IPv6 被禁用）。 */
const liveHosts = [];

/** 把主机名拼成可点的 URL。IPv6 字面量必须带方括号。 */
function panelUrl(host) {
  return `http://${host.includes(':') ? `[${host}]` : host}:${PORT}`;
}

/** 浏览器是否已经回来请求过 /__open —— 用来确认「真的打开了」。 */
let browserOpened = false;
let browserOpenedAt = 0;
function markBrowserOpened() {
  if (browserOpened) return;
  browserOpened = true;
  browserOpenedAt = Date.now();
}

/**
 * 用系统默认浏览器打开面板。
 *
 * 只在 `.bat` / 手写 `OPEN_BROWSER=1 node server.js` 时走这里。
 * **双击 DevSwitch.exe 不走这里** —— 由启动器自己用 ShellExecute 打开，
 * 原因见 launcher/Program.cs 顶部注释（.NET 读环境变量会炸的那个坑）。
 *
 * 命令行手敲 node server.js 不会弹浏览器 —— 你可能正在远程/服务里跑，不想被抢焦点。
 * 不引第三方包，用各平台自带的命令。
 *
 * 为什么写得这么啰嗦：
 *  「打开浏览器」是本工具唯一一个**本机没有回执**的动作。cmd /c start 无论成功失败
 * 都返回 0（实测连不存在的协议也是 0），所以老写法「spawn 一下、错误全吞」的问题是：
 * 打不开时它照样打印「已在浏览器中打开」，用户看到一句假话，然后什么都没发生，
 * 而代码里也没有任何线索可查。
 *
 * 现在的判据（重要，改过两轮）：
 *  1. 依次尝试多种打开方式，前一种没发起进程（ENOENT 等）就换下一种；
 *  2. 判成功用**浏览器进程数有没有增加**，探针只作加分项 ——
 *     曾经把「探针没回访」当失败，结果机器上浏览器明明开了却报「没能打开」，
 *     因为本机有 HTTP_PROXY，浏览器请求被接管，探针根本回不来；
 *  3. 真没发起任何进程才算失败，并给出可点的地址。
 *
 * @param {string} url 要打开的面板地址
 * @param {boolean} canVerify 本进程能不能观测到浏览器的回访。
 *   首次启动时为 true（浏览器访问的就是本进程）。
 *   复用已有实例时为 false —— 浏览器会去请求那个**已经在运行**的旧面板，
 *   请求根本不经过本进程，在这里等永远是白等，不能拿它当失败证据。
 */
async function openPanelInBrowser(url, canVerify = true) {
  const target = url || panelUrl(liveHosts.includes(HOST) ? HOST : liveHosts[0] || HOST);

  // 先打这个地址，浏览器落地后再跳到首页。
  // 目的：让「有没有打开」变成可观测的 —— 见 markBrowserOpened 的注释。
  const probe = target.replace(/\/+$/, '') + '/__open';

  /** 各平台可用的打开方式，按可靠性排序。 */
  const candidates =
    process.platform === 'win32'
      ? windowsOpenCandidates(probe)
      : process.platform === 'darwin'
        ? [{ cmd: 'open', argv: [probe] }]
        : [
            { cmd: 'xdg-open', argv: [probe] },
            { cmd: 'gio', argv: ['open', probe] },
          ];

  let spawnedBy = null;

  // 判据分两层，这是这段代码最重要的一次修正：
  //
  //   曾经的做法：等 /__open 探针回访，等不到就判「没能打开」。
  //   实测发现这是**错的**：DevSwitch.exe 启动时浏览器进程数确实 +1
  //   （31 → 32，浏览器真的开了），但探针就是没回访，
  //   于是日志打出「⚠ 没能自动打开浏览器」—— 明明是开了。
  //
  //   为什么探针会不回访？本机配了 HTTP_PROXY=http://127.0.0.1:55152，
  //   浏览器/安全软件可能把请求接管了；也可能只是冷启动慢于等待窗口。
  //   探针本来是「防止假装成功」的手段，结果变成了「谎报失败」的手段。
  //
  // 所以改成：
  //   1. 发出命令后看**浏览器进程数有没有增加** —— 这才是「开了」的硬证据；
  //   2. 探针回访退化成加分项：回来了就说「已在浏览器中打开」，
  //      没回来但进程增了就说「已打开（页面可能还在加载）」；
  //   3. 进程也没增、命令也没发出去，才算真失败。
  const before = countBrowserProcs();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ok = await spawnDetached(c.cmd, c.argv, !canVerify);
    if (!ok) continue; // 这条命令根本没跑起来（ENOENT 等），换下一种
    spawnedBy = c.label || c.cmd;

    if (!canVerify) break; // 复用分支无从验证，直接认

    // 快窗口：已常驻的浏览器会立刻回访；冷启动的浏览器进程会先起来。
    // 两个信号任一出现就算成功，不必等另一个。
    const hit = await waitFor(
      () => browserOpened || countBrowserProcs() > before,
      6000,
    );
    if (hit) break;
  }

  if (!spawnedBy) {
    // 一个候选都没能发起进程 —— 这是真失败，如实说。
    console.log('');
    console.log('  ⚠ 没能自动打开浏览器');
    console.log(`    请手动打开：${target}`);
    return false;
  }

  if (!canVerify) {
    console.log('  → 已请求系统打开浏览器（面板在已运行的实例里，直接过去用就行）');
    return true;
  }

  if (browserOpened) {
    console.log(`  ✓ 已在浏览器中打开（${spawnedBy}）`);
  } else if (countBrowserProcs() > before) {
    // 进程起来了但页面还没连回来 —— 正常，冷启动正在加载。
    console.log(`  ✓ 已打开浏览器（${spawnedBy}），页面正在加载…`);
  } else {
    // 命令发出去了、进程却没增。可能是浏览器复用了已有实例开标签页
    // （那种情况进程数本来就不会变），所以也不能断言失败。
    console.log(`  → 已用 ${spawnedBy} 打开面板`);
    console.log(`    没看到页面就手动打开：${target}`);
  }
  return true;
}

/**
 * 数一下当前有几个浏览器进程。
 *
 * 用途：判断「打开浏览器」这个动作到底有没有生效。
 * 这是比探针更硬的证据 —— 探针依赖网络，会被代理/插件拦截；
 * 进程数不会，它只反映「有没有真的把浏览器拉起来」。
 *
 * 注意一个已知局限：浏览器**已经开着**时，打开新标签页不会新增进程，
 * 所以「进程数没变」不等于「没打开」。调用方必须把这一点考虑进去 ——
 * 这也是为什么上面失败分支只说「没看到页面就手动打开」，而不说「失败了」。
 *
 * 用 tasklist 而不是读 /proc：Windows 上这是最省事的办法，且不引依赖。
 * 任何异常都返回 -1，让调用方当作「不知道」，绝不因此打断启动流程。
 */
function countBrowserProcs() {
  if (process.platform !== 'win32') return -1;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq chrome.exe', '/FI', 'IMAGENAME eq msedge.exe', '/FI', 'IMAGENAME eq firefox.exe', '/NH'],
      { encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: 'pipe' },
    );
    // tasklist 多个 /FI IMAGENAME 之间是 AND 关系，等于啥都筛不出来。
    // 所以逐个查，别嫌麻烦 —— 正确性优先。
    let n = 0;
    for (const exe of ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', '360chrome.exe']) {
      try {
        const o = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], {
          encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: 'pipe',
        });
        n += (o.match(new RegExp(exe.replace('.', '\\.'), 'gi')) || []).length;
      } catch {
        // 单个查不到就算了
      }
    }
    return n;
  } catch {
    return -1;
  }
}

/**
 * Windows 上「打开浏览器」的候选方式，按可靠性从高到低。
 *
 * 为什么不再把 `cmd /c start "" <url>` 放在第一位：
 * 它是走 shell 协议关联的，中间隔着 ProgId → 注册表 → 浏览器，
 * 任何一环有问题（关联被改坏、安全软件拦截、shell 扩展异常）都会
 * **静默什么都不做**，而且照样返回 0。用户那边看到的就是「没反应」，
 * 我这边也拿不到任何错误 —— 这个坑我们踩过一次。
 *
 * 现在优先直接启动浏览器自己的 exe：路径是确定的，成没成一眼能看出来。
 * cmd / start 只留作最后兜底（比如用户装了别的默认浏览器）。
 *
 * 顺序不是乱排的：**先用注册表问出「用户的默认浏览器是哪个」**，
 * 再直接启动那个 exe。这样既尊重用户的选择（不会因为本机装了 Chrome
 * 就绕过他设的 Edge），又避开了协议关联这条会静默失败的链路。
 */
function windowsOpenCandidates(probe) {
  const list = [];
  const seen = new Set();

  const push = (exe, label) => {
    if (!exe) return;
    const key = exe.toLowerCase();
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(exe)) return;
    } catch {
      return;
    }
    seen.add(key);
    list.push({ cmd: exe, argv: [probe], label });
  };

  // 1. 用户的默认浏览器（注册表 UserChoice 里的 ProgId → 对应 exe）
  push(defaultBrowserExe(), '默认浏览器');

  // 2. 万一注册表那步拿不到（权限/格式变化），退回按常见路径猜。
  //    这些只是候选，装没装用 existsSync 判断，不会误报。
  const browsers = [
    ['Chrome', process.env.PROGRAMFILES, 'Google\\Chrome\\Application\\chrome.exe'],
    ['Chrome', process.env['PROGRAMFILES(X86)'], 'Google\\Chrome\\Application\\chrome.exe'],
    ['Chrome', process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'],
    ['Edge', process.env['PROGRAMFILES(X86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Edge', process.env.PROGRAMFILES, 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['Firefox', process.env.PROGRAMFILES, 'Mozilla Firefox\\firefox.exe'],
    ['Firefox', process.env['PROGRAMFILES(X86)'], 'Mozilla Firefox\\firefox.exe'],
    ['Brave', process.env.PROGRAMFILES, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['360 极速', process.env.LOCALAPPDATA, '360Chrome\\Chrome\\Application\\360chrome.exe'],
  ];
  for (const [label, base, rest] of browsers) {
    if (base) push(path.join(base, rest), label);
  }

  // 3. 兜底 1：explorer 打开 URL。
  //    实测这条在 Windows 上很稳 —— explorer 会把 URL 交给默认浏览器，
  //    而且它本来就常驻，不需要新起进程，冷启动路径最短。
  list.push({ cmd: 'explorer.exe', argv: [probe], label: 'explorer' });
  // 4. 兜底 2：交给 URL 协议处理器（不依赖 cmd 的解析）
  list.push({ cmd: 'rundll32', argv: ['url.dll,FileProtocolHandler', probe], label: 'rundll32' });
  // 5. 兜底 3：传统 start。"" 是窗口标题占位，少了它 URL 会被当成标题。
  list.push({ cmd: 'cmd', argv: ['/c', 'start', '', probe], label: 'cmd start' });

  return list;
}

/**
 * 从注册表问出默认浏览器的 exe 路径。
 *
 * 两级查：
 *   HKCU\...\UrlAssociations\http\UserChoice  → ProgId（比如 ChromeHTML）
 *   HKCR\<ProgId>\shell\open\command           → 命令行，抠出 exe 路径
 * 拿不到就返回 null，让调用方退回按路径猜。
 *
 * 用 reg.exe 而不是读写注册表 API：零依赖，且 Node 里没有内置的注册表接口。
 * 失败一律当「不知道」，不抛错 —— 这函数只是锦上添花，不能拖垮启动流程。
 */
function defaultBrowserExe() {
  try {
    const { execFileSync } = require('child_process');

    const q = execFileSync('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000,
      windowsHide: true,
    });
    const m = q.match(/ProgId\s+REG_SZ\s+(\S+)/i);
    if (!m) return null;
    const progId = m[1].trim();

    const cmdOut = execFileSync('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000,
      windowsHide: true,
    });
    // 命令行形如 "C:\...\chrome.exe" --single-argument %1
    const em = cmdOut.match(/"([^"]+\.exe)"/i) || cmdOut.match(/([A-Za-z]:\\[^\s"]+\.exe)/i);
    if (!em) return null;

    // %1 / --single-argument 之类不参与判断，只取 exe 本身
    return em[1];
  } catch {
    return null;
  }
}

/**
 * spawn 一个子进程。同步抛错或 emit error 都算失败。
 *
 * @param {boolean} detach 是否让子进程脱离父进程独立存活。
 *   **首次启动传 false**：父进程本来就要长期跑着，子进程不需要独立，
 *   而且实测「detached + 浏览器 exe」在某些环境下会静默不生效 ——
 *   进程创建成功、不报错、浏览器就是不出来。
 *   **复用分支传 true**：那边启动完 200ms 就 process.exit，
 *   不脱离的话浏览器会被一起带走。
 */
function spawnDetached(cmd, argv, detach = false) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const p = spawn(cmd, argv, {
        stdio: 'ignore',
        detached: !!detach,
        // 别让 cmd / rundll32 闪一个黑框出来
        windowsHide: true,
      });
      p.on('error', (e) => {
        // 只有「命令根本没跑起来」才算失败（ENOENT 等）。
        // 注意不能用退出码判断 —— cmd /c start 永远返回 0。
        console.log(`  · 用 ${cmd} 打开失败：${e.code || e.message}`);
        done(false);
      });
      if (detach) p.unref();
      // 没有 error 就当它成功发起了
      setTimeout(() => done(true), 150);
    } catch (e) {
      console.log(`  · 用 ${cmd} 打开失败：${e.message}`);
      done(false);
    }
  });
}

/** 轮询等某个条件成立，最多等 ms 毫秒。 */
function waitFor(fn, ms) {  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - t0 >= ms) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * 端口被占用时的处理：判断占着的是不是「我们自己」。
 *
 * 用户双击 DevSwitch.bat 最常见的场景不是首次启动，而是「我已经开着了，又点了一次」。
 * 这时候正确行为是「把页面给你打开」，而不是甩一段 EADDRINUSE 让人去猜。
 *
 * 判断依据：GET /api/state 能返回 JSON、且带 target/accounts 这些字段，
 * 就认为是本工具（别人家的服务不会长这样）。认不出来就照实报错，不瞎猜。
 */
async function handleAlreadyRunning() {
  const foundHost = await probeExistingPanel();
  if (foundHost) {
    const url = panelUrl(foundHost);
    console.log('');
    console.log(`  ✓ 面板已经在运行了（端口 ${PORT} 被占用，占用的就是本工具）`);
    console.log(`  面板地址   ${url}`);
    // 浏览器不开的情况（DevSwitch.exe 带 --no-browser 启动）：
    // 直接退 2，由启动器负责把页面打开 —— 它那边能可靠地观察到端口已在服务，
    // 用 ShellExecute 打开也不会受这里进程即将退出的影响。
    if (OPEN_BROWSER_OFF) {
      console.log('  （页面由启动器打开）');
      process.exit(EXIT_ALREADY_RUNNING);
    }

    // 注意顺序：先等确认，再打印结论。
    // 老代码是「先打印『已在浏览器中打开』，再去开」，开没开成都会说成功 ——
    // 打不开时用户得到的是一句假话，也留不下任何线索。
    // 第二个参数 false：面板跑在**另一个**进程里，浏览器不会回访本进程，
    // 在这里等 /__open 永远等不到，不能用它判定失败。
    await openPanelInBrowser(url, false);
    // 给浏览器一点时间接管，然后把这次多起的进程退掉。
    // 用 2 这个专用退出码告诉启动器「是复用已有实例，不是出错」，
    // 脚本据此直接关窗口，不再让人按一次键。
    setTimeout(() => process.exit(EXIT_ALREADY_RUNNING), 200);
    return;
    console.log('  （想强制重启：先关掉之前那个窗口，再运行一次）');
    process.exit(EXIT_ALREADY_RUNNING);
  }

  console.error(`  ✗ 端口 ${PORT} 被别的程序占用了，请换个 PORT`);
  console.error(`    换端口：PORT=5000 node server.js（CMD 用 set PORT=5000 && ...）`);
  process.exit(1);
}

/**
 * 探测端口上跑的是不是本工具。
 *
 * 依次试两个回环地址 —— 只试 HOST 不够：正在跑的旧面板可能只在另一个回环上听着
 * （比如它启动那会儿 HOST 那个地址被占，它就退到了 ::1）。这时只探 HOST 会把它
 * 误判成「别人的程序」，把本来能直接用的面板报成错误。
 *
 * 认出来就返回**那个真正响应了的地址**（用来拼 URL 给浏览器），认不出返回 null。
 */
async function probeExistingPanel() {
  const first = HOST === 'localhost' ? '127.0.0.1' : HOST;
  // 先去重：HOST 常常就是 127.0.0.1，没必要探两遍同一个地址。
  const order = [...new Set([first, ...LISTEN_HOSTS])];
  for (const h of order) {
    if (await probePanelAt(h)) return h;
  }
  return null;
}

/** 探单个地址：GET /api/state，认返回结构。认得出返回 true。 */
function probePanelAt(host) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port: PORT,
        path: '/api/state',
        method: 'GET',
        timeout: 1500,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(false);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 65536) res.destroy();
        });
        res.on('end', () => {
          try {
            const s = JSON.parse(body);
            // 本工具的 state 一定带 target；accounts 是数组。够特征了。
            resolve(!!s && typeof s.target === 'string' && Array.isArray(s.accounts));
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

LISTEN_HOSTS.forEach((bindHost) => {
  // 两个地址各建一个 server 实例，共用同一个 handler
  const s = http.createServer(requestHandler);
  s.on('error', (e) => {
    listenFailed += 1;
    // ::1 在某些机器上被禁用，属正常，只提一句
    console.log(`  · 监听 ${bindHost}:${PORT} 失败：${e.code || e.message}`);

    if (listenFailed === LISTEN_HOSTS.length) {
      // 端口被占用，最常见的原因是「这个面板已经开着，你又双击了一次」。
      // 这种情况报错退出最烦人 —— 用户想要的是「打开页面」，不是看错误。
      // 所以先探一下：如果占着端口的正是我们自己的面板，就直接把页面打开。
      if (e.code === 'EADDRINUSE') {
        return handleAlreadyRunning();
      }
      console.error('  ✗ 两个回环地址都监听失败，请换个 PORT');
      process.exit(1);
    }
  });
  s.listen(PORT, bindHost, () => {
    readyCount += 1;
    // 记下真的听成功了的地址 —— 不能假设 HOST 一定可用。
    // 比如 127.0.0.1 被别的程序占了、只有 ::1 起来，还按 HOST 拼地址就会打开一个死链。
    liveHosts.push(bindHost);
    if (readyCount < LISTEN_HOSTS.length - listenFailed) return;

    // 决定用哪个地址当「面板地址」：优先用户设的 HOST，它没听上就退到第一个可用的
    const panelHost = liveHosts.includes(HOST) ? HOST : liveHosts[0];
    const state = loadState();
    const line = '─'.repeat(52);
    console.log('');
    console.log(line);
    console.log('  🎛  开发登录 / 租户切换工具已启动');
    console.log(line);
    console.log(`  面板地址   ${panelUrl(panelHost)}`);
    const other = liveHosts.find((h) => h !== panelHost);
    if (other) console.log(`  也可访问   ${panelUrl(other)}`);
    console.log(`  当前后端   ${state.target}`);
    console.log(`  配置文件   ${STATE_FILE}`);
    console.log(line);

    // Cookie 只认主机名、不认端口。面板跟后端若一个用 localhost、一个用
    // 127.0.0.1，浏览器会当成两个站点。写入时会同时落到两个主机名上，
    // 所以无论你用哪个地址打开面板，直连业务页面都是登录态。
    const targetHost = hostOf(state.target);
    if (targetHost === 'localhost' || targetHost === '127.0.0.1') {
      console.log('  Cookie 会同时写入 localhost 与 127.0.0.1 —— 两个地址直连业务页面都是登录态');
    } else if (targetHost) {
      console.log(`  ⚠ 后端在 ${targetHost}，与面板不是同一个主机名，Cookie 不通用。`);
      console.log(`    写进浏览器只对 ${targetHost} 生效需要面板也用这个主机名打开。`);
    }

    // 回环兜底：本机同时跑「只绑 IPv4」和「只绑 IPv6」的后端很常见，
    // 填死一个主机名就会有一半连不上，这里说明它会自动换名。
    if (isLoopbackHost(targetHost)) {
      const peers = loopbackVariants(state.target)
        .map((b) => hostOf(b))
        .filter((h) => h !== targetHost);
      if (state.autoLoopback === false) {
        console.log(`  · 回环兜底已关闭：只连 ${targetHost}，连不上不会自动换名（配置项 autoLoopback）`);
      } else {
        console.log(`  · 回环兜底已开启：${targetHost} 连不上时自动改用 ${peers.join(' / ')} 重试`);
      }
    }
    console.log(line);
    console.log('  提示：后端地址、登录接口、租户头都可在页面上直接改并保存');
    console.log('  Ctrl+C 退出');
    console.log('');

    // 双击 DevSwitch.exe 时，浏览器由 exe 自己打开，这里不重复开。
    // 直接 node server.js（OPEN_BROWSER=1）时才走这条。
    if (!OPEN_BROWSER_OFF) {
      openPanelInBrowser(panelUrl(panelHost)).catch(() => {});
    }
  });
});
