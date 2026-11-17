#!/usr/bin/env node
'use strict';
/**
 * 真机验证：像用户那样操作 —— 用 127.0.0.1 打开面板登录、点「写入浏览器」，
 * 然后直接访问 localhost:8080 的业务页面，看浏览器会不会带上登录态。
 *
 * 这个脚本连的是正在跑的 4599 面板和真实后端，不会改任何配置。
 * 用法：node .e2e/manual-check.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9377;
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

(async () => {
  const userDir = path.join(os.tmpdir(), 'manual-check-' + Date.now());
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

    // 用 127.0.0.1 打开面板（用户的真实用法）
    await c.send('Page.navigate', { url: 'http://127.0.0.1:4599/' });
    await sleep(1500);

    const info = await c.send('Runtime.evaluate', {
      expression: `({ host: location.host, other: otherHost(), hasBridge: typeof cookieBridge === 'function' })`,
      returnByValue: true,
    });
    console.log('面板页:', JSON.stringify(info.result.value));

    // 直接调用桥，模拟点「写入浏览器」的核心动作（这里造一个假会话 Cookie，
    // 不依赖真实账号，验证的是「Cookie 能不能落到两个主机名上」）
    const wrote = await c.send('Runtime.evaluate', {
      expression: `(async () => {
        const r = await cookieBridge({ cookies: ['PROBE_VERIFY=xyz; Path=/; HttpOnly'] });
        return r;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log('桥接结果:', JSON.stringify(wrote.result.value));

    await sleep(500);
    const all = (await c.send('Network.getAllCookies')).cookies
      .filter((k) => k.name === 'PROBE_VERIFY')
      .map((k) => ({ domain: k.domain, httpOnly: k.httpOnly, sameSite: k.sameSite, secure: k.secure }));
    console.log('罐里的 PROBE_VERIFY:', JSON.stringify(all, null, 2));

    // 真正的问题：直接访问 localhost:8080 的业务接口，浏览器会不会带 Cookie？
    for (const host of ['localhost', '127.0.0.1']) {
      const sent = (await c.send('Network.getCookies', {
        urls: [`http://${host}:8080/pds-std/api/pf/tenant/all`],
      })).cookies.filter((k) => k.name === 'PROBE_VERIFY').map((k) => k.name);
      console.log(`→ 访问 http://${host}:8080 会带上 PROBE_VERIFY:`, sent.length > 0 ? '是' : '否');
    }

    ws.close();
  } finally {
    chrome.kill();
  }
})();
