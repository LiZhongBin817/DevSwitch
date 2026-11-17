#!/usr/bin/env node
'use strict';
/**
 * 完整真实链路验证（无假数据）：
 *   1. 打开真实面板 http://127.0.0.1:4599
 *   2. 用真实账号 doLogin()（走面板自己的 /api/proxy，和用户点按钮完全一样）
 *   3. 打印 session.cookies 里的 Cookie 名字与属性（脱敏，不打印值）
 *   4. 调 writeBrowserCookies()（含跨主机名桥）
 *   5. 真的导航到 localhost:8080 与 127.0.0.1:8080 的业务接口，
 *      用 requestWillBeSentExtraInfo 抓浏览器**实际发出**的 Cookie 头
 *
 * 输出里所有 Cookie/token 值一律只报长度，不报明文。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9401;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  return {
    events,
    send(method, params) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      });
    },
  };
}

async function evalJs(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.result));
  return r.result.value;
}

/** 把 Cookie 头脱敏：只留名字 + 值长度 */
function maskCookieHeader(h) {
  if (!h) return '(空)';
  return String(h)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return i > 0 ? `${s.slice(0, i)}=<${s.length - i - 1}字符>` : s;
    })
    .join('; ');
}

(async () => {
  const userDir = path.join(os.tmpdir(), 'real-login-' + Date.now());
  fs.mkdirSync(userDir, { recursive: true });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let list = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        if (list.length) break;
      } catch { /* 还没起来 */ }
    }
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const c = rpc(ws);
    await c.send('Network.enable');
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    console.log('=== 1. 打开真实面板 http://127.0.0.1:4599 ===');
    await c.send('Page.navigate', { url: 'http://127.0.0.1:4599/' });
    await sleep(1600);

    console.log('\n=== 2. 真实账号登录（走面板的 /api/proxy）===');
    const login = await evalJs(c, `(async () => {
      const acc = state.accounts[0];
      await doLogin(acc);
      return {
        ok: true,
        account: acc.username,
        cookieCount: session.cookies.length,
        tokenLen: String(session.token || '').length,
        cookies: session.cookies.map(function (raw) {
          var s = String(raw);
          var name = s.split('=')[0];
          var val = s.slice(s.indexOf('=') + 1).split(';')[0];
          var at = function (k) { var m = new RegExp(k + '=([^;]+)', 'i').exec(s); return m ? m[1] : ''; };
          return { name: name, valueLen: val.length, path: at('Path'), domain: at('Domain'),
                   httpOnly: /HttpOnly/i.test(s), sameSite: at('SameSite'), secure: /Secure/i.test(s) };
        }),
      };
    })()`);
    console.log('  账号:', login.account);
    console.log('  session.cookies 条数:', login.cookieCount, '| session.token 长度:', login.tokenLen);
    login.cookies.forEach((k) => {
      console.log(`  - ${k.name}: 值长${k.valueLen}  Path=${k.path || '(无)'}  Domain=${k.domain || '(无)'}  HttpOnly=${k.httpOnly}  SameSite=${k.sameSite || '(无)'}  Secure=${k.secure}`);
    });

    console.log('\n=== 3. 写入浏览器（含跨主机名桥）===');
    const wrote = await evalJs(c, `(async () => { return await writeBrowserCookies(); })()`);
    console.log('  本机写入主机:', wrote.host);
    console.log('  写入的 Cookie 名:', JSON.stringify(wrote.written));
    console.log('  跳过的:', JSON.stringify(wrote.skipped || []));
    console.log('  HttpOnly 复刻:', JSON.stringify(wrote.httpOnly || []));
    if (wrote.bridged) {
      console.log('  桥到:', wrote.bridged.host, '| ok=', wrote.bridged.ok,
        '| 写入:', JSON.stringify(wrote.bridged.written || []),
        wrote.bridged.error ? '| 错误: ' + wrote.bridged.error : '');
    }

    await sleep(600);
    const jar = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.name === 'Authorization' || k.name === 'JSESSIONID')
      .map((k) => ({ name: k.name, domain: k.domain, path: k.path, sameSite: k.sameSite, secure: k.secure, httpOnly: k.httpOnly }));
    console.log('\n  浏览器罐里（只列我们关心的名字）:');
    jar.forEach((k) => console.log(`  - ${k.name}: domain=${k.domain} path=${k.path} sameSite=${k.sameSite} secure=${k.secure} httpOnly=${k.httpOnly}`));

    console.log('\n=== 4. 真的导航到业务接口，抓实际发出的 Cookie ===');
    for (const host of ['localhost', '127.0.0.1']) {
      c.events.length = 0;
      await c.send('Page.navigate', { url: `http://${host}:8080/pds-std/api/pf/tenant/all` });
      await sleep(2000);
      const extra = c.events.filter((e) => e.method === 'Network.requestWillBeSentExtraInfo');
      const plain = c.events.filter((e) => e.method === 'Network.requestWillBeSent');
      const pick = (h) => h?.Cookie || h?.cookie || '';
      const real = extra.map((e) => pick(e.params.headers)).find(Boolean) || '';
      const stripped = plain.map((e) => pick(e.params.request.headers)).find(Boolean) || '';
      console.log(`\n  → http://${host}:8080/pds-std/api/pf/tenant/all`);
      console.log('     ExtraInfo(真实发出):', maskCookieHeader(real));
      console.log('     requestWillBeSent(常被剥离):', maskCookieHeader(stripped));
      const hasAuth = /(^|;\s*)Authorization=/.test(real);
      const hasSession = /(^|;\s*)JSESSIONID=/.test(real);
      console.log('     带 Authorization:', hasAuth ? '✅' : '❌', '| 带 JSESSIONID:', hasSession ? '✅' : '❌');

      // 再看接口返回，判断是不是真的登录态
      const resp = c.events.filter((e) => e.method === 'Network.responseReceived'
        && /\/api\/pf\/tenant\/all/.test(e.params.response.url));
      if (resp.length) {
        console.log('     接口 HTTP 状态:', resp[0].params.response.status);
      }
      const bodyText = await evalJs(c, `(() => { try { return document.body ? document.body.innerText.slice(0, 160) : ''; } catch (e) { return ''; } })()`);
      if (bodyText) console.log('     响应体前 160 字:', bodyText.replace(/\s+/g, ' ').slice(0, 160));
    }

    ws.close();
  } finally {
    chrome.kill();
  }
})().catch((e) => { console.log('!! 失败:', e.message); });
