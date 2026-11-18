'use strict';
const fs = require('fs');

const file = process.argv[2];
const b = fs.readFileSync(file);
const expect = process.argv[3];

// 定位 EnvironmentVariableDataBlock：从尾部倒推最稳（它是最后一个块，前面紧邻 TerminalBlock）
// 结构: [..., ENV(788), Terminal(4)]
const envStart = b.length - 4 - 788;
const size = b.readUInt32LE(envStart);
const sig = b.readUInt32LE(envStart + 4);
console.log(`ENV 块起点 ${envStart} size=${size} sig=0x${sig.toString(16)}`);
console.log(`  size 正确: ${size === 788 ? '✓' : '✗'}`);
console.log(`  sig  正确: ${sig === 0xa0000001 ? '✓' : '✗'}`);

const ansiRaw = b.subarray(envStart + 8, envStart + 8 + 260);
const ansiNul = ansiRaw.indexOf(0);
const ansiStr = new TextDecoder('gbk').decode(ansiRaw.subarray(0, ansiNul));
console.log(`\nANSI  @+8    长度 ${ansiNul}   ${JSON.stringify(ansiStr)}`);
console.log(`  GBK 回读一致: ${ansiStr === expect ? '✓' : '✗  期望 ' + JSON.stringify(expect)}`);

const uniRaw = b.subarray(envStart + 8 + 260, envStart + 8 + 260 + 520);
// 注意：UTF-16LE 里每个 ASCII 字符的第二字节都是 0，所以不能用 indexOf(0) 找结尾，
// 必须按 2 字节步进找 00 00。
let uniBytes = 0;
while (uniBytes + 1 < uniRaw.length) {
  if (uniRaw[uniBytes] === 0 && uniRaw[uniBytes + 1] === 0) break;
  uniBytes += 2;
}
const uniStr = uniRaw.subarray(0, uniBytes).toString('utf16le');
console.log(`\nUnicode @+268 字节长 ${uniBytes}   ${JSON.stringify(uniStr)}`);
console.log(`  UTF16 回读一致: ${uniStr === expect ? '✓' : '✗  期望 ' + JSON.stringify(expect)}`);

// 尾部检查
const term = b.readUInt32LE(b.length - 4);
console.log(`\nTerminalBlock @${b.length - 4} = 0x${term.toString(16)} ${term === 0 ? '✓' : '✗'}`);
