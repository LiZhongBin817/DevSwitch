'use strict';

/* ============================ 状态 ============================ */

let state = null;          // 服务端配置
let session = { token: '', cookies: [], accountId: null, tenantId: null, comboId: null, loginAt: null };
let activeSettingsSec = 'login';
let lastResp = { text: '', headers: {}, curl: '' };
let activeRespTab = 'body';

/**
 * 后端「实际」落在哪个主机名上。
 *
 * 用户填的 target 可能连不上（本机有的后端只绑 IPv4、有的只绑 IPv6），
 * 服务端会自动换一个回环名再试。这里记下真实结果，界面据此如实显示
 * 「填的是 127.0.0.1，实际连的是 localhost」—— 否则用户会以为自己填错了。
 *   { askedHost, host, hostSwitched, resolvedBase, at }
 */
let backendRoute = { askedHost: '', host: '', hostSwitched: false, resolvedBase: '', at: null };

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ============================ 小工具 ============================ */

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 220);
  }, 2200);
}

/** 按 a.b.c 取值 */
function pickPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((acc, k) => {
    if (acc === undefined || acc === null) return undefined;
    if (k === '') return acc;
    return acc[k];
  }, obj);
}

/** 模板渲染：{{key}} 替换 */
function render(tpl, vars) {
  if (typeof tpl !== 'string') return tpl;
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key])
  );
}

function parseJsonLoose(text, fallback) {
  if (!text || !String(text).trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 格式错误：' + e.message);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ============================ 与本地服务通信 ============================ */

async function loadState() {
  const r = await fetch('/api/state');
  state = await r.json();
  if (!Array.isArray(state.combos)) state.combos = [];
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.tenants)) state.tenants = [];
  // 老配置里没有这个字段。服务端按「缺省即开启」处理（!== false），
  // 前后端必须一致，否则复选框显示未勾选、实际却在兜底，用户会以为开关失灵。
  if (state.autoLoopback === undefined) state.autoLoopback = true;
}

async function saveState() {
  const r = await fetch('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('保存失败');
}

/** 配一个合法的回环主机名（IPv6 要带方括号，否则 URL 会忽略） */
function normalizeHostForUrl(h) {
  const s = String(h || '').trim();
  if (!s) return '';
  if (s === '::1') return '[::1]';
  return s;
}

/**
 * 记下「这次请求实际连到了哪个主机名」。
 *
 * 服务端每次代理都会回报 host / askedHost。只要它跟用户填的不一样，就说明
 * 回环兜底生效了 —— 这个事实必须一直显示在界面上，否则用户下次把地址改回
 * 127.0.0.1 又会撞上同一个坑，还以为是面板坏了。
 */
function noteBackendRoute(result) {
  if (!result || !result.host) return;
  const switched = result.hostSwitched === true || result.loopbackFallback === true;
  backendRoute = {
    askedHost: result.askedHost || '',
    host: result.host,
    hostSwitched: switched,
    resolvedBase: result.resolvedBase || '',
    at: new Date().toISOString(),
  };
}

/** 通过本地服务反代请求后端 */
async function proxy(method, path, { body, headers, timeoutMs, base } = {}) {
  const r = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, url: path, body, headers, timeoutMs, base }),
  });
  const j = await r.json();
  // 成功失败都要记：失败时 attemptedHosts 能解释「到底试过谁」
  noteBackendRoute(j);
  return j;
}

/* ============================ 组装请求头 ============================ */

function buildHeaders({ token, tenantId, extra = {}, includeAuth = true, includeTenant = true }) {
  const h = {};
  // 全局附加头
  try {
    Object.assign(h, parseJsonLoose(state.extraHeaders, {}));
  } catch { /* 忽略 */ }
  // 传入的附加头
  Object.assign(h, extra || {});

  if (includeAuth && state.authHeader?.enabled && token) {
    const v = render(state.authHeader.valueTemplate || '{{token}}', { token });
    if (state.authHeader.name) h[state.authHeader.name] = v;
  }
  if (includeTenant && state.tenantHeader?.enabled && tenantId) {
    const t = state.tenants.find((x) => String(x.id) === String(tenantId));
    const v = render(state.tenantHeader.valueTemplate || '{{tenantId}}', {
      tenantId,
      tenantCode: t?.code || '',
      tenantName: t?.name || '',
    });
    if (state.tenantHeader.name) h[state.tenantHeader.name] = v;
  }
  // Cookie
  if (session.cookies && session.cookies.length) {
    h['Cookie'] = session.cookies.map((c) => String(c).split(';')[0]).join('; ');
  }
  return h;
}

/** 从 Set-Cookie 数组里提取 name=value，合并进会话
 *
 * 注意：这里保留整条 Set-Cookie 原文（连同 Path/HttpOnly/SameSite），而不是只留
 * "name=value"。因为「写进浏览器」时要复刻后端的属性 —— 后端下发的是 HttpOnly，
 * 我们若把它降级成普通 Cookie，安全性和行为都会跟真实链路不一致。
 * 取值的地方一律用 String(x).split(';')[0]，所以留着属性不影响任何老逻辑。
 */
function mergeCookies(setCookies) {
  if (!Array.isArray(setCookies)) return;
  const map = new Map();
  for (const raw of session.cookies) {
    const pair = String(raw).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i).trim(), String(raw).trim());
  }
  for (const raw of setCookies) {
    const pair = String(raw).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) map.set(pair.slice(0, i).trim(), String(raw).trim());
  }
  session.cookies = Array.from(map.values());
}

/** 取某个 cookie 的值 */
function getCookie(name) {
  if (!name) return '';
  for (const raw of session.cookies || []) {
    const pair = String(raw).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0 && pair.slice(0, i).trim() === name) return pair.slice(i + 1);
  }
  return '';
}

/** 从响应头里按名字取值（大小写不敏感） */
function getHeader(headers, name) {
  if (!headers || !name) return '';
  const lower = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : String(v);
  }
  return '';
}

/**
 * 判定业务是否成功。
 * 关键：tsie/BaseResp 体系下，「业务失败」也返回 HTTP 200，
 * 真正的成败在 body 的 retCode（T200=成功）。所以必须先看 retCode，
 * 只有没配 retCode 校验时才退回看 HTTP 状态码。
 */
function isBizOk(res, cfg) {
  const codePath = cfg?.successPath;
  if (codePath && res.json) {
    const code = pickPath(res.json, codePath);
    if (code !== undefined && code !== null) {
      const expect = cfg.successValue ?? 'T200';
      return String(code) === String(expect);
    }
  }
  return res.ok && res.status < 400;
}

/**
 * 从业务返回里提炼可读的错误信息。
 *
 * 关键坑：tsie 框架的登录失败处理器把「真实异常」塞在 data 字段里
 * （BaseRespBuilder.fail().setRetMsg(笼统文案).setData(exception.getMessage())），
 * 而 retMsg 是给三种不同异常共用的笼统文案，例如：
 *   CredentialsExpiredException / DisabledException / LockedException
 *     → 一律「请联系项目组成员」
 * 光看 retMsg 根本分不清是锁定、禁用还是密码过期，必须把 data 带出来。
 */
function bizError(res, fallback) {
  const j = res.json;
  if (j && typeof j === 'object') {
    const msg = j.retMsg || j.message || j.msg || j.error;
    const code = j.retCode ? `[${j.retCode}] ` : '';
    // data 里可能是字符串（异常信息），也可能是对象，统一转成一行短文本
    let detail = '';
    const d = j.data;
    if (typeof d === 'string') detail = d.trim();
    else if (d && typeof d === 'object') {
      // 空对象 / 空数组 纯属噪音，不要拼到报错里
      const hasContent = Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0;
      if (hasContent) detail = JSON.stringify(d);
    }
    detail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // 只有当 data 和 retMsg 不是同一句废话时才附上，避免「[T401] xx（xx）」
    if (msg) {
      const extra = detail && detail !== msg ? `（服务端异常：${detail}）` : '';
      return code + msg + extra;
    }
    if (detail) return fallback + '：' + detail;
  }
  const raw = (res.text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
  return fallback + (raw ? '：' + raw : '');
}

/**
 * 把「笼统文案」翻译成具体原因。
 * 锁定/禁用/密码过期三种异常在 retMsg 里共用「请联系项目组成员」，
 * 但 data 里带着真实异常名，可以对出来。
 */
function explainLoginFailure(detail) {
  const s = String(detail || '');
  const byException = [
    [/LockedException/i, '账号已被锁定（连续密码错误触发，默认锁 24 小时）'],
    [/DisabledException/i, '账号已被禁用'],
    [/CredentialsExpiredException/i, '密码已过期，需要重置'],
    [/InternalAuthenticationServiceException/i, '认证服务内部异常，通常是用户不存在或用户中心不可达'],
    [/BadCredentialsException/i, '账户名或密码不对'],
  ];
  for (const [re, text] of byException) {
    if (re.test(s)) return text;
  }
  // 没有异常名时退回看文案
  if (/请联系项目组成员/.test(s)) {
    return '账号被锁定 / 被禁用 / 密码过期（三者共用同一句提示，需管理员在用户中心确认）';
  }
  return '';
}

/* ============================ 登录 ============================ */

/**
 * 防止把账号试到锁死的熔断器。
 * tsie 体系后端有「连续密码错误锁定」策略，报错文案形如：
 *   「账户名或者密码输入错误，再尝试错误 2 次用户将被锁定!」
 * 一旦服务端报出剩余次数，就把它记下来，并且在剩余次数归零前
 * 拦住后续登录请求，避免手滑把我们自己锁死。
 */
const lockGuard = {
  // username -> 服务端报出的剩余可试次数（0 = 已锁定/已禁用，硬拦截）
  remaining: {},
  // username -> 最后一次报错文案
  lastMsg: {},
  // username -> 具体原因（锁定 / 禁用 / 密码过期）
  reason: {},

  /** 从错误文案里解析「再尝试错误 N 次」 */
  parse(msg) {
    const m = String(msg || '').match(/再尝试错误?\s*(\d+)\s*次/);
    return m ? Number(m[1]) : null;
  },

  /**
   * 是否已经是「锁死」状态。
   * 注意顺序：必须先排除「再尝试错误 N 次用户将被锁定!」这种还带剩余次数的提示，
   * 否则会把警告态误判成锁定态。
   */
  isLockedMessage(msg) {
    const s = String(msg || '');
    if (this.parse(s) !== null) return false;      // 还带剩余次数 → 只是警告
    return /请联系项目组成员|用户将被锁定|账户已被锁定|账号已被锁定|已被禁用|已被锁|密码已过期|CredentialsExpired|DisabledException|LockedException/.test(s);
  },

  /** 记录一次失败；返回剩余次数（锁定态返回 0，没解析到返回 null） */
  record(username, msg) {
    const n = this.parse(msg);
    if (n !== null) {
      this.remaining[username] = n;
      this.lastMsg[username] = msg;
      delete this.reason[username];
      return n;
    }
    if (this.isLockedMessage(msg)) {
      // 服务端已经不给试了，直接按 0 次处理，熔断所有后续自动登录
      this.remaining[username] = 0;
      this.lastMsg[username] = msg;
      const r = explainLoginFailure(msg);
      if (r) this.reason[username] = r;
      return 0;
    }
    return null;
  },

  /** 登录成功 → 清零 */
  clear(username) {
    delete this.remaining[username];
    delete this.lastMsg[username];
    delete this.reason[username];
  },

  /** 还能不能试 */
  check(username) {
    const n = this.remaining[username];
    if (n === undefined) return null;   // 没记录过，放行
    if (n <= 0) {
      const why = this.reason[username] || '账号已被锁定或禁用';
      return `账号 ${username} 已被后端拒绝登录：${why}\n\n` +
        `继续重试没有任何意义，只会让锁定时间重新计。\n` +
        `请先在用户中心解锁 / 重置密码，或改用「导入 Cookie」绕过登录接口。`;
    }
    return null;
  },

  /** 是否处于「只剩 1 次」的警戒状态 */
  isCritical(username) {
    return this.remaining[username] === 1;
  },
};

async function doLogin(account) {
  if (!state.login?.enabled) {
    session.accountId = account.id;
    return { skipped: true };
  }

  // 熔断：上次服务端已经说没剩几次了，就别再撞了
  const blocked = lockGuard.check(account.username);
  if (blocked) throw new Error(blocked);

  // 只剩 1 次时，强制要用户点确认，避免误触
  if (lockGuard.isCritical(account.username)) {
    const ok = window.confirm(
      `⚠️ 账号 ${account.username} 只剩最后 1 次尝试机会\n\n` +
      `服务端上次提示：${lockGuard.lastMsg[account.username] || ''}\n\n` +
      `再错一次账号就会被锁定。确定要用当前密码登录吗？\n` +
      `（建议改用「导入 Cookie」绕过登录）`
    );
    if (!ok) throw new Error('已取消登录（保护账号不被锁定）');
  }

  const vars = {
    username: account.username || '',
    password: account.password || '',
    accountName: account.name || '',
  };

  let extraHeaders = {};
  try {
    const raw = parseJsonLoose(render(state.login.headersTemplate, vars), {});
    for (const [k, v] of Object.entries(raw)) extraHeaders[k] = String(v);
  } catch { /* 忽略 */ }

  let body;
  if (state.login.contentType === 'form') {
    // 用模板里的 key 生成 x-www-form-urlencoded
    const tmp = render(state.login.bodyTemplate, vars);
    let obj = {};
    try { obj = JSON.parse(tmp); } catch { obj = {}; }
    body = Object.entries(obj)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    extraHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  } else {
    body = render(state.login.bodyTemplate, vars);
    extraHeaders['Content-Type'] = 'application/json';
  }

  const res = await proxy(state.login.method || 'POST', state.login.path, {
    body: state.login.method === 'GET' ? undefined : body,
    headers: extraHeaders,
    timeoutMs: state.requestTimeoutMs,
  });

  if (!res.ok) throw new Error('登录请求失败：' + (res.error || `HTTP ${res.status}`));

  // 先合并 Cookie：框架用 Set-Cookie 下发 JWT，必须在判成败前就收进来
  if (state.login.saveCookies) mergeCookies(res.cookies);

  // 业务成败判断（HTTP 200 里也可能是 T401）
  if (!isBizOk(res, state.login)) {
    const detail = bizError(res, `HTTP ${res.status}`);
    // 失败了就别留着半截会话，否则后面请求会带着脏 cookie 到处跑
    if (session.cookies.length && !getCookie(state.login.tokenHeaderName || 'Authorization')) {
      session.cookies = [];
    }
    // 记录服务端报出的剩余尝试次数／锁定态，防止把账号试到锁定
    const left = lockGuard.record(account.username, detail);
    // 立刻把警戒条画出来，不依赖调用方是否刷新界面
    renderLockGuard();

    // 给一句人话原因，别让用户对着「请联系项目组成员」猜
    const why = explainLoginFailure(detail);
    let hint = '';
    if (left === 0) {
      hint = `\n\n🚫 ${why || '账号已被后端拒绝登录'}。` +
        `\n继续重试没有意义，请到用户中心解锁 / 找回密码，或改用「导入 Cookie」绕过登录。`;
    } else if (left !== null) {
      hint = left <= 1
        ? `\n\n⚠️ 账号只剩 ${left} 次机会，再错就锁定了！建议改用「导入 Cookie」。`
        : `\n\n⚠️ 账号还剩 ${left} 次机会。`;
      if (why) hint += `\n（${why}）`;
    } else if (why) {
      hint = `\n\n💡 ${why}`;
    }
    throw new Error('登录失败：' + detail + hint);
  }

  // 登录成功，清掉失败计数
  lockGuard.clear(account.username);

  // ---- 取 Token：Cookie / 响应头 / 响应体，三种来源都支持 ----
  const tokenSource = state.login.tokenSource || 'cookie';
  const tokenName = state.login.tokenHeaderName || 'Authorization';
  let token = '';

  if (tokenSource === 'cookie') {
    token = getCookie(tokenName);
  } else if (tokenSource === 'header') {
    token = getHeader(res.headers, tokenName);
  } else {
    const tokenPath = state.login.tokenPath;
    if (tokenPath && res.json) {
      const v = pickPath(res.json, tokenPath);
      if (v !== undefined && v !== null) token = typeof v === 'string' ? v : JSON.stringify(v);
    }
  }

  // 兜底：按常见位置再找一遍，避免配置写错就彻底卡死
  if (!token) {
    token = getCookie(tokenName) || getHeader(res.headers, tokenName);
  }
  if (!token && res.json) {
    const guess = pickPath(res.json, 'data.accessToken') || pickPath(res.json, 'data.token')
      || pickPath(res.json, 'accessToken') || pickPath(res.json, 'token') || '';
    token = typeof guess === 'string' ? guess : '';
  }

  session.token = token;
  session.accountId = account.id;
  session.loginAt = new Date().toISOString();

  // 登录成功但既没 token 也没 cookie，说明配置和真实协议对不上，直接明说
  if (!token && !session.cookies.length) {
    throw new Error('登录接口返回成功，但没拿到任何凭证。请检查「Token 来源」设置。');
  }
  return { res, token };
}

/**
 * 登录成功后自动把会话同步进浏览器 Cookie 罐。
 *
 * 为什么必须自动：会话默认只活在页面内存里，用户在业务页面（另一个标签页）
 * 里是未登录态 —— 这正是「登录成功了但打开系统还是没登录」的来源。
 * 以前要用户自己找到并点「写入浏览器」，太容易被漏掉，所以这里默认就做。
 * 失败不影响登录本身（内存会话仍然可用），只在控制台留痕 + 界面如实标注。
 */
async function autoSyncBrowserCookies() {
  if (!session.cookies.length) return null;
  try {
    const r = await writeBrowserCookies();
    return r;
  } catch (e) {
    console.warn('[dev-switch] 自动写入浏览器 Cookie 失败：', e.message);
    return { ok: false, error: e.message };
  }
}

/* ============================ 手动导入会话 ============================ */

/**
 * 从浏览器 DevTools 里复制出来的 Cookie 字符串导入会话。
 * 用途：登录接口有「连续错误锁定」策略，或者密码在别人手里、
 * 或者登录走的是另一套用户中心（SSO）时，直接复用浏览器里已经
 * 登好的那个会话，绕过账号密码。
 *
 * 支持粘贴这几种形态：
 *   1) Authorization=eyJhbGci...; other=xxx        （DevTools → Network → Cookie 头的值）
 *   2) Authorization=eyJhbGci...\nother=xxx        （一行一个）
 *   3) [{"name":"Authorization","value":"eyJ..."}] （DevTools → Application → Cookies 复制的 JSON）
 *   4) 只贴一长串 JWT（自动当成 Authorization 的值）
 */
function parseCookieInput(raw, tokenName = 'Authorization') {
  const text = String(raw || '').trim();
  if (!text) return [];

  const out = new Map();
  const put = (name, value) => {
    const n = String(name || '').trim();
    const v = String(value == null ? '' : value).trim();
    if (n && v) out.set(n, n + '=' + v);
  };

  // 形态 3：JSON 数组
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item && typeof item === 'object' && item.name) put(item.name, item.value);
      }
      if (out.size) return Array.from(out.values());
    } catch { /* 不是 JSON，继续按文本解析 */ }
  }

  // 形态 4：整串就是 JWT（三段用点分隔，无等号）
  if (!text.includes('=') && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) {
    put(tokenName, text);
    return Array.from(out.values());
  }

  // 形态 1 / 2：name=value; name=value
  for (const seg of text.split(/[;\n\r]+/)) {
    const s = seg.trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    put(s.slice(0, i), s.slice(i + 1));
  }
  return Array.from(out.values());
}

async function importCookie(raw) {
  const tokenName = state.login?.tokenHeaderName || 'Authorization';
  const cookies = parseCookieInput(raw, tokenName);
  if (!cookies.length) throw new Error('没解析出任何 Cookie，请检查粘贴内容');

  session.cookies = cookies;
  // 顺手把其中的 token 提取出来，方便「带 Token」和复制
  session.token = getCookie(tokenName) || '';

  // 拿不到 token 也无所谓——框架是 Cookie 模式，cookie 在就能用
  if (!session.token) {
    const first = cookies.find((c) => /token|auth|jwt|session/i.test(c));
    if (first) session.token = String(first).split('=').slice(1).join('=');
  }

  session.loginAt = new Date().toISOString();
  return { count: cookies.length, token: session.token, names: cookies.map((c) => String(c).split('=')[0]) };
}

/* ============================ 切租户 ============================ */

async function doSwitchTenant(tenant) {
  if (!tenant) return { skipped: true };

  if (!state.tenantSwitch?.enabled) return { skipped: true };

  const vars = {
    tenantId: tenant.id || '',
    tenantCode: tenant.code || '',
    tenantName: tenant.name || '',
  };

  let extraHeaders = {};
  try {
    const raw = parseJsonLoose(render(state.tenantSwitch.headersTemplate, vars), {});
    for (const [k, v] of Object.entries(raw)) extraHeaders[k] = String(v);
  } catch { /* 忽略 */ }

  // 切租户接口按 contentType 组包：
  // TenantSwitchFilter 用 request.getParameter("tenantId") 取值，
  // 表单或 query 都能命中，JSON body 反而不一定能被 getParameter 读到。
  let body;
  let path = state.tenantSwitch.path;
  if (state.tenantSwitch.contentType === 'form') {
    const tmp = render(state.tenantSwitch.bodyTemplate, vars);
    let obj = {};
    try { obj = JSON.parse(tmp); } catch { obj = {}; }
    const qs = Object.entries(obj)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    if ((state.tenantSwitch.method || 'POST').toUpperCase() === 'GET') {
      // GET 时参数放 query 更稳
      path += (path.includes('?') ? '&' : '?') + qs;
      body = undefined;
    } else {
      body = qs;
      extraHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  } else {
    body = render(state.tenantSwitch.bodyTemplate, vars);
    extraHeaders['Content-Type'] = 'application/json';
  }

  const res = await proxy(state.tenantSwitch.method || 'POST', path, {
    body: (state.tenantSwitch.method || 'POST').toUpperCase() === 'GET' ? undefined : body,
    headers: buildHeaders({ token: session.token, tenantId: null, extra: extraHeaders, includeTenant: false }),
    timeoutMs: state.requestTimeoutMs,
  });

  if (!res.ok) throw new Error('切租户请求失败：' + (res.error || `HTTP ${res.status}`));

  // 切租户成功后服务端会重新下发 JWT（新 token 里带着新租户），必须收下来
  mergeCookies(res.cookies);
  const newToken = getCookie(state.login?.tokenHeaderName || 'Authorization')
    || getHeader(res.headers, state.login?.tokenHeaderName || 'Authorization');
  if (newToken) session.token = newToken;

  // 注意：这套框架「切换失败」也返回 T200，错误原因写在 retMsg 里，
  // 形如「切换租户失败, 错误原因: xxx」。必须同时看 retCode 和 retMsg。
  const okBiz = isBizOk(res, state.tenantSwitch);
  const msg = String(res.json?.retMsg || '');
  const failedByMsg = /失败|错误|异常/.test(msg) && !/成功/.test(msg);

  if (!okBiz || failedByMsg) {
    const detail = bizError(res, `HTTP ${res.status}`);
    throw new Error(`切租户失败：${detail}`);
  }

  session.tenantId = tenant.id;
  return { res };
}

/* ============================ 应用组合 ============================ */

async function applyCombo(combo) {
  const account = state.accounts.find((a) => a.id === combo.accountId);
  const tenant = state.tenants.find((t) => String(t.id) === String(combo.tenantId));
  if (!account) return toast('组合里的账号已不存在', 'err');

  const card = $(`.combo[data-id="${combo.id}"]`);
  card?.classList.add('busy');

  try {
    session.cookies = [];
    await doLogin(account);
    if (tenant) await doSwitchTenant(tenant);
    session.comboId = combo.id;
    renderAll();
    toast(`已切换到 ${combo.name || account.name}`, 'ok');
    // 组合切换后同样自动同步，否则业务页面拿到的还是旧会话
    autoSyncBrowserCookies().then((r) => {
      if (!r) return;
      renderAll();
      if (r.ok !== false && r.bridged && r.bridged.ok) {
        toast(`会话已写入 ${location.hostname} 与 ${r.bridged.host}`, 'ok');
      }
    });
  } catch (e) {
    // 登录成功但租户切换失败时，账号已变，需要刷新界面反映真实状态
    renderAll();
    toast(e.message, 'err');
  } finally {
    card?.classList.remove('busy');
  }
}

/* ============================ 渲染 ============================ */

function renderPing(kind, text, title) {
  const el = $('#pingState');
  el.className = 'ping ' + kind;
  el.querySelector('span').textContent = text;
  // 兜底时把「填的是谁、真连上的是谁」放进 title，鼠标一悬停就能看清，
  // 又不会把顶栏撑长
  if (title) el.title = title;
  else el.removeAttribute('title');
}

function renderAccounts() {
  const box = $('#accountList');
  if (!state.accounts.length) {
    box.innerHTML = '<p class="hint" style="margin:6px 0">还没有账号，点「+ 新增」添加。</p>';
    return;
  }
  box.innerHTML = state.accounts.map((a) => `
    <div class="row-item ${session.accountId === a.id ? 'active' : ''}" data-acc="${esc(a.id)}">
      <div class="row-main">
        <div class="row-title">${esc(a.name || a.username)}</div>
        <div class="row-sub">${esc(a.username)}${a.note ? ' · ' + esc(a.note) : ''}</div>
      </div>
      <div class="row-ops">
        <button class="icon-btn" data-edit-acc="${esc(a.id)}" title="编辑">✎</button>
        <button class="icon-btn" data-del-acc="${esc(a.id)}" title="删除">✕</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-acc]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-edit-acc]') || ev.target.closest('[data-del-acc]')) return;
      const acc = state.accounts.find((a) => a.id === el.dataset.acc);
      if (!acc) return;
      try {
        session.cookies = [];
        await doLogin(acc);
        session.comboId = null;
        renderAll();
        toast(`已登录为 ${acc.name || acc.username}`, 'ok');
        // 自动同步进浏览器，用户不必再找「写入浏览器」按钮
        autoSyncBrowserCookies().then((r) => {
          if (!r) return;
          renderAll();
          if (r.ok === false) {
            toast(`登录成功，但写入浏览器失败：${r.error}`, 'err');
          } else if (r.bridged && r.bridged.ok) {
            toast(`会话已写入 ${location.hostname} 与 ${r.bridged.host}`, 'ok');
          }
        });
      } catch (e) {
        // 登录失败可能刚落下了锁定计数，必须刷新界面，否则警戒条不出现
        renderAll();
        toast(e.message, 'err');
      }
    });
  });
  box.querySelectorAll('[data-edit-acc]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openAccountForm(state.accounts.find((a) => a.id === b.dataset.editAcc));
    })
  );
  box.querySelectorAll('[data-del-acc]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.accounts = state.accounts.filter((a) => a.id !== b.dataset.delAcc);
      state.combos = state.combos.filter((c) => c.accountId !== b.dataset.delAcc);
      if (session.accountId === b.dataset.delAcc) session.accountId = null;
      await saveState();
      renderAll();
      toast('已删除账号');
    })
  );
}

/**
 * 按筛选词过滤租户。
 * 支持空格分隔的多个关键词（全部命中才算），大小写不敏感，
 * 匹配范围包含名称、编码、ID —— 因为真实租户 ID 是长串 hash，
 * 光靠名字筛选有时不够用。
 */
function filterTenants(list, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return list;
  const words = kw.split(/\s+/).filter(Boolean);
  return list.filter((t) => {
    const hay = [t.name, t.code, t.id].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * 同步「列表底部渐隐」的显隐。
 * 内容没超出（不需要滚）或已经滚到底时，把渐隐收掉，
 * 否则用户会以为下面还有东西，白滚一次。
 */
function syncScrollFade(box) {
  const wrap = box?.closest('.list-scroll-wrap');
  if (!wrap) return;
  const noOverflow = box.scrollHeight <= box.clientHeight + 2;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  wrap.classList.toggle('at-bottom', noOverflow || atBottom);
}

function renderTenants() {
  const box = $('#tenantList');
  const all = state.tenants || [];

  if (!all.length) {
    box.innerHTML = '<p class="hint" style="margin:6px 0">还没有租户，可手动新增或用「⟳ 拉取」。</p>';
    const c0 = $('#tenantCount');
    if (c0) c0.textContent = '';
    return;
  }

  const keyword = $('#tenantFilter')?.value || '';
  const shown = filterTenants(all, keyword);

  // 顶部计数：让「筛掉了多少」一目了然
  const counter = $('#tenantCount');
  if (counter) {
    counter.textContent = keyword.trim()
      ? `${shown.length} / ${all.length}`
      : `${all.length} 个`;
    counter.classList.toggle('filtering', shown.length === 0);
  }

  if (!shown.length) {
    box.innerHTML = `<p class="hint" style="margin:6px 0">没有匹配「${esc(keyword.trim())}」的租户。</p>`;
    return;
  }

  box.innerHTML = shown.map((t) => `
    <div class="row-item ${String(session.tenantId) === String(t.id) ? 'active' : ''}" data-ten="${esc(t.id)}">
      <div class="row-main">
        <div class="row-title">${esc(t.name || t.code || t.id)}</div>
        <div class="row-sub">${esc(t.code || '')}${t.code ? ' · ' : ''}${esc(t.id)}</div>
      </div>
      <div class="row-ops">
        <button class="icon-btn" data-edit-ten="${esc(t.id)}" title="编辑">✎</button>
        <button class="icon-btn" data-del-ten="${esc(t.id)}" title="删除">✕</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('[data-ten]').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-edit-ten]') || ev.target.closest('[data-del-ten]')) return;
      const ten = state.tenants.find((t) => String(t.id) === String(el.dataset.ten));
      if (!ten) return;
      try {
        await doSwitchTenant(ten);
        session.comboId = null;
        renderAll();
        toast(`已切到租户 ${ten.name || ten.id}`, 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  });
  box.querySelectorAll('[data-edit-ten]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openTenantForm(state.tenants.find((t) => String(t.id) === String(b.dataset.editTen)));
    })
  );
  box.querySelectorAll('[data-del-ten]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.tenants = state.tenants.filter((t) => String(t.id) !== String(b.dataset.delTen));
      state.combos = state.combos.filter((c) => String(c.tenantId) !== String(b.dataset.delTen));
      if (String(session.tenantId) === String(b.dataset.delTen)) session.tenantId = null;
      await saveState();
      renderAll();
      toast('已删除租户');
    })
  );

  // 重绘后内容高度变了，渐隐状态要重新算（删除/筛选都会缩短列表）
  requestAnimationFrame(() => syncScrollFade(box));
}

function renderCombos() {
  const box = $('#comboGrid');
  if (!state.combos.length) {
    box.innerHTML = '<p class="hint" style="margin:2px 0">还没有组合。点「+ 新建组合」把「账号 + 租户」存成一个快捷方式。</p>';
    return;
  }
  box.innerHTML = state.combos.map((c) => {
    const acc = state.accounts.find((a) => a.id === c.accountId);
    const ten = state.tenants.find((t) => String(t.id) === String(c.tenantId));
    return `
      <button class="combo ${session.comboId === c.id ? 'active' : ''}" data-id="${esc(c.id)}">
        <div class="c-name">${esc(c.name || '未命名')}</div>
        <div class="c-meta">${esc(acc ? (acc.name || acc.username) : '账号缺失')} → ${esc(ten ? (ten.name || ten.id) : '无租户')}</div>
        <span class="c-tag">${esc(c.hotkey || '一键切换')}</span>
        <div class="c-ops">
          <span class="icon-btn" data-edit-combo="${esc(c.id)}" title="编辑">✎</span>
          <span class="icon-btn" data-del-combo="${esc(c.id)}" title="删除">✕</span>
        </div>
      </button>`;
  }).join('');

  box.querySelectorAll('.combo').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-edit-combo]') || ev.target.closest('[data-del-combo]')) return;
      const c = state.combos.find((x) => x.id === el.dataset.id);
      if (c) applyCombo(c);
    });
  });
  box.querySelectorAll('[data-edit-combo]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openComboForm(state.combos.find((c) => c.id === b.dataset.editCombo));
    })
  );
  box.querySelectorAll('[data-del-combo]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.combos = state.combos.filter((c) => c.id !== b.dataset.delCombo);
      if (session.comboId === b.dataset.delCombo) session.comboId = null;
      await saveState();
      renderCombos();
      toast('已删除组合');
    })
  );
}

/* ============================ 把会话写进浏览器 Cookie ============================ */

/**
 * 面板自己只在内存里维护会话，浏览器 Cookie 罐是空的 —— 所以你在
 * localhost 直接打开业务页面时是未登录态。这里负责把会话「搬」进浏览器。
 *
 * 四个必须记住的事实：
 *  1. 只能由服务端写。后端下发的是 HttpOnly Cookie，JS 的 document.cookie
 *     既设不出 HttpOnly，也读不到已经写进去的那些。所以走 /api/browser-cookie
 *     让本地服务用 Set-Cookie 响应头落盘。
 *  2. Cookie 不区分端口，只区分主机名。写在 localhost:4599 的 host-only
 *     Cookie，浏览器会照样发给 localhost:8080 —— 这正是我们想要的。
 *  3. localhost 和 127.0.0.1 是两个不同的主机名，Cookie 互不相通，
 *     设 Domain 也救不了（127.0.0.1 不是 localhost 的子域，浏览器直接拒收）。
 *  4. 想两个主机名都有登录态，唯一办法是让浏览器分别向它们各发一次请求 ——
 *     这就是下面的 cookieBridge()。用隐藏 iframe 去加载另一个主机名下的桥页面，
 *     由那个页面（而不是我们）发 Set-Cookie，Cookie 才会落在它自己的主机名上。
 */
const browserCookie = {
  written: [],
  jar: [],
  host: '',
  at: null,
  busy: false,
  /** 另一个主机名上的写入结果，形如 { '127.0.0.1:4599': { ok, written } } */
  bridged: {},
};

/** 与当前主机名成对的「另一个」主机名。只在 localhost / 127.0.0.1 之间配对。 */
function otherHost() {
  const h = location.hostname;
  if (h === 'localhost') return '127.0.0.1';
  if (h === '127.0.0.1') return 'localhost';
  return '';
}

/**
 * 通过隐藏 iframe，把数据交给「另一个主机名」上的自己，让它去发 Set-Cookie。
 *
 * 为什么非要这么绕：我们自己的 fetch 无论带什么参数，Cookie 都只会落在
 * 当前页面的主机名上。只有让浏览器真的去加载那个主机名下的文档，那里的 JS
 * 发的请求才会被算作那个主机名的第一方请求。
 *
 * 跨源所以 postMessage 必须用 '*'：两边主机名不同，没法给出确切 origin。
 * 也正因如此，桥页面那边要把消息当成不可信输入（它只做 Set-Cookie，不返回任何
 * 敏感内容给父窗口，写进去的 value 本来也是父窗口给的）。
 *
 * @param {{cookies?: string[], names?: string[]}} payload 要么给 cookies（写），要么给 names（清）
 * @returns {Promise<{host: string, ok: boolean, written?: string[], cleared?: string[], error?: string}>}
 */
function cookieBridge(payload) {
  const host = otherHost();
  if (!host) return Promise.resolve({ host: '', ok: false, error: '当前主机名不是 localhost / 127.0.0.1，无需桥接' });

  const action = Array.isArray(payload.names) ? 'clear' : 'write';
  const port = location.port ? ':' + location.port : '';
  const url = `${location.protocol}//${host}${port}/__cookie-bridge`;

  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(result);
    };

    function onMessage(ev) {
      const d = ev.data || {};
      if (!d || !d.__cookieBridge) return;
      // 只认自己那个 iframe 发来的消息，避免页面上别的桥互相串话
      if (ev.source !== iframe.contentWindow) return;
      if (d.kind === 'ready') {
        // 桥页面已就绪，把数据递过去
        try {
          iframe.contentWindow.postMessage(
            Object.assign({ __cookieBridge: 1, kind: action }, action === 'clear'
              ? { names: payload.names || [] }
              : { cookies: payload.cookies || [] }),
            '*'
          );
        } catch (e) {
          finish({ host: d.host || host, ok: false, error: e.message });
        }
        return;
      }
      if (d.kind === 'done') {
        finish({
          host: d.host || host,
          ok: !!d.ok,
          written: d.written || [],
          cleared: d.cleared || [],
          error: d.error || (d.ok ? '' : '桥页面写入失败'),
        });
      }
    }

    // 桥加载不出来（比如服务只监听了当前那个主机名）就别一直挂着
    const timer = setTimeout(() => {
      finish({ host, ok: false, error: `无法连接 http://${host}${port}（${timeoutHint()}）` });
    }, 6000);

    window.addEventListener('message', onMessage);
    iframe.src = url;
    document.body.appendChild(iframe);
  });
}

function timeoutHint() {
  return '面板服务需要同时监听 127.0.0.1 与 ::1（默认已开启）；若设了 HOST 环境变量，请确认包含这两个地址';
}

/** 问服务端：浏览器现在到底会不会把这些 Cookie 发给我 */
async function refreshBrowserCookieJar() {
  try {
    const r = await fetch('/api/browser-cookie');
    const j = await r.json();
    if (!j.ok) return;
    browserCookie.jar = j.jar || [];
    browserCookie.host = j.host || '';
  } catch { /* 服务没起来时静默，界面自然显示为空 */ }
}

/** 把当前会话里的 Cookie 全部写进浏览器（两个主机名各写一次） */
async function writeBrowserCookies() {
  if (!session.cookies.length) throw new Error('当前会话里没有 Cookie 可写');

  // 先写自己这个主机名 —— 它是「主」，失败就是真失败。
  const r = await fetch('/api/browser-cookie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies: session.cookies }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '写入失败');
  browserCookie.written = j.written || [];
  browserCookie.at = new Date().toISOString();

  // 再桥到另一个主机名。失败不算整体失败：当前主机名已经能用了，
  // 只是 127/localhost 那半边没写成，界面上会如实标出来。
  const bridged = await cookieBridge({ cookies: session.cookies });
  browserCookie.bridged = { [bridged.host || otherHost()]: bridged };

  await refreshBrowserCookieJar();
  return { ...j, bridged };
}

/** 把写进去的 Cookie 清掉（登出 / 换账号时用） */
async function clearBrowserCookies() {
  // 取「上次写了哪些」与「罐里现在有哪些属于本工具的」的并集。
  // 只用 written 会漏：页面刷新后 written 归零；用户若通过别的途径（比如手动调
  // /api/browser-cookie）写进去，written 里也不会有。而罐是唯一可信的来源，
  // 所以凡是罐里叫这个名字的都要清掉，宁可多清也不要留半截脏会话。
  const tokenName = state.login?.tokenHeaderName || 'Authorization';
  const sessionNames = new Set([tokenName, 'JSESSIONID']);
  const fromJar = browserCookie.jar.map((c) => c.name).filter((n) => sessionNames.has(n));
  const names = Array.from(new Set([...browserCookie.written, ...fromJar]));
  if (!names.length) throw new Error('浏览器里没有可清除的会话 Cookie');

  const r = await fetch('/api/browser-cookie', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '清除失败');

  // 另一个主机名上的同名 Cookie 也得清，否则 127 那边还留着一段旧会话
  const bridged = await cookieBridge({ names });
  browserCookie.bridged = {};

  browserCookie.written = [];
  browserCookie.at = null;
  await refreshBrowserCookieJar();
  return { ...j, bridged };
}

/**
 * 后端「实际」在哪个主机名上。
 *
 * 为什么不能直接用 state.target：回环兜底可能把 127.0.0.1 换成 localhost 才连上，
 * 那时 Cookie 该跟随的是 localhost（真正对端），而不是配置里写的 127.0.0.1。
 * 用错名字会让提示与实际行为错位 —— 界面说「同主机名，没问题」，
 * 浏览器却因为跨站把 Cookie 拦了。
 */
function effectiveBackendHost() {
  if (backendRoute.host && backendRoute.hostSwitched) return backendRoute.host;
  try {
    return new URL(state.target || '').hostname;
  } catch {
    return '';
  }
}

/**
 * 面板所在主机名 与 后端主机名 的关系，决定要不要给出提示。
 *
 * 情况分三种：
 *  - 面板和后端同一个主机名：直接就能用，无需提示。
 *  - 面板是 localhost 或 127.0.0.1，后端是另一个回环名：写入时会自动桥过去，
 *    两边都有登录态，给一条正向提示即可。
 *  - 后端是别的域名：Cookie 完全够不着，这才是真警告。
 */
function cookieHostNote() {
  const panelHost = location.hostname;
  const targetHost = effectiveBackendHost();
  if (!targetHost) return null;

  // 兜底换过名时，把「填的是什么」一并带上，好在提示里讲清楚为什么这里写的是
  // 另一个名字，而不是让人以为面板认错了地址。
  const askedHost = backendRoute.hostSwitched ? backendRoute.askedHost : '';

  if (panelHost === targetHost) return null;

  const loop = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  const bothLoopback = loop(panelHost) && loop(targetHost);
  if (bothLoopback) {
    return { kind: 'info', panelHost, targetHost, askedHost };
  }
  return { kind: 'warn', panelHost, targetHost, askedHost };
}

/**
 * 后端在 Set-Cookie 里写死的 Domain。
 *
 * 这是本项目踩过的最深的坑：后端（tsie 框架）登录时下发
 *   Set-Cookie: Authorization=...; Path=/; HttpOnly; Domain=127.0.0.1
 * Domain 被写死成 127.0.0.1。于是：
 *   - 在 http://127.0.0.1:8080 登录 → 浏览器正常接受 → 有登录态
 *   - 在 http://localhost:8080 登录 → localhost 不是 127.0.0.1 的子域
 *     → 浏览器**静默拒收**整条 Cookie，只有 JSESSIONID 落得下来
 *     → 业务接口返回 T302「请先登录」，看起来就像「登录成功了却没登录」
 *
 * 这不是本面板能修的（服务端行为），但必须如实告诉用户：
 * 想有登录态，浏览器地址栏就必须是那个 Domain 写死的名字。
 */
function backendCookieDomain() {
  for (const raw of session.cookies || []) {
    const m = /(?:^|;)\s*Domain=([^;]+)/i.exec(String(raw));
    if (m) return m[1].trim().replace(/^\./, '');
  }
  return '';
}

function renderSession() {
  const pill = $('#sessionPill');
  const loggedIn = !!session.token || session.cookies.length > 0;
  pill.className = 'pill ' + (loggedIn ? 'pill-on' : 'pill-off');
  pill.textContent = loggedIn ? '已登录' : '未登录';

  const body = $('#sessionBody');
  const acc = state.accounts.find((a) => a.id === session.accountId);
  const ten = state.tenants.find((t) => String(t.id) === String(session.tenantId));
  const combo = state.combos.find((c) => c.id === session.comboId);

  if (!loggedIn) {
    // 注意：这里也要渲染 Cookie 区块。浏览器罐是持久的 —— 刷新页面后内存里的
    // 会话没了，但上次写进浏览器的 Cookie 还在，清除入口不能跟着消失。
    body.innerHTML = '<div class="session-empty">尚未登录。点左侧账号，或点上方组合一键登录 + 切换租户。</div>'
      + renderBackendRouteBlock()
      + renderBrowserCookieBlock();
    bindBrowserCookieButtons();
    return;
  }

  body.innerHTML = `
    <div class="kv"><span class="k">账号</span><span class="v">${acc ? esc(acc.name || acc.username) : '<span style="color:#8b94a3">—</span>'}</span></div>
    <div class="kv"><span class="k">租户</span><span class="v">${ten ? esc(ten.name || ten.id) + (ten.code ? ' (' + esc(ten.code) + ')' : '') : '<span style="color:#8b94a3">未选择</span>'}</span></div>
    <div class="kv"><span class="k">组合</span><span class="v">${combo ? esc(combo.name) : '<span style="color:#8b94a3">—</span>'}</span></div>
    <div class="kv"><span class="k">登录时间</span><span class="v">${session.loginAt ? new Date(session.loginAt).toLocaleTimeString('zh-CN') : '—'}</span></div>
    ${session.token ? `<div class="kv"><span class="k">Token</span></div>
      <div class="token-box">${esc(session.token)}</div>` : ''}
    ${session.cookies.length ? `<div class="kv"><span class="k">Cookie</span></div>
      <div class="token-box">${esc(session.cookies.map((c) => String(c).split(';')[0]).join('; '))}</div>` : ''}
    ${renderBackendRouteBlock()}
    ${renderBrowserCookieBlock()}
  `;

  bindBrowserCookieButtons();
}

/**
 * 「这一次请求实际连到了哪个后端」。
 *
 * 只在「填的地址 ≠ 实际连上的地址」时出现 —— 这正是回环兜底生效的时刻。
 * 为什么必须显示：用户填 127.0.0.1，面板悄悄换成 localhost 连上了，
 * 表面上一切正常，但他下次换台机器、或后端换了绑定方式，同一份配置就
 * 忽然不通了，而且完全没有线索。把这条摆出来，问题从「玄学」变成「一眼」。
 */
function renderBackendRouteBlock() {
  if (!backendRoute.host || !backendRoute.hostSwitched) return '';
  return `
    <div class="bc-block">
      <div class="bc-head">
        <span class="k">后端通道</span>
      </div>
      <div class="bc-note bc-note-warn">你填的是 <b>${esc(backendRoute.askedHost)}</b>，该地址上没有服务在听，
        已自动改用 <b>${esc(backendRoute.host)}</b> 连上（同一个后端，只是主机名写法不同）。</div>
      <div class="bc-note">实际后端基址：<code>${esc(backendRoute.resolvedBase || '')}</code>。
        localhost 会同时尝试 IPv6 与 IPv4，所以<b>填 localhost 最稳</b>；
        127.0.0.1 只认 IPv4，遇到只绑 IPv6 的后端就会连不上。
        （可在「配置 → 请求头」关掉自动兜底）</div>
    </div>`;
}

/** Cookie 区块是每次重绘都重建的，事件必须当场绑，不能放 bindEvents */
function bindBrowserCookieButtons() {
  $('#writeBrowserCookieBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await writeBrowserCookies();
      renderSession();
      const n = (r.written || []).length;
      const b = r.bridged;
      if (b && b.ok) {
        toast(`已写入 ${n} 个 Cookie，并同步到 ${b.host}（两个地址直连业务页面都是登录态）`, 'ok');
      } else if (b && b.host) {
        // 当前主机名已成功，只是另一边没写进去 —— 说清楚，别让人以为全成了
        toast(`已写入 ${n} 个 Cookie 到 ${location.hostname}；同步到 ${b.host} 失败：${b.error}`, 'err');
      } else {
        toast(`已写入 ${n} 个 Cookie 到浏览器（${location.origin}）`, 'ok');
      }
      if (r.httpOnly?.length) {
        toast(`其中 ${r.httpOnly.join(', ')} 是 HttpOnly，已按后端属性写入`, '');
      }
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'err');
    }
  });

  $('#clearBrowserCookieBtn')?.addEventListener('click', async () => {
    try {
      const r = await clearBrowserCookies();
      renderSession();
      toast(r.bridged?.ok ? `已清除两个主机名上的 Cookie` : '已从浏览器清除 Cookie', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/**
 * 会话卡片最底下那块「浏览器 Cookie」。
 * 存在的理由：会话默认只在页面内存里，关掉浏览器就没了，而且在 localhost
 * 直接打开业务页面是未登录态。这里把会话同步进浏览器自己的 Cookie 罐。
 *
 * 状态判定以「服务端回读到的罐」为准，而不是以「我刚写了几个」为准：
 * 前者是浏览器真实行为，后者只是我们以为的。刷新页面后 written 会归零，
 * 但罐里的 Cookie 还在 —— 那时也得如实显示。
 */
function renderBrowserCookieBlock() {
  const jarNames = browserCookie.jar.map((c) => c.name);
  const written = browserCookie.written;
  const hostNote = cookieHostNote();

  // 「哪些罐里的 Cookie 算我们的会话」——不能只看 session.cookies：
  // 页面一刷新内存就空了，但罐里的 Cookie 还在，那时连清除按钮都不给就太蠢了。
  // 用配置里的会话 Cookie 名作判据（默认 Authorization），它天然就是本工具写进去的那个。
  const tokenName = state.login?.tokenHeaderName || 'Authorization';
  const sessionNames = new Set([
    tokenName,
    'JSESSIONID',
    ...session.cookies.map((c) => String(c).split('=')[0].trim()),
  ]);
  const ours = written.length
    ? jarNames.filter((n) => written.includes(n))
    : jarNames.filter((n) => sessionNames.has(n));
  const inJar = ours.length > 0;

  const stateLine = (() => {
    const hosts = otherHost() ? `${location.hostname} / ${otherHost()}` : location.hostname;
    if (inJar) {
      return `<span class="bc-state bc-state-ok">✓ 浏览器里有 ${ours.length} 个会话 Cookie（${esc(ours.join(', '))}），` +
        `${esc(hosts)} 直连业务页面即登录态</span>`;
    }
    if (written.length) {
      const missing = written.filter((n) => !jarNames.includes(n));
      return `<span class="bc-state bc-state-warn">写了 ${written.length} 个，` +
        `浏览器里只找到 ${ours.length} 个${missing.length ? `（${esc(missing.join(', '))} 没落地）` : ''}</span>`;
    }
    if (session.cookies.length) {
      return `<span class="bc-state bc-state-off">还没写入浏览器。直接打开业务页面会是未登录态。</span>`;
    }
    if (jarNames.length) {
      return `<span class="bc-state bc-state-off">罐里有 ${jarNames.length} 个其他 Cookie（与会话无关）</span>`;
    }
    return `<span class="bc-state bc-state-off">浏览器里还没有这些 Cookie</span>`;
  })();

  const mismatchLine = (() => {
    const parts = [];

    // 最要紧的一条：后端把 Domain 写死了，那浏览器地址栏就必须是那个名字，
    // 否则登录成功也白搭 —— 浏览器会静默拒收整条 Cookie。
    const bd = backendCookieDomain();
    if (bd) {
      const here = location.hostname;
      const same = here === bd;
      parts.push(same
        ? `<div class="bc-note">后端下发的 Cookie 带 <code>Domain=${esc(bd)}</code>，当前面板也在
             <b>${esc(here)}</b>，浏览器接受没问题。</div>`
        : `<div class="bc-note bc-note-warn">⚠️ 后端下发的 Cookie 带 <code>Domain=${esc(bd)}</code>
             （服务端写死的，面板改不了）。浏览器地址栏不是 <b>${esc(bd)}</b> 时，
             <b>这条 Cookie 会被直接拒收</b> —— 表现就是「登录成功但打开系统还是请先登录」。
             请用 <code>http://${esc(bd)}:${location.port || 8080}</code> 打开面板和业务系统。</div>`);
    }

    if (!hostNote) return parts.join('');

    if (hostNote.kind === 'info') {
      // 写入时会自动桥到另一个回环名，两边都有 —— 这不是警告，是能力说明
      const pair = hostNote.panelHost === 'localhost' ? '127.0.0.1' : 'localhost';
      // 兜底换过名：这里说的 targetHost 是「真正连上的那个」，得点明它不是配置里填的
      const via = hostNote.askedHost && hostNote.askedHost !== hostNote.targetHost
        ? `<div class="bc-note">（配置里填的是 <code>${esc(hostNote.askedHost)}</code>，该地址上没有服务在听，
             已自动改连 <b>${esc(hostNote.targetHost)}</b>。Cookie 只按真实连通的主机名算，
             所以下面说的也是 ${esc(hostNote.targetHost)}。）</div>`
        : '';
      parts.push(via);
      parts.push(`<div class="bc-note">写入时会同时落到 <b>${esc(hostNote.panelHost)}</b> 和 <b>${esc(pair)}</b> 两个主机名上 ——
        两个地址直连业务页面都是登录态。（浏览器把这两个当成不同站点，Cookie 不互通，
        所以必须两边各写一次。）</div>`);
      return parts.join('');
    }
    parts.push(`<div class="bc-note bc-note-warn">面板在 <b>${esc(hostNote.panelHost)}</b>，后端是 <b>${esc(hostNote.targetHost)}</b>。
        浏览器把这两个当成不同站点，Cookie 不通用 —— 写进去只会落在 ${esc(hostNote.panelHost)} 上，
        对后端不生效。请把面板也用 <code>${esc(hostNote.targetHost)}</code> 这个主机名打开。</div>`);
    return parts.join('');
  })();

  return `
    <div class="bc-block">
      <div class="bc-head">
        <span class="k">浏览器 Cookie</span>
        <div class="bc-ops">
          ${session.cookies.length
            ? '<button class="btn btn-mini btn-accent" id="writeBrowserCookieBtn">写入浏览器</button>'
            : ''}
          ${written.length || inJar
            ? '<button class="btn btn-mini btn-ghost" id="clearBrowserCookieBtn">清除</button>'
            : ''}
        </div>
      </div>
      ${stateLine}
      ${mismatchLine}
      <div class="bc-note">DevTools → Application → Cookies → <b>${esc(location.origin)}</b> 里能看到${
        otherHost() ? `（另一个主机名 <b>${esc(otherHost())}</b> 上也有）` : ''
      }。
        HttpOnly 的项 JS 读不到属正常，服务端已确认收到。</div>
    </div>
  `;
}

/** 把「账号剩余尝试次数」画成一条警戒条，贴在会话卡片里 */
function renderLockGuard() {
  const host = $('#lockGuard');
  if (!host) return;
  const names = Object.keys(lockGuard.remaining);
  if (!names.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = names.map((u) => {
    const n = lockGuard.remaining[u];
    const actions = `<div class="lockbar-actions">
      <button class="btn btn-mini" data-use-cookie="1">改用导入 Cookie</button>
      <button class="btn btn-mini btn-ghost" data-clear-lock="${esc(u)}">我已解锁，清除提示</button>
    </div>`;
    const wrap = (cls, text) =>
      `<div class="lockbar ${cls}"><div class="lockbar-text">${text}</div>${actions}</div>`;
    if (n <= 0) {
      // 已被后端拒绝（锁定 / 禁用 / 密码过期），不再是「还剩 N 次」的口吻
      const why = lockGuard.reason[u] || '账号已被锁定或禁用';
      return wrap('lockbar-danger',
        `<strong>🚫 ${esc(u)} 已被后端拒绝登录</strong>　${esc(why)}。<br>` +
        `继续重试不会成功，还可能让锁定时间重新计时。建议绕过登录接口直接导入 Cookie。`);
    }
    const danger = n <= 1;
    return wrap(danger ? 'lockbar-danger' : 'lockbar-warn',
      `<strong>${danger ? '⚠️' : 'ℹ️'} ${esc(u)}</strong>　` +
      `服务端提示还剩 <b>${n}</b> 次尝试机会${n <= 1 ? '，再错一次即锁定' : ''}。` +
      `建议改用「导入 Cookie」绕过登录接口。`);
  }).join('');
  host.querySelectorAll('[data-clear-lock]').forEach((b) =>
    b.addEventListener('click', () => {
      lockGuard.clear(b.dataset.clearLock);
      renderAll();
      toast('已清除锁定提示', 'ok');
    })
  );
  host.querySelectorAll('[data-use-cookie]').forEach((b) =>
    b.addEventListener('click', () => {
      // 复用顶栏那个「导入 Cookie」按钮的完整逻辑（含 textarea 替换）
      const src = $('#importCookieBtn');
      if (src) src.click();
    })
  );
}

function renderAll() {
  $('#targetInput').value = state.target || '';
  renderAccounts();
  renderTenants();
  renderCombos();
  renderSession();
  renderLockGuard();
  fillSettingsForm();
}

/* ============================ 配置表单双向绑定 ============================ */

function getBind(path) {
  return pickPath(state, path);
}
function setBind(path, value) {
  const keys = String(path).split('.');
  let cur = state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function fillSettingsForm() {
  $$('[data-bind]').forEach((el) => {
    const v = getBind(el.dataset.bind);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v === undefined || v === null ? '' : v;
  });
  $('#rawJson').value = JSON.stringify(state, null, 2);
}

function bindSettingsForm() {
  $$('[data-bind]').forEach((el) => {
    el.addEventListener('change', async () => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') v = Number(el.value) || 0;
      else v = el.value;
      setBind(el.dataset.bind, v);
      try {
        await saveState();
        $('#rawJson').value = JSON.stringify(state, null, 2);
        renderAll();
        toast('已保存', 'ok');
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  });
}

/* ============================ 弹窗表单 ============================ */

let formOnOk = null;

/** 可搜索下拉最多渲染多少条。584 个租户全画出来没必要，也没人滚得到第 200 条以后 */
const SS_LIMIT = 120;

/** 和租户列表筛选同一套规则：小写化、空格分隔多关键词取交集 */
function matchOptions(options, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return options;
  const words = kw.split(/\s+/).filter(Boolean);
  return options.filter((o) => {
    const hay = (String(o.label || '') + ' ' + String(o.value || '')).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * 把 [data-f] 隐藏域 + 可见搜索框绑定成一个可搜索下拉。
 * 值存在隐藏域里，所以 openForm 收集字段值的逻辑完全不用改。
 */
function bindSearchSelect(ss, field) {
  const input = ss.querySelector('.ss-input');
  const hidden = ss.querySelector('[data-f]');
  const list = ss.querySelector('.ss-list');
  const options = field.options || [];
  let rows = [];
  let active = -1;

  const labelOf = (val) => (options.find((o) => String(o.value) === String(val)) || {}).label || '';
  const close = () => { list.hidden = true; active = -1; };

  // 584 个租户 ID 绝大多数是 4028e52e979c62cc0197… 开头，能区分的只有末尾几位。
  // 整串摆出来既占掉一半宽度、又把最长的租户名挤成省略号，而且一眼扫过去每行都一样。
  //
  // 注意别用「全体最长公共前缀」来决定砍多少：真实数据里混进了个别格式完全不同的 ID
  // （有一条 9 位的，第一个字符就和别人不一样），一条离群数据就能把公共前缀压成空字符串，
  // 于是所有行又退回显示完整的 32 位。改成按行裁剪——只把「去掉公共前缀后」的尾巴留下，
  // 而公共前缀只统计长度够长的那些 ID。
  const prefixLen = (() => {
    const vals = options.map((o) => String(o.value || '')).filter((v) => v.length >= 16);
    if (vals.length < 2) return 0;
    let p = vals[0];
    for (const v of vals) {
      let i = 0;
      while (i < p.length && i < v.length && p[i] === v[i]) i++;
      p = p.slice(0, i);
      if (!p) break;
    }
    // 留一点余量，别把整串都当成前缀
    return p.length >= 12 ? p.length : 0;
  })();

  /** 只取 ID 有区分度的尾部；尾 8 位在这批真实数据里 584 条全唯一 */
  const subOf = (val) => {
    const v = String(val || '');
    if (!v) return '';
    if (prefixLen && v.length > prefixLen + 4) return '…' + v.slice(-8);
    return v.length > 10 ? '…' + v.slice(-8) : v;
  };

  const paintActive = () => {
    list.querySelectorAll('.ss-opt').forEach((el, i) => el.classList.toggle('active', i === active));
    list.querySelector('.ss-opt.active')?.scrollIntoView({ block: 'nearest' });
  };

  const render = (kw) => {
    const shown = matchOptions(options, kw);
    rows = shown.slice(0, SS_LIMIT);
    if (!shown.length) {
      list.innerHTML = `<div class="ss-empty">没有匹配「${esc(String(kw).trim())}」的项</div>`;
    } else {
      list.innerHTML = rows.map((o) => `
        <div class="ss-opt ${String(o.value) === String(hidden.value) ? 'sel' : ''}"
          title="${esc(o.label)}${o.value ? ' · ' + esc(String(o.value)) : ''}">
          <span class="ss-opt-label">${esc(o.label)}</span>
          ${o.value ? `<span class="ss-opt-sub">${esc(subOf(o.value))}</span>` : ''}
        </div>`).join('')
        + (shown.length > rows.length
          ? `<div class="ss-more">还有 ${shown.length - rows.length} 条，继续输入可缩小范围</div>` : '');
    }
    active = -1;
    list.hidden = false;
  };

  const choose = (i) => {
    const o = rows[i];
    if (!o) return;
    hidden.value = o.value;
    input.value = o.label;
    close();
    input.blur();
  };

  // mousedown 拦掉，否则点击选项前 input 先失焦、列表被关掉，click 永远收不到
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const el = e.target.closest('.ss-opt');
    if (!el) return;
    // 用 DOM 里的顺序算下标，别用 rows.indexOf：
    // 列表尾部还可能挂着 .ss-more / .ss-empty，混在一起容易错位
    const opts = Array.from(list.querySelectorAll('.ss-opt'));
    choose(opts.indexOf(el));
  });

  input.addEventListener('focus', () => {
    input.select();       // 选中当前文字，一打字就整体替换
    render('');
  });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur', () => {
    close();
    input.value = labelOf(hidden.value);   // 没选就走人，把显示还原成已选值
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return render('');
      if (!rows.length) return;
      active = e.key === 'ArrowDown'
        ? (active + 1) % rows.length
        : (active - 1 + rows.length) % rows.length;
      return paintActive();
    }
    if (e.key === 'Enter' && !list.hidden) {
      e.preventDefault();
      // 有高亮就选高亮的；只有一条命中时直接回车选中；多条又没高亮则不猜，免得选错
      if (active >= 0) choose(active);
      else if (rows.length === 1) choose(0);
      return;
    }
    if (e.key === 'Escape' && !list.hidden) {
      // 先收下拉，别让 Esc 直接冒泡去关整个弹窗
      e.stopPropagation();
      close();
      input.blur();
    }
  });
}

function openForm(title, fields, values, onOk) {
  $('#formTitle').textContent = title;
  $('#formBody').innerHTML = fields.map((f) => {
    const v = values[f.key] ?? f.default ?? '';
    if (f.type === 'select') {
      return `<div class="field"><label>${esc(f.label)}</label>
        <select data-f="${f.key}">
          ${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></div>`;
    }
    if (f.type === 'search-select') {
      const cur = f.options.find((o) => String(o.value) === String(v)) || { value: '', label: '' };
      return `<div class="field"><label>${esc(f.label)}${f.hint ? ` <em>${esc(f.hint)}</em>` : ''}</label>
        <div class="ss" data-ss="${f.key}">
          <input class="ss-input" type="text" autocomplete="off" spellcheck="false"
            value="${esc(cur.label)}" placeholder="${esc(f.placeholder || '点击或输入以搜索')}">
          <input type="hidden" data-f="${f.key}" value="${esc(cur.value)}">
          <div class="ss-list" hidden></div>
        </div></div>`;
    }
    return `<div class="field"><label>${esc(f.label)}${f.hint ? ` <em>${esc(f.hint)}</em>` : ''}</label>
      <input data-f="${f.key}" type="${f.type || 'text'}" value="${esc(v)}" spellcheck="false"
        placeholder="${esc(f.placeholder || '')}"></div>`;
  }).join('');
  fields.filter((f) => f.type === 'search-select').forEach((f) => {
    const ss = $(`#formBody .ss[data-ss="${f.key}"]`);
    if (ss) bindSearchSelect(ss, f);
  });
  formOnOk = () => {
    const out = {};
    $$('[data-f]', $('#formBody')).forEach((el) => { out[el.dataset.f] = el.value; });
    return onOk(out);
  };
  // 带可搜索下拉的表单选项名字都很长，弹窗给宽一点
  $('#formModal').classList.toggle('modal-wide', fields.some((f) => f.type === 'search-select'));
  $('#formMask').hidden = false;
  $('#formModal').hidden = false;
  const first = $('#formBody input, #formBody select');
  first?.focus();
}

function closeForm() {
  $('#formMask').hidden = true;
  $('#formModal').hidden = true;
  $('#formModal').classList.remove('modal-wide');
  formOnOk = null;
}

function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8);
}

function openAccountForm(acc) {
  const editing = !!acc;
  openForm(
    editing ? '编辑账号' : '新增账号',
    [
      { key: 'name', label: '显示名', placeholder: '管理员' },
      { key: 'username', label: '用户名', placeholder: 'admin' },
      { key: 'password', label: '密码', placeholder: '123456' },
      { key: 'note', label: '备注', placeholder: '可选' },
    ],
    acc || {},
    async (out) => {
      if (!out.username.trim()) return toast('用户名不能为空', 'err');
      if (editing) Object.assign(acc, out);
      else state.accounts.push({ id: uid('acc'), ...out });
      await saveState();
      closeForm();
      renderAll();
      toast(editing ? '已更新账号' : '已新增账号', 'ok');
    }
  );
}

function openTenantForm(ten) {
  const editing = !!ten;
  openForm(
    editing ? '编辑租户' : '新增租户',
    [
      { key: 'name', label: '租户名称', placeholder: '演示租户' },
      { key: 'id', label: '租户 ID', placeholder: 't_demo', hint: '传给后端的主键' },
      { key: 'code', label: '租户 Code', placeholder: 'demo', hint: '可选' },
    ],
    ten || {},
    async (out) => {
      if (!out.id.trim()) return toast('租户 ID 不能为空', 'err');
      if (editing) Object.assign(ten, out);
      else state.tenants.push({ ...out });
      await saveState();
      closeForm();
      renderAll();
      toast(editing ? '已更新租户' : '已新增租户', 'ok');
    }
  );
}

function openComboForm(combo) {
  const editing = !!combo;
  const accOpts = state.accounts.map((a) => ({ value: a.id, label: a.name || a.username }));
  const tenOpts = [{ value: '', label: '（不指定租户）' }]
    .concat(state.tenants.map((t) => ({ value: String(t.id), label: t.name || t.id })));
  if (!accOpts.length) return toast('请先添加账号', 'err');

  openForm(
    editing ? '编辑组合' : '新建组合',
    [
      { key: 'name', label: '组合名称', placeholder: '管理员 @ 演示租户' },
      { key: 'accountId', label: '账号', type: 'select', options: accOpts },
      { key: 'tenantId', label: '租户', type: 'search-select', options: tenOpts,
        placeholder: '输入租户名或 ID 搜索（如「哈密」「分公司」）' },
      { key: 'hotkey', label: '标签文字', placeholder: '如：主流程 / 只读' },
    ],
    combo || { accountId: accOpts[0].value, tenantId: tenOpts[0].value },
    async (out) => {
      const name = out.name.trim() || '未命名组合';
      if (editing) Object.assign(combo, { ...out, name });
      else state.combos.push({ id: uid('combo'), ...out, name });
      await saveState();
      closeForm();
      renderCombos();
      toast(editing ? '已更新组合' : '已新建组合', 'ok');
    }
  );
}

/* ============================ 拉取租户列表 ============================ */

async function pullTenants() {
  if (!state.tenantList?.enabled) {
    toast('请先在配置 → 租户列表 中启用并填写接口', 'err');
    return;
  }
  const btn = $('#pullTenantsBtn');
  btn.disabled = true;
  try {
    const res = await proxy(state.tenantList.method || 'GET', state.tenantList.path, {
      headers: buildHeaders({ token: session.token, tenantId: session.tenantId }),
      timeoutMs: state.requestTimeoutMs,
    });
    if (!res.ok) throw new Error(res.error || `HTTP ${res.status}`);
    if (!res.json) throw new Error('返回内容不是 JSON');

    // T302「请先登录」这类响应 HTTP 也是 200，必须先按 retCode 拦下来
    if (!isBizOk(res, state.tenantList)) {
      const detail = bizError(res, `HTTP ${res.status}`);
      throw new Error('拉取租户失败：' + detail);
    }

    let list = state.tenantList.listPath ? pickPath(res.json, state.tenantList.listPath) : res.json;
    if (!Array.isArray(list)) {
      // 兜底找第一个数组
      const found = Object.values(res.json).find(Array.isArray);
      if (!found) throw new Error('未找到租户数组，请调整「列表所在路径」');
      list = found;
    }

    const idF = state.tenantList.idField || 'id';
    const nameF = state.tenantList.nameField || 'name';
    const mapped = list.map((it) => ({
      id: String(pickPath(it, idF) ?? it.id ?? ''),
      name: String(pickPath(it, nameF) ?? pickPath(it, 'name') ?? ''),
      code: String(pickPath(it, 'code') ?? pickPath(it, 'tenantCode') ?? ''),
    })).filter((x) => x.id);

    if (!mapped.length) throw new Error('解析出的租户为空');
    state.tenants = mapped;
    await saveState();
    renderTenants();
    toast(`已拉取 ${mapped.length} 个租户`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ============================ 请求调试 ============================ */

function toCurl(method, url, headers, body) {
  const parts = [`curl -i -X ${method} '${url}'`];
  for (const [k, v] of Object.entries(headers)) {
    parts.push(`  -H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (body) parts.push(`  --data-raw '${String(body).replace(/'/g, "'\\''")}'`);
  return parts.join(' \\\n');
}

async function sendRequest() {
  const method = $('#reqMethod').value;
  const path = $('#reqPath').value.trim();
  if (!path) return toast('请填写请求路径', 'err');

  const withAuth = $('#withAuth').checked;
  const withTenant = $('#withTenant').checked;
  const rawBody = $('#reqBody').value.trim();

  let body;
  if (rawBody && !['GET', 'HEAD'].includes(method)) {
    try {
      body = JSON.stringify(JSON.parse(rawBody)); // 校验
    } catch (e) {
      return toast('请求体不是合法 JSON', 'err');
    }
  }

  const headers = buildHeaders({
    token: session.token,
    tenantId: session.tenantId,
    includeAuth: withAuth,
    includeTenant: withTenant,
  });
  if (body) headers['Content-Type'] = 'application/json';

  const btn = $('#sendBtn');
  btn.disabled = true;
  btn.textContent = '发送中…';

  try {
    const res = await proxy(method, path, { body, headers, timeoutMs: state.requestTimeoutMs });
    $('#respPanel').hidden = false;

    if (!res.ok) {
      $('#respStatus').className = 'status-badge bad';
      $('#respStatus').textContent = 'ERR';
      $('#respMeta').textContent = res.error || '';
      lastResp = {
        text: res.error || '请求失败',
        headers: {},
        curl: toCurl(method, res.url || path, headers, body),
      };
      renderResp();
      return;
    }

    if (state.login?.saveCookies && method !== 'GET') mergeCookies(res.cookies);

    $('#respStatus').className = 'status-badge ' + (res.status < 400 ? 'ok' : 'bad');
    $('#respStatus').textContent = res.status + (res.statusText ? ' ' + res.statusText : '');
    $('#respMeta').textContent = `${res.durationMs}ms · ${res.bytes}B`;

    lastResp = {
      text: res.json !== undefined ? JSON.stringify(res.json, null, 2) : res.text,
      headers: res.headers || {},
      curl: toCurl(method, res.url || path, headers, body),
    };
    renderResp();
    renderSession();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '发送';
  }
}

function renderResp() {
  const pre = $('#respPre');
  if (activeRespTab === 'body') pre.textContent = lastResp.text || '（空响应）';
  else if (activeRespTab === 'headers') pre.textContent = JSON.stringify(lastResp.headers, null, 2);
  else pre.textContent = lastResp.curl || '';
}

/* ============================ 事件绑定 ============================ */

function bindEvents() {
  // 后端地址
  const targetInput = $('#targetInput');
  targetInput.addEventListener('change', async () => {
    state.target = targetInput.value.trim();
    await saveState();
    toast('后端地址已保存', 'ok');
  });

  // 检测
  const ping = async () => {
    renderPing('wait', '检测中…');
    try {
      const r = await fetch('/api/ping?target=' + encodeURIComponent(state.target));
      const j = await r.json();

      // 探测结果同样要落到 backendRoute 上：用户点「检测」看到的结论，
      // 必须和随后真正发请求时用的通道一致
      if (j.reachable) noteBackendRoute(j);

      // 只要能收到 HTTP 响应就算「后端活着」——根路径 404 是正常的（业务都在 context-path 下）
      if (j.reachable) {
        const tag = j.status && j.status < 400 ? '' : ' (根路径无内容，属正常)';
        // 走了兜底就把这件事说在脸上：填 127 却连的是 localhost 属于
        // 「能用但跟你想的不一样」，必须让用户知道
        const via = j.hostSwitched ? ` · 经 ${j.host} 连通` : '';
        renderPing(
          'ok',
          `在线 ${j.status || ''} · ${j.durationMs}ms${via}${tag}`,
          j.hostSwitched
            ? `你填的是 ${j.askedHost}，该地址上没有服务；已自动改用 ${j.host} 连上。\n真正的后端基址：${j.resolvedBase}`
            : ''
        );
      } else {
        const tried = Array.isArray(j.tried) && j.tried.length > 1 ? `（已试 ${j.tried.join(' / ')}）` : '';
        renderPing('bad', (j.error || '不可达') + tried, Array.isArray(j.tried) ? `尝试过：${j.tried.join('、')}` : '');
      }
    } catch (e) {
      renderPing('bad', '检测失败');
    }
  };
  $('#pingBtn').addEventListener('click', ping);
  ping(); // 打开页面就自动探一次，省得还要手点

  // 新增按钮
  $$('[data-add]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.add === 'account') openAccountForm(null);
      else if (b.dataset.add === 'tenant') openTenantForm(null);
      else if (b.dataset.add === 'combo') openComboForm(null);
    });
  });

  $('#pullTenantsBtn').addEventListener('click', pullTenants);

  // 租户筛选：输入即过滤。只重画列表，不调 renderAll()，
  // 否则整个侧栏重建会把输入框的焦点和光标位置弄丢。
  //
  // 用 rAF 合并同一帧内的多次按键：584 条租户全量渲染约 45ms，
  // 手速快时逐个 keydown 直接同步渲染会排长队，观感就是打字卡顿。
  const tenantFilter = $('#tenantFilter');
  if (tenantFilter) {
    let queued = 0;
    const queueRender = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; renderTenants(); });
    };
    tenantFilter.addEventListener('input', queueRender);
    // Esc 一键清空，Ctrl/Cmd+F 之外多一条退路
    tenantFilter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        tenantFilter.value = '';
        renderTenants();
      }
    });
  }

  // 列表滚动时同步底部渐隐
  const tenantBox = $('#tenantList');
  if (tenantBox) {
    tenantBox.addEventListener('scroll', () => syncScrollFade(tenantBox), { passive: true });
    syncScrollFade(tenantBox);
  }

  // 会话操作
  $('#copyTokenBtn').addEventListener('click', async () => {
    if (!session.token) return toast('当前没有 Token', 'err');
    await navigator.clipboard.writeText(session.token);
    toast('Token 已复制', 'ok');
  });
  $('#copyCurlBtn').addEventListener('click', async () => {
    const h = buildHeaders({ token: session.token, tenantId: session.tenantId });
    const url = (state.target || '').replace(/\/+$/, '') + ($('#reqPath').value.trim() || '/');
    await navigator.clipboard.writeText(toCurl($('#reqMethod').value, url, h, $('#reqBody').value.trim()));
    toast('curl 已复制', 'ok');
  });
  $('#importCookieBtn').addEventListener('click', () => {
    openForm(
      '导入浏览器 Cookie',
      [
        {
          key: 'cookie',
          label: 'Cookie',
          placeholder: 'Authorization=eyJhbGciOi...; other=xxx',
          hint: '从 DevTools → Network 里复制 Cookie 头，或 Application → Cookies 里复制',
        },
      ],
      {},
      async (out) => {
        try {
          const r = await importCookie(out.cookie);
          closeForm();
          renderAll();
          toast(`已导入 ${r.count} 个 Cookie：${r.names.join(', ')}`, 'ok');
          if (!r.token) {
            toast('Cookie 里没找到 Authorization，若接口需要 Token 请手动填到配置里', 'warn');
          }
          // 导入的 Cookie 同样自动落地，否则业务页面还是未登录
          autoSyncBrowserCookies().then((s) => {
            if (!s) return;
            renderAll();
            if (s.ok !== false) toast(`已同步到浏览器（${location.hostname}${s.bridged?.ok ? ' / ' + s.bridged.host : ''}）`, 'ok');
          });
        } catch (e) {
          toast(e.message, 'err');
        }
      }
    );
    // Cookie 是一长串，用 textarea 更方便
    const input = $('#formBody input[data-f="cookie"]');
    if (input) {
      const ta = document.createElement('textarea');
      ta.dataset.f = 'cookie';
      ta.rows = 5;
      ta.spellcheck = false;
      ta.placeholder = 'Authorization=eyJhbGciOi...; other=xxx';
      input.replaceWith(ta);
      ta.focus();
    }
  });

  $('#clearSessionBtn').addEventListener('click', () => {
    session = { token: '', cookies: [], accountId: null, tenantId: null, comboId: null, loginAt: null };
    $('#respPanel').hidden = true;
    renderAll();
    toast('会话已清空');
  });

  // 配置抽屉
  const openSettings = () => {
    $('#settingsMask').hidden = false;
    $('#settingsPanel').hidden = false;
    fillSettingsForm();
  };
  const closeSettings = () => {
    $('#settingsMask').hidden = true;
    $('#settingsPanel').hidden = true;
  };
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#settingsMask').addEventListener('click', closeSettings);

  $$('#settingsNav .tab').forEach((t) => {
    t.addEventListener('click', () => {
      activeSettingsSec = t.dataset.sec;
      $$('#settingsNav .tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.sec').forEach((s) => { s.hidden = s.dataset.sec !== activeSettingsSec; });
    });
  });

  $('#applyRawBtn').addEventListener('click', async () => {
    try {
      const next = JSON.parse($('#rawJson').value);
      state = next;
      await saveState();
      renderAll();
      toast('配置已应用', 'ok');
    } catch (e) {
      toast('JSON 解析失败：' + e.message, 'err');
    }
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dev-switch-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('配置已导出', 'ok');
  });

  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('恢复默认配置？当前账号 / 租户 / 组合都会丢失。')) return;
    const r = await fetch('/api/state', { method: 'DELETE' });
    const j = await r.json();
    state = j.state;
    await loadState();
    renderAll();
    toast('已恢复默认', 'ok');
  });

  // 弹窗
  $('#formCancel').addEventListener('click', closeForm);
  $('#formMask').addEventListener('click', closeForm);
  $('#formOk').addEventListener('click', async () => {
    if (!formOnOk) return;
    try {
      await formOnOk();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#formModal').hidden) closeForm();
      else if (!$('#settingsPanel').hidden) closeSettings();
    }
    // Ctrl/Cmd + Enter 发送请求
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#reqPath').disabled) {
      const active = document.activeElement;
      if (active && (active.id === 'reqBody' || active.id === 'reqPath')) sendRequest();
    }
  });

  // 请求调试
  $('#sendBtn').addEventListener('click', sendRequest);
  $$('.resp-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      activeRespTab = t.dataset.tab;
      $$('.resp-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      renderResp();
    });
  });
}

/* ============================ 启动 ============================ */

(async function init() {
  try {
    await loadState();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">无法连接本地服务：${esc(e.message)}<br>请确认 server.js 已启动。</div>`;
    return;
  }
  bindEvents();
  bindSettingsForm();
  // 先问一次浏览器 Cookie 罐里现在有什么，会话卡片才能显示真实的写入状态
  await refreshBrowserCookieJar();
  renderAll();
})();
