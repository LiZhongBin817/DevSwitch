#!/usr/bin/env node
'use strict';

/**
 * 假后端：一比一模仿 tsie-framework / BaseResp 协议，用来端到端验证 dev-switch。
 *   node .e2e/tsie-mock.js  → 默认 8082
 *
 * 刻意复刻的 4 个「坑」：
 *  1. 业务失败也返回 HTTP 200，成败只看 body 的 retCode
 *  2. JWT 通过 Set-Cookie: Authorization 下发，响应体里没有 accessToken
 *  3. 切租户失败也返回 retCode=T200（DefaultTenantSwitchHandler.failSwitch 用 success 构造），原因只在 retMsg
 *  4. 路径带 context-path：/pds-std/api/xxx
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8082);
const PREFIX = '/pds-std/api';

const USER = { username: 'e2e', password: 'pass1234' };
// 专门用来复刻「T401 请联系项目组成员」的账号：
// 框架里 CredentialsExpired / Disabled / Locked 三种异常共用这一句 retMsg，
// 真实原因只放在 data 字段里，所以必须原样模仿出来才能验证诊断能力。
const LOCKED_USER = { username: 'locked', password: 'whatever' };
const TENANTS = [
  { tenantId: 'T_DEMO', name: '演示租户' },
  { tenantId: 'T_ALPHA', name: '阿尔法科技' },
  // 下面几个用于验证筛选：名称中英文混合、含相似前缀、含可搜的中文关键词
  { tenantId: 'T_BETA', name: '贝塔新能源有限公司' },
  { tenantId: 'T_GAMMA', name: '伽马光伏发电有限公司' },
  { tenantId: 'T_DELTA', name: '德尔塔风力发电有限公司' },
  { tenantId: 'T_ALPHA2', name: '阿尔法新能源分公司' },
  { tenantId: 'T_FOO', name: 'Foo Energy Co.' },
];
const ALLOWED = new Set(['T_DEMO', 'T_ALPHA']);

const sessions = new Map(); // jwt -> { username, tenantId }

function send(res, obj, cookies = []) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(200, headers); // 永远 HTTP 200 —— 这是关键
  res.end(body);
}

const ok = (data = {}, msg = '成功') => ({ retCode: 'T200', retMsg: msg, data });
const needLogin = () => ({ retCode: 'T302', retMsg: '请先登录', data: null });

function readBody(req) {
  return new Promise((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });
}

/** 从 Cookie 头里取 Authorization —— 框架默认 TokenOperateMode.Cookie */
function tokenOf(req) {
  const raw = req.headers.cookie || '';
  for (const seg of raw.split(/;\s*/)) {
    const i = seg.indexOf('=');
    if (i > 0 && seg.slice(0, i).trim() === 'Authorization') return seg.slice(i + 1).trim();
  }
  return '';
}

function parseForm(s) {
  const o = {};
  for (const kv of String(s || '').split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    o[k] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
  }
  return o;
}

let failCount = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const raw = await readBody(req);
  console.log(`${req.method} ${p}${raw ? ' ' + raw.slice(0, 80) : ''}`);

  if (p === `${PREFIX}/login` && req.method === 'POST') {
    // 支持 JSON 与 form 两种提交
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = parseForm(raw); }

    // 复刻「锁定/禁用/密码过期」：retMsg 是笼统文案，真实异常名只在 data 里
    if (body.username === LOCKED_USER.username) {
      return send(res, {
        retCode: 'T401',
        retMsg: '请联系项目组成员',
        data: 'org.springframework.security.authentication.LockedException: 用户锁定',
      });
    }

    if (body.username !== USER.username || body.password !== USER.password) {
      failCount += 1;
      const left = Math.max(0, 3 - failCount);
      return send(res, {
        retCode: 'T401',
        retMsg: left > 0
          ? `账户名或者密码输入错误，再尝试错误 ${left} 次用户将被锁定!`
          : '账户名或者密码输入错误，账户已被锁定!',
        // 框架的 CustomBadCredentialsException 分支也会把异常塞进 data
        data: 'org.springframework.security.authentication.BadCredentialsException: 用户名或密码错误',
      });
    }
    failCount = 0;
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(USER.username + ':' + Date.now()).toString('base64url') + '.sig';
    sessions.set(jwt, { username: USER.username, tenantId: TENANTS[0].tenantId });
    return send(res, ok({ userName: '端到端测试' }, '登录成功'), [
      `Authorization=${jwt}; Path=/; HttpOnly`,
    ]);
  }

  // 租户列表
  if (p === `${PREFIX}/pf/tenant/all` && req.method === 'GET') {
    const s = sessions.get(tokenOf(req));
    if (!s) return send(res, needLogin());
    return send(res, ok(TENANTS));
  }

  // 切租户 —— 注意：失败也返回 T200
  if (p === `${PREFIX}/switchTenant` && req.method === 'POST') {
    const s = sessions.get(tokenOf(req));
    if (!s) return send(res, needLogin());
    const { tenantId } = parseForm(raw);
    if (!tenantId) return send(res, ok({}, '切换租户失败：租户ID不能为空'));
    if (!ALLOWED.has(tenantId)) return send(res, ok({}, `切换租户失败：无权限访问租户 ${tenantId}`));
    s.tenantId = tenantId;
    return send(res, ok({ tenantId }, '切换成功'), [
      `Authorization=${tokenOf(req)}; Path=/; HttpOnly`,
    ]);
  }

  // 当前用户（页面默认的「请求测试」路径）
  if (p === `${PREFIX}/pf/user/current` && req.method === 'GET') {
    const s = sessions.get(tokenOf(req));
    if (!s) return send(res, needLogin());
    const t = TENANTS.find((x) => x.tenantId === s.tenantId) || null;
    return send(res, ok({ username: s.username, tenant: t }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, process.env.MOCK_HOST || '127.0.0.1', () => {
  console.log(`假 tsie 后端已启动 http://${process.env.MOCK_HOST || '127.0.0.1'}:${PORT}${PREFIX}`);
  console.log(`账号 ${USER.username} / ${USER.password}`);
});
