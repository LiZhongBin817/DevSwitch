#!/usr/bin/env node
'use strict';
/**
 * 用真实账号打一次 /pds-std/api/login，但**全程脱敏**输出：
 * 只报告 Cookie 的名字、Path、HttpOnly、SameSite、Secure，以及值的长度，
 * 绝不打印任何 Cookie 值、token 值或响应体内容。
 *
 * 目的：确认真实登录下发的到底是不是 Authorization，Path 是不是 /。
 * 这决定了「写入浏览器」按钮能不能把真实登录态送到业务页面。
 */
const fs = require('fs');
const path = require('path');

const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'state.json'), 'utf8'));
const acc = (s.accounts || [])[0];
if (!acc) { console.log('!! 配置里没有账号'); process.exit(1); }

const url = String(s.target).replace(/\/+$/, '') + s.login.path;
const body = String(s.login.bodyTemplate)
  .replace(/\{\{username\}\}/g, acc.username)
  .replace(/\{\{password\}\}/g, acc.password);

const attr = (c, k) => (new RegExp(k + '=([^;]+)', 'i').exec(c) || [, '(未指定)'])[1];

(async () => {
  console.log('POST', url);
  console.log('账号名长度:', String(acc.username).length, '| 密码是否非空:', !!(acc.password && acc.password.length));
  console.log('');

  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  console.log('HTTP 状态:', r.status);
  console.log('Content-Type:', r.headers.get('content-type'));

  const sc = typeof r.headers.getSetCookie === 'function'
    ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);

  console.log('');
  console.log('=== Set-Cookie 条数:', sc.length, '===');
  if (!sc.length) {
    console.log('  !! 后端没有通过 Set-Cookie 下发任何 Cookie');
    console.log('  !! 这说明 token 很可能只放在响应体里（tokenSource 应改成 body/json）');
  }
  sc.forEach((c, i) => {
    const name = c.split('=')[0];
    const val = c.slice(c.indexOf('=') + 1).split(';')[0];
    console.log(`  [${i}] name="${name}" 值长度=${val.length}`);
    console.log(`       Path=${attr(c, 'Path')}  HttpOnly=${/HttpOnly/i.test(c)}  SameSite=${attr(c, 'SameSite')}  Secure=${/Secure/i.test(c)}  Domain=${attr(c, 'Domain')}`);
  });

  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  console.log('');
  if (j) {
    console.log('retCode =', JSON.stringify(j.retCode), '| retMsg =', JSON.stringify(j.retMsg || j.message || j.msg || ''));
    const tp = s.login.tokenPath || '';
    if (tp) {
      const v = tp.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
      console.log('tokenPath "' + tp + '" 取值:', v == null ? '(空)' : '长度=' + String(v).length);
    }
    const keys = Object.keys(j);
    console.log('响应体顶层字段:', keys.join(', '));
    if (j.data && typeof j.data === 'object') {
      console.log('data 字段:', Object.keys(j.data).map((k) => {
        const v = j.data[k];
        return typeof v === 'string' ? `${k}(str,${v.length})` : `${k}(${typeof v})`;
      }).join(', '));
    }
  } else {
    console.log('响应体不是 JSON，长度:', text.length);
  }
})().catch((e) => console.log('!! 请求失败:', e.message));
