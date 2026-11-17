#!/usr/bin/env node
'use strict';
/**
 * 决定性验证：后端在 Set-Cookie 里写死了 Domain=127.0.0.1。
 *
 * 问题：如果用户在 http://localhost:8080 的页面上**直接登录**，
 * 浏览器收到 "Domain=127.0.0.1" 的 Cookie 会怎么处理？
 * 按规范，localhost 不是 127.0.0.1 的子域 → 必须拒收。
 *
 * 如果是这样，那「后端是 localhost，还是不行」就有了唯一解释：
 * 不是面板的问题，是**后端给 localhost 下发了一个浏览器不可能接受的 Cookie**。
 * 任何在 localhost 上直接登录都会被静默丢弃 Authorization。
 *
 * 本脚本：分别在 localhost 与 127.0.0.1 的页面上下文里发登录请求，
 * 然后看浏览器罐里到底有没有落下 Authorization。全程不打印任何 Cookie 值。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CDP_PORT = 9403;
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
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'state.json'), 'utf8'));
  const acc = state.accounts[0];
  const userDir = path.join(os.tmpdir(), 'domain-test-' + Date.now());
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

    for (const host of ['localhost', '127.0.0.1']) {
      // 每次从干净状态开始，避免上一次的 Cookie 干扰判断
      await c.send('Network.clearBrowserCookies');

      await c.send('Page.navigate', { url: `http://${host}:8080/` });
      await sleep(1200);

      // 在该页面上下文里直接登录（等价于用户在业务系统页面上登录）
      const loginResult = await c.send('Runtime.evaluate', {
        expression: `(async () => {
          const r = await fetch('/pds-std/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: ${JSON.stringify(acc.username)}, password: ${JSON.stringify(acc.password)} }),
          });
          const t = await r.text();
          let j = null; try { j = JSON.parse(t); } catch (e) {}
          return { status: r.status, retCode: j && j.retCode, retMsg: j && j.retMsg };
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      const lr = loginResult.result.value;

      await sleep(800);
      const jar = (await c.send('Network.getAllCookies')).cookies
        .filter((k) => k.name === 'Authorization' || k.name === 'JSESSIONID')
        .map((k) => ({ name: k.name, domain: k.domain, valueLen: k.value.length }));

      // 真正再请求一次业务接口，看有没有登录态
      const api = await c.send('Runtime.evaluate', {
        expression: `(async () => {
          const r = await fetch('/pds-std/api/pf/tenant/all');
          const t = await r.text();
          return { status: r.status, head: t.slice(0, 100) };
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      const ar = api.result.value;

      console.log(`\n===== 在 http://${host}:8080 页面上直接登录 =====`);
      console.log('  登录响应:', `HTTP ${lr.status}`, 'retCode=' + JSON.stringify(lr.retCode), 'retMsg=' + JSON.stringify(lr.retMsg));
      console.log('  登录后浏览器罐里:');
      if (!jar.length) {
        console.log('    (空)  ← 后端下发的 Cookie 全被浏览器拒收了');
      }
      jar.forEach((k) => console.log(`    - ${k.name}: domain=${k.domain} 值长=${k.valueLen}`));
      console.log('  随后请求业务接口:', `HTTP ${ar.status}`);
      console.log('  接口返回前 100 字:', ar.head.replace(/\s+/g, ' '));
      const ok = ar.head.includes('"T200"');
      console.log('  是否已是登录态:', ok ? '✅ 是' : '❌ 否');
    }

    ws.close();
  } finally {
    chrome.kill();
  }
})().catch((e) => console.log('!! 失败:', e.message));
