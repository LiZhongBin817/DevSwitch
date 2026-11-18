'use strict';
/*
 * 完整拆解一个 .lnk 的所有段，包括 ExtraData 里每个块的原始字节。
 * 目的：把「能启动」的系统样本当模板，逐段照抄。
 */
const fs = require('fs');

const SIG_NAMES = {
  0xa0000001: 'EnvironmentVariableDataBlock',
  0xa0000002: 'TrackerDataBlock',
  0xa0000003: 'ConsoleDataBlock',
  0xa0000004: 'ConsoleFEDataBlock',
  0xa0000005: 'SpecialFolderDataBlock',
  0xa0000006: 'DarwinDataBlock',
  0xa0000007: 'IconEnvironmentDataBlock',
  0xa0000008: 'ShimDataBlock',
  0xa0000009: 'PropertyStoreDataBlock',
  0xa000000b: 'KnownFolderDataBlock',
  0xa000000c: 'VistaAndAboveIDListDataBlock',
};

const STR_BITS = [
  [2, 'NAME'],
  [3, 'RELATIVE_PATH'],
  [4, 'WORKING_DIR'],
  [5, 'ARGUMENTS'],
  [6, 'ICON_LOCATION'],
];

function dump(file) {
  const b = fs.readFileSync(file);
  console.log('\n' + '='.repeat(74));
  console.log(`${file}   (${b.length} 字节)`);
  console.log('='.repeat(74));

  const hs = b.readUInt32LE(0);
  const flags = b.readUInt32LE(20);
  console.log(`HeaderSize ${hs}  LinkFlags 0x${flags.toString(16).padStart(8, '0')}`);
  const bits = [];
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) bits.push(i);
  console.log(`置位: ${bits.join(', ')}`);
  console.log(`  FileAttributes 0x${b.readUInt32LE(24).toString(16)}  IconIndex ${b.readInt32LE(56)}  ShowCommand ${b.readUInt32LE(60)}`);

  let off = hs;
  if (flags & 1) {
    const n = b.readUInt16LE(off);
    console.log(`\n-- IDList: ${n} 字节 @${off + 2}`);
    off += 2 + n;
  } else {
    console.log('\n-- 无 IDList');
  }

  if (flags & 2) {
    const n = b.readUInt32LE(off);
    console.log(`-- LinkInfo: ${n} 字节 @${off}, headerSize=0x${b.readUInt32LE(off + 4).toString(16)}`);
    off += n;
  } else {
    console.log('-- 无 LinkInfo');
  }

  for (const [bit, label] of STR_BITS) {
    if (!(flags & (1 << bit))) continue;
    const cnt = b.readUInt16LE(off);
    const s = b.subarray(off + 2, off + 2 + cnt * 2).toString('utf16le');
    console.log(`-- ${label}: count=${cnt} ${JSON.stringify(s)}`);
    off += 2 + cnt * 2;
  }

  console.log(`\n-- ExtraData @${off}`);
  let p = off;
  let guard = 0;
  while (p + 4 <= b.length && guard++ < 32) {
    const size = b.readUInt32LE(p);
    if (size === 0) {
      console.log(`   TerminalBlock 00 00 00 00 @${p}  → 结束，尾部剩 ${b.length - p - 4} 字节`);
      break;
    }
    const sig = b.readUInt32LE(p + 4);
    const name = SIG_NAMES[sig] || '未知';
    console.log(`   @${p}  size=${size}  sig=0x${sig.toString(16)}  ${name}`);
    if (sig === 0xa0000001 || sig === 0xa0000007 || sig === 0xa0000009) {
      // TargetAnsi 260 字节，TargetUnicode 520 字节
      if (size >= 4 + 4 + 260 + 520) {
        const ansi = b.subarray(p + 8, p + 8 + 260).toString('latin1').replace(/\0.*$/, '');
        const uni = b.subarray(p + 8 + 260, p + 8 + 260 + 520).toString('utf16le').replace(/\0.*$/, '');
        console.log(`      ansi=${JSON.stringify(ansi)}`);
        console.log(`      uni =${JSON.stringify(uni)}`);
      } else {
        console.log(`      字节: ${b.subarray(p, Math.min(p + size, p + 60)).toString('hex').replace(/(.{2})/g, '$1 ')}`);
      }
    }
    p += size;
  }
}

for (const f of process.argv.slice(2)) {
  if (fs.existsSync(f)) dump(f);
  else console.log(`跳过：${f}`);
}
