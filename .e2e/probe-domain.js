#!/usr/bin/env node
'use strict';
/**
 * 对比：分别从 localhost 与 127.0.0.1 打登录接口，
 * 看后端下发的 Set-Cookie 里 Domain 属性分别是多少。
 *
 * 如果两者都写死 Domain=127.0.0.1，那结论就明确了：
 * 从 http://localhost:8080 登录，浏览器会**拒收**这个 Cookie
 * （localhost 不是 127.0.0.1 的子域），所以 localhost 上永远拿不到登录态。
 * 这才是「后端是 localhost 却还是不行」的真正原因，与我的桥无关。
 */
const fs = require('fs');
const path = require('path');

const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'state.json'), 'utf8'));
const acc = (s.accounts || [])[0];
const body = String(s.login.bodyTemplate)
  .replace(/\{\{username\}\}/g, acc.username)
  .replace(/\{\{password\}\}/g, acc.password);
const attr = (c, k) => (new RegExp(k + '=([^;]+)', 'i').exec(c) || [, '(未指定)'])[1];

async function probe(host) {
  const url = `http://${host}:8080${s.login.path}`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const sc = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  console.log(`\n=== 从 ${host} 请求 ${url} ===`);
  console.log('  HTTP', r.status);
  if (!sc.length) console.log('  Set-Cookie: (无)');
  sc.forEach((c) => {
    const name = c.split('=')[0];
    console.log(`  - ${name}: Domain=${attr(c, 'Domain')}  Path=${attr(c, 'Path')}  HttpOnly=${/HttpOnly/i.test(c)}`);
  });
}

(async () => {
  await probe('localhost');
  await probe('127.0.0.1');
})();
