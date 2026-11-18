'use strict';
/*
 * 清 Explorer 图标缓存。
 *
 * 为什么必须清：Explorer 按「路径 + 修改时间 + 大小」缓存图标，
 * 但它对 .lnk 的图标缓存格外顽固 —— 换了 IconLocation 指向的 ico 内容、
 * 甚至换了 ico 文件本身，都可能继续显示旧图标，直到缓存被强制失效。
 *
 * 只删 iconcache_*.db 与 thumbcache_*.db；不碰其他任何文件。
 * Explorer 正在运行时会占用这些文件，所以先记录、能删的删，删不掉的报告出来。
 */
const fs = require('fs');
const path = require('path');

const local = process.env.LOCALAPPDATA || '';
const dirs = [
  path.join(local, 'Microsoft', 'Windows', 'Explorer'),
  path.join(local, 'IconCache'),
];

let removed = 0;
let locked = 0;

for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    continue;
  }
  for (const n of names) {
    if (!/^(iconcache|thumbcache)_.*\.db$/i.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      fs.unlinkSync(p);
      console.log(`  已删除 ${n}  (${st.size} 字节)`);
      removed++;
    } catch (e) {
      console.log(`  占用中 ${n}  → ${e.code}`);
      locked++;
    }
  }
}

console.log(`\n删除 ${removed} 个，占用 ${locked} 个`);
if (locked) {
  console.log('有文件被 Explorer 占用。需要完全退出资源管理器后再执行本脚本，');
  console.log('或者直接重启 Explorer（脚本 tools/restart-explorer.js）。');
}
