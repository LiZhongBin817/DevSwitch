#!/usr/bin/env node
'use strict';

/**
 * 模拟后端服务（仅用于试用 / 自测 DevSwitch）
 *   node mock-backend.js        → 默认 8080
 *
 * 提供：
 *   POST /api/auth/login             用户名密码登录，返回 { code, data: { accessToken } }
 *   GET  /api/tenant/list            当前用户可访问的租户
 *   POST /api/auth/switch-tenant     切换租户（校验 token + tenantId）
 *   GET  /api/user/current           返回当前用户 + 当前租户
 *   GET  /api/order/list             演示业务数据，按租户隔离
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8081);
const users = [
  { username: 'admin', password: '123456', name: '张管理', role: 'OWNER', tenants: ['t_demo', 't_alpha', 't_beta'] },
  { username: 'dev', password: '123456', name: '李开发', role: 'MEMBER', tenants: ['t_alpha'] },
];
const tenants = [
  { tenantId: 't_demo', tenantName: '演示租户', code: 'demo' },
  { tenantId: 't_alpha', tenantName: '阿尔法科技', code: 'alpha' },
  { tenantId: 't_beta', tenantName: '贝塔贸易', code: 'beta' },
];

const tokens = new Map(); // token -> { username, tenantId }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  return tokens.get(token) || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const raw = await readBody(req);
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }

  console.log(`${req.method} ${path}  tenant=${req.headers['x-tenant-id'] || '-'}`);

  if (req.method === 'OPTIONS') return send(res, 204, {});

  // 登录
  if (path === '/api/auth/login' && req.method === 'POST') {
    const u = users.find((x) => x.username === body.username && x.password === body.password);
    if (!u) return send(res, 401, { code: 401, message: '用户名或密码错误' });
    const token = 'tk_' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
    tokens.set(token, { username: u.username, tenantId: u.tenants[0] });
    return send(res, 200, {
      code: 0,
      message: 'ok',
      data: {
        accessToken: token,
        userName: u.name,
        role: u.role,
        tenantId: u.tenants[0],
        expiresIn: 7200,
      },
    });
  }

  // 租户列表
  if (path === '/api/tenant/list' && req.method === 'GET') {
    const s = auth(req);
    if (!s) return send(res, 401, { code: 401, message: '未登录或 token 无效' });
    const u = users.find((x) => x.username === s.username);
    return send(res, 200, {
      code: 0,
      data: tenants.filter((t) => u.tenants.includes(t.tenantId)),
    });
  }

  // 切租户
  if (path === '/api/auth/switch-tenant' && req.method === 'POST') {
    const s = auth(req);
    if (!s) return send(res, 401, { code: 401, message: '未登录' });
    const u = users.find((x) => x.username === s.username);
    if (!u.tenants.includes(body.tenantId)) {
      return send(res, 403, { code: 403, message: '无权访问该租户' });
    }
    s.tenantId = body.tenantId;
    return send(res, 200, { code: 0, message: '切换成功', data: { tenantId: body.tenantId } });
  }

  // 当前用户
  if (path === '/api/user/current' && req.method === 'GET') {
    const s = auth(req);
    if (!s) return send(res, 401, { code: 401, message: '未登录' });
    const u = users.find((x) => x.username === s.username);
    const t = tenants.find((x) => x.tenantId === s.tenantId);
    return send(res, 200, {
      code: 0,
      data: {
        username: u.username,
        name: u.name,
        role: u.role,
        tenant: t || null,
        headerTenantId: req.headers['x-tenant-id'] || null,
      },
    });
  }

  // 业务数据（按租户隔离）
  if (path === '/api/order/list' && req.method === 'GET') {
    const s = auth(req);
    if (!s) return send(res, 401, { code: 401, message: '未登录' });
    const tid = req.headers['x-tenant-id'] || s.tenantId;
    const n = { t_demo: 3, t_alpha: 5, t_beta: 2 }[tid] || 0;
    return send(res, 200, {
      code: 0,
      data: {
        tenantId: tid,
        total: n,
        list: Array.from({ length: n }, (_, i) => ({
          orderNo: `${tid}-${String(i + 1).padStart(4, '0')}`,
          amount: (i + 1) * 137.5,
          status: ['PAID', 'SHIPPED', 'DONE'][i % 3],
        })),
      },
    });
  }

  if (path === '/') {
    return send(res, 200, {
      service: 'mock-backend',
      endpoints: [
        'POST /api/auth/login',
        'GET  /api/tenant/list',
        'POST /api/auth/switch-tenant',
        'GET  /api/user/current',
        'GET  /api/order/list',
      ],
      accounts: users.map((u) => ({ username: u.username, password: u.password })),
    });
  }

  send(res, 404, { code: 404, message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  模拟后端已启动: http://127.0.0.1:${PORT}`);
  console.log('  测试账号: admin / 123456   （dev / 123456）\n');
});
