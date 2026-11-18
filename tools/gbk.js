'use strict';
/*
 * GBK 编码器。
 *
 * Node 有 TextDecoder('gbk') 却没有对称的 TextEncoder，所以这里靠反查建表：
 * 遍历 GBK 双字节区间逐个解码，得到「字符 → 字节」的反向映射。
 *
 * 为什么需要 GBK：.lnk 的 EnvironmentVariableDataBlock 里有一段 260 字节的
 * ANSI 路径字段。系统真实样本（Task Manager.lnk 等 35 个）全部填了内容，
 * 老系统读 ANSI、新系统读 Unicode，两边都填才最稳。
 *
 * 实测建表 23939 个有效字符、约 16ms，一次性开销可接受。
 */
const GBK_MAP = (() => {
  const dec = new TextDecoder('gbk');
  const map = new Map();
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      let ch;
      try {
        ch = dec.decode(Uint8Array.of(hi, lo));
      } catch {
        continue;
      }
      if (!ch || ch.length !== 1 || ch === '\ufffd') continue;
      if (!map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  return map;
})();

/** 把字符串编码成 GBK 字节。编不出的字符退化成 '?'，绝不静默吞字。 */
function gbk(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) {
      out.push(c);
    } else {
      const b = GBK_MAP.get(ch);
      if (b) out.push(b[0], b[1]);
      else out.push(0x3f);
    }
  }
  return Buffer.from(out);
}

module.exports = { gbk, GBK_MAP };
