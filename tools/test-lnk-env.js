'use strict';
/*
 * 验证「环境变量块」路线的 .lnk 能否被 Shell 执行。
 *
 * 与 test-lnk.js 的区别：不使用 IDList / LinkInfo，只靠
 * EnvironmentVariableDataBlock 定位目标。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { buildLnkEnv } = require('./lnk-env');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, '.e2e', 'lnk-probe');
const BAT = path.join(DIR, 'probe.bat');
const LNK = path.join(DIR, 'probe-env.lnk');
const MARKER = path.join(DIR, 'marker.txt');
const ICON = path.join(ROOT, 'devswitch.ico');

fs.mkdirSync(DIR, { recursive: true });

// 探针：把自身目录、工作目录、参数落盘。纯 ASCII + CRLF，路径用 %~dp0 展开。
const bat = [
  '@echo off',
  'setlocal',
  'set "M=%~dp0marker.txt"',
  '> "%M%" echo SCRIPT_DIR=%~dp0',
  '>> "%M%" echo CWD=%CD%',
  '>> "%M%" echo ARGS=%~1',
  'endlocal',
  '',
].join('\r\n');
fs.writeFileSync(BAT, bat, 'latin1');

if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER);
if (fs.existsSync(LNK)) fs.unlinkSync(LNK);

buildLnkEnv({ name: 'Lnk Env Probe', target: BAT, workDir: DIR, icon: ICON, out: LNK });

console.log(`\n启动 ${LNK}`);
const child = spawn('cmd.exe', ['/c', 'start', '', LNK], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

const deadline = Date.now() + 6000;
while (Date.now() < deadline && !fs.existsSync(MARKER)) {
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},80)']);
}

console.log('='.repeat(60));
if (!fs.existsSync(MARKER)) {
  console.log('❌ 未生成标记文件');
  process.exit(1);
}
console.log('✅ 已执行，内容：');
const c = fs.readFileSync(MARKER, 'latin1');
c.split(/\r?\n/).forEach((l) => l && console.log('   ' + l));
