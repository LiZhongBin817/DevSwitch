'use strict';
/*
 * 根因诊断报告：为什么快捷方式图标曾经是白纸。
 *
 * 这个脚本不改任何东西，只把结论和证据打印出来，便于以后回查
 * （或者过几天忘了细节时，一条命令重新看到全貌）。
 *
 * 运行：node tools/diagnose-icon.js
 */
const fs = require('fs');
const path = require('path');

const { INSTALL_ICO, verifyIco } = require('./install-icon');

const ROOT = path.join(__dirname, '..');
const SRC_ICO = path.join(ROOT, 'devswitch.ico');

const line = (s = '') => console.log(s);
const head = (s) => {
  line();
  line('─'.repeat(66));
  line(s);
  line('─'.repeat(66));
};

head('1. 图标文件本身');

for (const [label, p] of [
  ['源文件  ', SRC_ICO],
  ['安装副本', INSTALL_ICO],
]) {
  if (!fs.existsSync(p)) {
    line(`  ${label}  ✗ 不存在  ${p}`);
    continue;
  }
  const buf = fs.readFileSync(p);
  let frames;
  try {
    frames = verifyIco(buf);
  } catch (e) {
    line(`  ${label}  ✗ 结构非法：${e.message}`);
    continue;
  }
  line(`  ${label}  ✓ ${buf.length} 字节  ${frames.length} 帧`);
  line(`            ${frames.join(' / ')}`);
  line(`            ${p}`);
}

head('2. 快捷方式的 IconLocation');

for (const lnk of ['DevSwitch.lnk', 'DevSwitch-Demo.lnk']) {
  const p = path.join(ROOT, lnk);
  if (!fs.existsSync(p)) {
    line(`  ${lnk}  ✗ 不存在`);
    continue;
  }
  const b = fs.readFileSync(p);
  const flags = b.readUInt32LE(20);
  let off = 76;
  if (flags & 1) off += 2 + b.readUInt16LE(off);
  if (flags & 2) off += b.readUInt32LE(off);

  const strs = [];
  for (let bit = 2; bit <= 6; bit++) {
    if (!(flags & (1 << bit))) continue;
    const cnt = b.readUInt16LE(off);
    strs.push(b.subarray(off + 2, off + 2 + cnt * 2).toString('utf16le'));
    off += 2 + cnt * 2;
  }
  const icon = strs[strs.length - 1];
  const ascii = /^[\x20-\x7e]+$/.test(icon);
  line(`  ${lnk}`);
  line(`    IconLocation = ${icon}`);
  line(`    纯 ASCII ${ascii ? '✓' : '✗ 含非 ASCII，Explorer 可能无法解析'}`);
  line(`    文件存在 ${fs.existsSync(icon) ? '✓' : '✗'}`);
}

head('3. 结论');

line(`
  图标曾经显示为「白纸 + 左下角蓝色箭头」，这是 Windows 的通用快捷方式
  兜底图标。触发条件不是 .lnk 结构错误，也不是 .ico 文件损坏，而是：

      IconLocation 指向的路径含非 ASCII 字符（E:\\学习项目\\）

  资源管理器解析快捷方式图标时走的是这条链路：

      .lnk → IconLocation 字符串 → 打开 ico → 按尺寸取帧 → 渲染

  实测该链路对中文路径不可靠，解析失败后直接回退兜底图标。
  而双击 ico 文件本身能正常显示 DS —— 因为那是直接解码文件内容，
  不经过 IconLocation 解析。这个差异是当初一直判断错方向的原因：
  「ico 明明是好的」和「快捷方式画白纸」可以同时为真。

  对照实验（C:\\ico-test，若已清理则已不存在）：

      B-ascii-ours.lnk    icon=C:\\ico-test\\ds.ico            → DS ✓
      C-ours-cnpath.lnk   icon=E:\\学习项目\\...\\devswitch.ico → 白纸 ✗

  两者 target 都指向同一个中文路径下的 .bat、workDir 完全相同，
  唯一差异只有 IconLocation，所以「target 含中文」被排除。

  现在的修复：ico 复制到 ${INSTALL_ICO}
  （纯 ASCII），.lnk 只引用副本。源文件保留在项目里作为构建产物。
`);
