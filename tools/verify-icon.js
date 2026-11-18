'use strict';
/*
 * 校验 devswitch.ico，并确认 .lnk 的 IconLocation + IconIndex 指对了它。
 *
 * ## 为什么旧版不够（重要教训）
 *
 * 旧版只检查「结构」：目录项、偏移、越界、PNG/DIB 标记。它全过了，
 * 但实际 ico 里 16px 帧是全透明的、128px 帧是被裁切的局部放大图 ——
 * 结构完全合法，图标就是不显示。
 *
 * 所以现在必须查「内容」：每帧的不透明占比、蓝色主体占比、白色文字占比、
 * 以及主体包围盒是否居中。只查结构等于没查。
 *
 * ## 另一条硬规则
 *
 * 小于 256 的帧必须是 DIB。Windows 只在 256 一档支持 PNG 帧；
 * 小尺寸用 PNG 会导致 Explorer 解码失败、回退到通用快捷方式图标
 * （表现为「能启动但图标是白纸+蓝箭头」）。
 */
const fs = require('fs');
const path = require('path');

const { decodePng } = require('./png-decode');
const { INSTALL_ICO } = require('./install-icon');

const ROOT = path.join(__dirname, '..');
const ICO = path.join(ROOT, 'devswitch.ico');

/*
 * 快捷方式的 IconLocation 必须指向 C:\ProgramData\DevSwitch\ 下的 ASCII 副本，
 * 不能指向项目内的 ICO —— 项目路径 E:\学习项目\ 含中文，Explorer 解析
 * IconLocation 时会失败并回退成「白纸 + 蓝箭头」兜底图标。
 *
 * 但真正被渲染的是安装副本，所以两份都要校验：
 *   1. 源文件 devswitch.ico 的帧格式与内容
 *   2. 安装副本存在、且与源文件逐字节一致（避免改了源忘了重新 install）
 */
const ICON_EXPECT = INSTALL_ICO;

/** 从 ICO 内嵌 DIB 帧解出 RGBA */
function decodeDib(data, w, h) {
  const biSize = data.readUInt32LE(0);
  if (biSize !== 40) throw new Error(`biSize=${biSize}，应为 40`);
  const biH = data.readInt32LE(8);
  if (biH !== h * 2) throw new Error(`biHeight=${biH}，应为 ${h * 2}`);
  const bpp = data.readUInt16LE(14);
  if (bpp !== 32) throw new Error(`bpp=${bpp}，应为 32`);

  const stride = w * 4;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = 40 + (h - 1 - y) * stride; // 文件里自底向上
    for (let x = 0; x < w; x++) {
      const s = srcRow + x * 4;
      const d = (y * w + x) * 4;
      rgba[d] = data[s + 2]; // R
      rgba[d + 1] = data[s + 1]; // G
      rgba[d + 2] = data[s]; // B
      rgba[d + 3] = data[s + 3]; // A
    }
  }
  return rgba;
}

/** 统计像素特征：不透明/蓝/白占比 + 主体包围盒 */
function analyze(rgba, w, h) {
  let opaque = 0,
    blue = 0,
    white = 0;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i],
        g = rgba[i + 1],
        b = rgba[i + 2],
        a = rgba[i + 3];
      if (a < 16) continue; // 全透明像素不算主体
      opaque++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (b > 120 && b > r + 40 && b > g + 20) blue++;
      if (r > 200 && g > 200 && b > 200) white++;
    }
  }

  const total = w * h;
  return {
    opaque: opaque / total,
    blue: blue / total,
    white: white / total,
    bbox: maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

const buf = fs.readFileSync(ICO);
const count = buf.readUInt16LE(4);
console.log(`\ndevswitch.ico  ${buf.length} 字节  ${count} 帧`);
console.log(
  `  reserved=${buf.readUInt16LE(0)} ${buf.readUInt16LE(0) === 0 ? '✓' : '✗'}  ` +
    `type=${buf.readUInt16LE(2)} ${buf.readUInt16LE(2) === 1 ? '✓(ICON)' : '✗'}\n`
);

const problems = [];
const entries = [];

for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = buf[o] === 0 ? 256 : buf[o];
  const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
  const bpp = buf.readUInt16LE(o + 6);
  const size = buf.readUInt32LE(o + 8);
  const offset = buf.readUInt32LE(o + 12);
  const inRange = offset + size <= buf.length;

  if (!inRange) {
    problems.push(`${w}px 数据越界`);
    continue;
  }

  const data = buf.subarray(offset, offset + size);
  const isPng = data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG';

  let rgba;
  if (isPng) {
    const d = decodePng(data);
    if (d.width !== w || d.height !== h) {
      problems.push(`${w}px PNG 实际 ${d.width}x${d.height}`);
      continue;
    }
    rgba = d.rgba;
  } else {
    try {
      rgba = decodeDib(data, w, h);
    } catch (e) {
      problems.push(`${w}px DIB 解析失败：${e.message}`);
      continue;
    }
  }

  const a = analyze(rgba, w, h);
  // 格式规则：只有 256 允许 PNG，其余必须 DIB
  const formatOk = w >= 256 ? isPng : !isPng;
  // 内容规则：主体不透明、蓝底显著、有白字、包围盒基本满幅
  const contentOk = a.opaque > 0.5 && a.blue > 0.3 && a.white > 0.004;
  const centered =
    a.bbox &&
    Math.abs(a.bbox.minX - (w - 1 - a.bbox.maxX)) <= Math.max(1, Math.round(w * 0.06)) &&
    Math.abs(a.bbox.minY - (h - 1 - a.bbox.maxY)) <= Math.max(1, Math.round(h * 0.06));

  entries.push({ w, h, bpp, size, offset, isPng, formatOk, contentOk, centered, a });

  if (!formatOk) problems.push(`${w}px 格式错误：${isPng ? '小尺寸不该用 PNG' : '256 应用 PNG'}`);
  if (!contentOk)
    problems.push(
      `${w}px 内容异常：不透明 ${(a.opaque * 100).toFixed(1)}%，蓝 ${(a.blue * 100).toFixed(1)}%，白 ${(a.white * 100).toFixed(2)}%`
    );
  if (!centered) problems.push(`${w}px 主体不居中`);

  console.log(
    `  [${i}] ${String(w).padStart(3)}x${String(h).padStart(3)}  ${bpp}bpp  ${String(size).padStart(6)}B  ` +
      `${(isPng ? 'PNG' : 'DIB').padEnd(3)}  ` +
      `不透明 ${(a.opaque * 100).toFixed(0).padStart(3)}%  ` +
      `蓝 ${(a.blue * 100).toFixed(0).padStart(3)}%  ` +
      `白 ${(a.white * 100).toFixed(1).padStart(4)}%  ` +
      `主体 ${a.bbox ? a.bbox.w + 'x' + a.bbox.h : '空'}  ` +
      (formatOk && contentOk && centered ? '✓' : '✗')
  );
}

console.log('');
const need = [16, 32, 48, 256];
for (const s of need) {
  const hit = entries.find((e) => e.w === s);
  console.log(`  常用尺寸 ${String(s).padStart(3)}px  ${hit ? '✓' : '✗ 缺失'}`);
}

/* ---- .lnk 交叉校验 ---- */
for (const lnkName of ['DevSwitch.lnk', 'DevSwitch-Demo.lnk']) {
  const lnkPath = path.join(ROOT, lnkName);
  if (!fs.existsSync(lnkPath)) continue;
  const b = fs.readFileSync(lnkPath);
  const flags = b.readUInt32LE(20);
  const iconIndex = b.readInt32LE(56);

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
  const iconLoc = strs[strs.length - 1];
  const ok =
    iconLoc === ICON_EXPECT &&
    iconIndex === 0 &&
    fs.existsSync(iconLoc) &&
    /^[\x20-\x7e]+$/.test(iconLoc); // 必须是纯 ASCII，中文会让 Explorer 解析失败
  if (!ok) problems.push(`${lnkName} 的 IconLocation/IconIndex 不对`);
  console.log(
    `\n  ${lnkName}  IconIndex=${iconIndex}  ${iconLoc === ICON_EXPECT ? '✓' : '✗'}  ` +
      `纯ASCII ${/^[\x20-\x7e]+$/.test(iconLoc) ? '✓' : '✗'}  ` +
      `文件存在 ${fs.existsSync(iconLoc) ? '✓' : '✗'}`
  );
  console.log(`    IconLocation = ${iconLoc}`);
}

/* ---- 安装副本一致性 ---- */
if (fs.existsSync(ICON_EXPECT)) {
  const a = fs.readFileSync(ICO);
  const b = fs.readFileSync(ICON_EXPECT);
  const same = a.equals(b);
  if (!same) problems.push('安装副本与源 devswitch.ico 不一致，请运行 npm run install');
  console.log(`\n  安装副本 ${ICON_EXPECT}  ${same ? '✓ 与源文件一致' : '✗ 已过期'}`);
} else {
  problems.push(`安装副本不存在：${ICON_EXPECT}，请运行 npm run install`);
}

if (problems.length) {
  console.log('\n发现问题：');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n全部通过：格式、内容、居中、快捷方式指向均正确。');
