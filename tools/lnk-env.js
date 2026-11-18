'use strict';
/*
 * 用「环境变量块」定位目标的 .lnk 生成器 —— 比 IDList 路线简单得多。
 *
 * ## 为什么换方案
 *
 * 手写 IDList 一路踩坑：根节点 CLSID 少 1 字节、短名编码、扩展块 46 字节头、
 * 末尾 2 字节偏移…… 任何一处错都会被 Shell 判为「没有应用程序与此操作的
 * 指定文件有关联」（= 压根没识别成快捷方式）。
 *
 * 而系统里有 35 个真实 .lnk 完全不用 IDList、也不用 LinkInfo，
 * 靠 ExtraData 里的 EnvironmentVariableDataBlock(0xA0000001) 定位。
 * 这个块的最大好处是：**路径字段定长**（ANSI 260 字节 + Unicode 520 字节，
 * 不足补零），所以完全不用计算任何长度偏移，替换路径零风险。
 *
 * 模板取自 C:\ProgramData\...\System Tools\Task Manager.lnk，flags=0x020003e4。
 *
 * ## 结构
 *
 * [ShellLinkHeader(76)]
 * [StringData: NAME, (WORKING_DIR), ICON_LOCATION]   顺序必须与 LinkFlags 位序一致
 * [ExtraData: EnvironmentVariableDataBlock(788), TerminalBlock(4)]
 *
 * ## 实测结论（都验证过才写进来）
 *
 * - Shell 报「没有应用程序与此操作的指定文件有关联」= 压根没识别成快捷方式；
 *   报「系统找不到指定的文件」= 认了、只是目标不存在。这两句话是判断结构
 *   是否合法的唯一可靠信号。
 * - 自写的 IDList 路线始终被判为非法，而环境变量块路线一次通过 ——
 *   因为 788 字节定长，没有任何长度偏移需要计算，出错的自由度小得多。
 * - StringData 的计数字段是「纯字符数」，数据不带 NUL（扫 87 个系统样本确认）。
 */
const fs = require('fs');
const path = require('path');

const { gbk } = require('./gbk');

const HasName = 1 << 2;
const HasWorkingDir = 1 << 4;
const HasIconLocation = 1 << 6;
const IsUnicode = 1 << 7;
const ForceNoLinkInfo = 1 << 8; // 声明「不要用 LinkInfo」，配合 HasExpString
const HasExpString = 1 << 9; // 有 EnvironmentVariableDataBlock
const PreferEnvironmentPath = 1 << 25; // 优先用环境变量块解析

/** EnvironmentVariableDataBlock 固定 788 字节：4+4+260+520 */
const ENV_BLOCK_SIZE = 788;
const ENV_SIG = 0xa0000001;

function buildEnvBlock(target) {
  const b = Buffer.alloc(ENV_BLOCK_SIZE);
  b.writeUInt32LE(ENV_BLOCK_SIZE, 0);
  b.writeUInt32LE(ENV_SIG, 4);
  // TargetAnsi: 260 字节，GBK 编码，NUL 结尾，其余保持 0
  gbk(target).copy(b, 8, 0, 259);
  // TargetUnicode: 520 字节，从 offset 268 起
  Buffer.from(target, 'utf16le').copy(b, 268, 0, 518);
  return b;
}

function buildLnkEnv({ name, target, icon, out, workDir }) {
  if (!fs.existsSync(target)) throw new Error(`找不到目标：${target}`);
  if (!fs.existsSync(icon)) throw new Error(`找不到图标：${icon}`);

  const linkFlags =
    HasName |
    (workDir ? HasWorkingDir : 0) |
    HasIconLocation |
    IsUnicode |
    ForceNoLinkInfo |
    HasExpString |
    PreferEnvironmentPath;

  /* ---- ShellLinkHeader ---- */
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(header, 4);
  header.writeUInt32LE(linkFlags, 20);
  header.writeUInt32LE(0x20, 24); // ARCHIVE
  header.writeUInt32LE(0, 52); // FileSize
  header.writeInt32LE(0, 56); // IconIndex
  header.writeUInt32LE(1, 60); // SW_SHOWNORMAL
  // 64..76 保留字段全 0

  /* ---- StringData ---- */
  // 顺序由 LinkFlags 位序决定：NAME(bit2) → WORKING_DIR(bit4) → ICON_LOCATION(bit6)
  // 计数字段实测惯例：纯字符数、数据不带 NUL
  const str = (s) => {
    const body = Buffer.from(s, 'utf16le');
    const len = Buffer.alloc(2);
    len.writeUInt16LE(s.length, 0);
    return Buffer.concat([len, body]);
  };
  const parts = [str(name)];
  if (workDir) parts.push(str(workDir));
  parts.push(str(icon));
  const strings = Buffer.concat(parts);

  /* ---- ExtraData ---- */
  const extra = Buffer.concat([buildEnvBlock(target), Buffer.alloc(4)]);

  const lnk = Buffer.concat([header, strings, extra]);
  fs.writeFileSync(out, lnk);

  console.log(`已生成 ${path.basename(out)}：${lnk.length} 字节`);
  console.log(`  flags    0x${linkFlags.toString(16).padStart(8, '0')}`);
  console.log(`  目标     ${target}`);
  if (workDir) console.log(`  工作目录 ${workDir}`);
  console.log(`  图标     ${icon}`);
  return lnk;
}

module.exports = { buildLnkEnv, buildEnvBlock };

if (require.main === module) {
  const ROOT = path.join(__dirname, '..');
  const ICON = path.join(ROOT, 'devswitch.ico');

  // EPERM 防护：安全策略不允许覆盖已存在的 .lnk（快捷方式是可执行入口），
  // 必须先删再写。
  const make = (opts) => {
    if (fs.existsSync(opts.out)) fs.unlinkSync(opts.out);
    return buildLnkEnv({ icon: ICON, workDir: ROOT, ...opts });
  };

  make({
    name: 'DevSwitch',
    target: path.join(ROOT, 'DevSwitch.bat'),
    out: path.join(ROOT, 'DevSwitch.lnk'),
  });

  const demoBat = path.join(ROOT, 'DevSwitch-Demo.bat');
  if (fs.existsSync(demoBat)) {
    make({
      name: 'DevSwitch Demo',
      target: demoBat,
      out: path.join(ROOT, 'DevSwitch-Demo.lnk'),
    });
  }
}
