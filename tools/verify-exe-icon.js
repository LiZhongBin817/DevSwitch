'use strict';
/*
 * 校验 DevSwitch.exe 的图标资源。
 *
 * ## 为什么要查到这个程度
 *
 * MSBuild 的 <ApplicationIcon> 写错路径时**不会报错**，只是静默不嵌图标，
 * 编译照样「成功」。所以「编译通过」完全不能证明 exe 有图标。
 *
 * 唯一可靠的判据是解析 PE 的资源目录树，确认三种资源都在：
 *
 *   RT_GROUP_ICON (14)  —— 图标组，Explorer 靠它知道有几种尺寸
 *   RT_ICON       (3)   —— 每个尺寸的位图数据，7 帧就该有 7 个
 *   RT_VERSION    (16)  —— 版本信息，让「属性 → 详细信息」有内容
 *
 * 顺带把每个 RT_ICON 的大小读出来，和源 ico 的目录项逐一比对 ——
 * 这样能确认「嵌进去的就是我们那份 ico」，而不是别处捡来的。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICO = path.join(ROOT, 'devswitch.ico');

/** 两个入口都要校验，图标缺失任何一个都算失败 */
const EXES = ['DevSwitch.exe', 'DevSwitch-Demo.exe'];

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

const TYPE_NAMES = {
  [RT_ICON]: 'RT_ICON',
  [RT_GROUP_ICON]: 'RT_GROUP_ICON',
  [RT_VERSION]: 'RT_VERSION',
};

/** 定位 .rsrc 段 */
function findRsrc(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') {
    throw new Error('不是有效的 PE 文件');
  }
  const numSec = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const secOff = peOff + 24 + optSize;

  for (let i = 0; i < numSec; i++) {
    const o = secOff + i * 40;
    const name = buf.toString('ascii', o, o + 8).replace(/\0+$/, '');
    if (name !== '.rsrc') continue;
    return {
      vaddr: buf.readUInt32LE(o + 12),
      size: buf.readUInt32LE(o + 16),
      ptr: buf.readUInt32LE(o + 20),
    };
  }
  throw new Error('PE 里没有 .rsrc 段');
}

/**
 * 遍历资源目录树，返回 Map<typeId, [{ id, lang, size, ptr }]>
 *
 * 资源目录结构：每个目录项 8 字节
 *   前 4 字节：Name（高位为 1 表示字符串偏移，否则是整数 ID）
 *   后 4 字节：OffsetToData（高位为 1 表示指向子目录，否则指向数据项）
 *
 * 三层：Type → Name(资源 ID) → Language（叶子）。资源 ID 在第二层，
 * 语言 ID 在第三层 —— 只有第三层才是数据项。
 */
function readResourceTree(buf, rsrc) {
  const base = rsrc.ptr;
  const result = new Map();

  const walk = (dirOff, level, typeId, resId) => {
    const named = buf.readUInt16LE(base + dirOff + 12);
    const idCount = buf.readUInt16LE(base + dirOff + 14);
    const total = named + idCount;

    for (let i = 0; i < total; i++) {
      const e = base + dirOff + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const offsetField = buf.readUInt32LE(e + 4);
      const isString = (nameField & 0x80000000) !== 0;
      const id = isString ? -1 : nameField;

      if ((offsetField & 0x80000000) !== 0) {
        const child = offsetField & 0x7fffffff;
        if (level === 0) walk(child, 1, id, resId);
        else if (level === 1) walk(child, 2, typeId, id);
        else walk(child, 3, typeId, resId);
      } else {
        // 叶子：IMAGE_RESOURCE_DATA_ENTRY
        const de = base + offsetField;
        const dataRva = buf.readUInt32LE(de);
        const size = buf.readUInt32LE(de + 4);
        const fileOff = rsrc.ptr + (dataRva - rsrc.vaddr);
        if (!result.has(typeId)) result.set(typeId, []);
        result.get(typeId).push({ id: resId, lang: id, size, ptr: fileOff });
      }
    }
  };

  walk(0, 0, null, null);
  return result;
}

/** 读源 ico 的每帧大小，用来和 exe 里的资源比对 */
function readIcoFrames(icoPath) {
  const b = fs.readFileSync(icoPath);
  const count = b.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    frames.push({
      w: b[o] || 256,
      h: b[o + 1] || 256,
      size: b.readUInt32LE(o + 8),
      offset: b.readUInt32LE(o + 12),
    });
  }
  return frames;
}

/** 校验单个 exe，返回问题列表（空 = 通过） */
function checkOne(exeName, srcFrames) {
  const exePath = path.join(ROOT, exeName);
  if (!fs.existsSync(exePath)) {
    console.log(`\n${exeName}  不存在`);
    return [`${exeName} 不存在，请先运行 npm run exe`];
  }

  const buf = fs.readFileSync(exePath);
  const rsrc = findRsrc(buf);
  const tree = readResourceTree(buf, rsrc);

  console.log(`\n${exeName}  ${(buf.length / 1024).toFixed(1)} KB`);
  console.log(`  .rsrc 段  vaddr=0x${rsrc.vaddr.toString(16)}  ${rsrc.size} 字节\n`);

  const problems = [];

  for (const [typeId, entries] of tree) {
    const label = TYPE_NAMES[typeId] || `type ${typeId}`;
    console.log(`  ${label.padEnd(14)} ${entries.length} 项`);
    if (typeId === RT_ICON) {
      for (const e of entries) {
        const hit = srcFrames.find((f) => f.size === e.size);
        const mark = hit ? `✓ ${hit.w}x${hit.h}` : '✗ 与源 ico 不符';
        console.log(
          `    id=${String(e.id).padStart(3)}  lang=0x${(e.lang >>> 0).toString(16).padStart(4, '0')}  ` +
            `${String(e.size).padStart(6)}B  ${mark}`
        );
        if (!hit) problems.push(`RT_ICON id=${e.id} 大小 ${e.size}B 在源 ico 里找不到`);
      }
    } else {
      for (const e of entries) {
        console.log(`    id=${String(e.id).padStart(3)}  ${String(e.size).padStart(6)}B`);
      }
    }
  }

  const icons = tree.get(RT_ICON) || [];
  const groups = tree.get(RT_GROUP_ICON) || [];
  const versions = tree.get(RT_VERSION) || [];

  if (icons.length !== srcFrames.length) {
    problems.push(`RT_ICON 有 ${icons.length} 帧，源 ico 是 ${srcFrames.length} 帧`);
  }
  if (groups.length === 0) problems.push('缺少 RT_GROUP_ICON，Explorer 无法识别图标组');
  if (versions.length === 0) problems.push('缺少 RT_VERSION，属性里不会有版本信息');

  // 源 ico 里每帧都要在 exe 里找到同尺寸的对应
  for (const f of srcFrames) {
    if (!icons.some((e) => e.size === f.size)) {
      problems.push(`源 ico 的 ${f.w}x${f.h}（${f.size}B）没有嵌进 exe`);
    }
  }

  return problems;
}

function main() {
  if (!fs.existsSync(ICO)) {
    throw new Error(`找不到 ${ICO}，请先运行 npm run icon`);
  }
  const srcFrames = readIcoFrames(ICO);

  let failed = false;
  for (const exeName of EXES) {
    const problems = checkOne(exeName, srcFrames);
    if (problems.length) {
      failed = true;
      console.log('\n发现问题：');
      for (const p of problems) console.log('  ✗ ' + p);
    } else {
      console.log('');
      console.log(`  ✓ 通过：${srcFrames.length} 帧图标 + 图标组 + 版本信息齐全`);
    }
  }

  console.log('');
  if (failed) {
    console.log('有 exe 没通过校验。');
    process.exit(1);
  }
  console.log('全部通过。Explorer 显示的就是 exe 自带的图标，不依赖任何快捷方式。');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('校验失败：' + e.message);
    process.exit(1);
  }
}
