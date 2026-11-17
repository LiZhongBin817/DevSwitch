#!/usr/bin/env node
'use strict';
/**
 * 验证「点账号 → 自动写入浏览器」整条链，完全模拟用户操作：
 *   1. 打开真实面板
 *   2. 点左侧第一个账号（跟用户点鼠标完全一样）
 *   3. 等自动同步完成
 *   4. 检查浏览器罐里两个主机名是否都有 Authorization
 *   5. 真的导航到两个业务接口，确认都是 T200
 *
 * 这一步的意义：之前所有验证都是脚本直接调写函数，
 * 没验证过「用户只点了一下账号」时流程能不能自己走完。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9405;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return {
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const userDir = path.join(os.tmpdir(), 'click-test-' + Date.now());
  fs.mkdirSync(userDir, { recursive: true });
  const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--headless=new', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });

  try {
    let list = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); if (list.length) break; } catch { }
    }
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const c = rpc(ws);
    await c.send('Network.enable');
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    console.log('=== 打开面板 http://127.0.0.1:4599 ===');
    await c.send('Page.navigate', { url: 'http://localhost:4599/' });
    await sleep(1800);

    await c.send('Network.clearBrowserCookies');

    console.log('\n=== 点左侧第一个账号（模拟用户点鼠标）===');
    const clicked = await evalJs(c, `(async () => {
      const el = document.querySelector('[data-acc]');
      if (!el) return { ok: false, why: '账号列表里没有可点的项' };
      const name = el.querySelector('.row-title') ? el.querySelector('.row-title').textContent : '';
      el.click();
      return { ok: true, name: name };
    })()`);
    console.log('  点击:', JSON.stringify(clicked));
    if (!clicked.ok) { console.log('!! 无法点击，退出'); ws.close(); chrome.kill(); return; }

    // 等登录 + 自动同步完成（连接真实后端需要一点时间）
    console.log('\n  等待登录与自动同步…');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const st = await evalJs(c, `(() => ({
        cookies: session.cookies.length,
        written: browserCookie.written.length,
        jar: browserCookie.jar.map(function (k) { return k.name; }),
      }))()`);
      if (st.cookies && st.written) { ready = true; console.log('  完成，用时约', i + 1, '秒:', JSON.stringify(st)); break; }
    }
    if (!ready) console.log('  !! 20 秒内没等到自动同步完成');

    const jar = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.name === 'Authorization')
      .map((k) => k.domain);
    console.log('\n  罐里 Authorization 所在主机名:', JSON.stringify(Array.from(new Set(jar))));

    console.log('\n=== 直接导航两个业务接口（不做任何额外操作）===');
    for (const host of ['localhost', '127.0.0.1']) {
      await c.send('Page.navigate', { url: `http://${host}:8080/pds-std/api/pf/tenant/all` });
      await sleep(1800);
      const t = await evalJs(c, `(() => { try { return document.body ? document.body.innerText.slice(0, 90) : ''; } catch (e) { return ''; } })()`);
      const ok = t.includes('"T200"');
      console.log(`  http://${host}:8080 → ${ok ? 'T200 登录态正常 ✅' : '未登录 ❌ ' + t.replace(/\\s+/g, ' ').slice(0, 80)}`);
    }

    ws.close();
  } finally { chrome.kill(); }
})().catch((e) => console.log('!! 失败:', e.message));
