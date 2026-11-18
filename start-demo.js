#!/usr/bin/env node
'use strict';

/**
 * 一键演示：同时启动「模拟后端(8081)」和「DevSwitch(4599)」
 *   node start-demo.js
 *
 * 演示用的配置写在 data-demo/ 里，**不会碰你真实的 data/state.json**。
 * （早先这里是直接改 data/state.json 的 target，跑完演示你自己的后端地址
 *   就被改成了 8081，而且没有任何提示 —— 这里必须隔离。）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const cwd = __dirname;
const MOCK_PORT = Number(process.env.MOCK_PORT || 8081);
const DEMO_DATA_DIR = 'data-demo';
const demoStateFile = path.join(cwd, DEMO_DATA_DIR, 'state.json');
const procs = [];

/**
 * 搭一份演示专用配置。
 *
 * 以真实配置为底（这样接口路径、Token 来源等仍然贴近你实际的后端），
 * 但把 target 指到模拟后端，并清空账号 —— 演示要的是模拟后端认的
 * admin / dev，你真实账号的密码在模拟后端上必然是错的。
 */
function writeDemoState() {
  fs.mkdirSync(path.join(cwd, DEMO_DATA_DIR), { recursive: true });

  let base = {};
  try {
    base = JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'state.json'), 'utf8'));
  } catch {
    // 没有真实配置也无所谓，用 server.js 的内置默认值
  }

  const demo = {
    ...base,
    target: `http://127.0.0.1:${MOCK_PORT}`,
    accounts: [
      { id: 'acc_demo_admin', name: '演示管理员', username: 'admin', password: '123456', note: '' },
      { id: 'acc_demo_dev', name: '演示开发', username: 'dev', password: '123456', note: '' },
    ],
    tenants: [],
    combos: [],
  };

  fs.writeFileSync(demoStateFile, JSON.stringify(demo, null, 2), 'utf8');
}

function run(script, label, extraEnv) {
  // 把 --no-browser 透传给子进程：演示版由启动器负责开浏览器，
  // 子进程再开一次就会多出两个标签页。直接 `node start-demo.js` 时
  // 本来也不开浏览器（OPEN_BROWSER 未设），所以透传不改变原有行为。
  const argv = [path.join(cwd, script)];
  if (process.argv.includes('--no-browser')) argv.push('--no-browser');

  const p = spawn(process.execPath, argv, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), ...extraEnv },
  });
  p.on('exit', (code) => console.log(`[${label}] 已退出 (code ${code})`));
  procs.push(p);
}

try {
  writeDemoState();
  console.log(`  演示配置   ${demoStateFile}`);
  console.log('  （演示用独立配置目录，你真实的 data/state.json 没有被改动）');
} catch (e) {
  console.warn('[demo] 写入演示配置失败：', e.message);
}

run('mock-backend.js', 'mock');
setTimeout(() => run('server.js', 'switcher', { DATA_DIR: DEMO_DATA_DIR }), 700);

function shutdown() {
  console.log('\n正在关闭…');
  procs.forEach((p) => {
    try { p.kill(); } catch { /* ignore */ }
  });
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
