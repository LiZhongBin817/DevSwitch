'use strict';
/*
 * 把图标与快捷方式安装到位，让资源管理器能正确渲染 DS 图标。
 *
 * ## 为什么不能直接引用项目目录里的 devswitch.ico
 *
 * 项目位于 `E:\学习项目\dev-switch\`，路径含中文。实验证据：
 *
 *   B-ascii-ours.lnk   icon=C:\ico-test\ds.ico            → 显示 DS ✓
 *   C-ours-cnpath.lnk  icon=E:\学习项目\...\devswitch.ico → 白纸  ✗
 *
 * 两者的 target 都指向同一个中文路径下的 DevSwitch.bat，workDir 也完全相同，
 * 唯一差异就是 IconLocation。所以「target 含中文」被排除（否则 B 也该失败），
 * 根因落在 IconLocation 的非 ASCII 字符上。
 *
 * 此外 devswitch.ico 本体在资源管理器里显示正常 —— 因为那是直接解码文件，
 * 不走 IconLocation 解析这条路径。两条路径对非 ASCII 的处理不同，这解释了
 * 为什么「图标文件明明是对的，快捷方式却画白纸」。
 *
 * ## 方案
 *
 * 把 ico 复制到 C:\ProgramData\DevSwitch\（纯 ASCII、机器级、所有用户可读），
 * 快捷方式的 IconLocation 只引用这个副本。项目目录里的 devswitch.ico 保留为
 * 构建产物（build-ico.js 的输出），安装时再同步过去。
 *
 * ## 用法
 *
 *   npm run icon      # 重新生成 devswitch.ico（改了 SVG 才需要）
 *   npm run install   # 部署 ico + 重建两个 .lnk
 */
const fs = require('fs');
const path = require('path');

const { buildLnkEnv } = require('./lnk-env');

const ROOT = path.join(__dirname, '..');
const SRC_ICO = path.join(ROOT, 'devswitch.ico');

/** 纯 ASCII 安装目录。不要改成项目内路径，否则图标又会变白纸。 */
const INSTALL_DIR = 'C:\\ProgramData\\DevSwitch';
const INSTALL_ICO = path.join(INSTALL_DIR, 'devswitch.ico');

/** ICO 合法性检查：小尺寸必须 DIB，256 必须 PNG */
function verifyIco(buf) {
  if (buf.length < 6) throw new Error('ICO 太小，不是有效文件');
  if (buf.readUInt16LE(2) !== 1) throw new Error('ICO 类型字段不是 1（图标）');
  const count = buf.readUInt16LE(4);
  if (count === 0) throw new Error('ICO 里没有任何帧');
  const rows = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256;
    const size = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    if (off + size > buf.length) throw new Error(`第 ${i} 帧超出文件末尾`);
    const isPng = buf[off] === 0x89 && buf[off + 1] === 0x50;
    // Windows 只对 256×256 正式支持 PNG 压缩帧；更小的必须是 BMP/DIB
    if (w >= 256 && !isPng) throw new Error(`第 ${i} 帧 ${w}px 应为 PNG`);
    if (w < 256 && isPng) throw new Error(`第 ${i} 帧 ${w}px 必须为 DIB，PNG 会导致 Explorer 回退兜底图标`);
    rows.push(`${w}x${buf[o + 1] || 256} ${isPng ? 'PNG' : 'DIB'}`);
  }
  return rows;
}

function main() {
  if (!fs.existsSync(SRC_ICO)) {
    throw new Error(`找不到 ${SRC_ICO}，请先运行 npm run icon`);
  }

  const buf = fs.readFileSync(SRC_ICO);
  const frames = verifyIco(buf);

  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  // 已存在时先删再写：某些情况下覆盖会被拒绝
  if (fs.existsSync(INSTALL_ICO)) fs.unlinkSync(INSTALL_ICO);
  fs.writeFileSync(INSTALL_ICO, buf);

  console.log(`图标已安装到 ${INSTALL_ICO}`);
  console.log(`  ${buf.length} 字节，${frames.length} 帧：${frames.join(' / ')}`);

  const targets = [
    { name: 'DevSwitch', bat: 'DevSwitch.bat', lnk: 'DevSwitch.lnk' },
    { name: 'DevSwitch Demo', bat: 'DevSwitch-Demo.bat', lnk: 'DevSwitch-Demo.lnk' },
  ];

  for (const t of targets) {
    const target = path.join(ROOT, t.bat);
    const out = path.join(ROOT, t.lnk);
    if (!fs.existsSync(target)) {
      console.log(`  跳过 ${t.lnk}（${t.bat} 不存在）`);
      continue;
    }
    // 安全策略不允许直接覆盖 .lnk，必须先删
    if (fs.existsSync(out)) fs.unlinkSync(out);
    buildLnkEnv({
      name: t.name,
      target,
      icon: INSTALL_ICO, // ← 关键：ASCII 路径
      workDir: ROOT,
      out,
    });
  }

  console.log('\n完成。若图标仍未刷新，运行：npm run icon:clear');
}

if (require.main === module) main();

module.exports = { verifyIco, INSTALL_ICO, INSTALL_DIR };
