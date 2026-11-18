'use strict';
/*
 * 编译启动器 exe，并把结果放到项目根目录。
 *
 * ## 为什么不留在 bin/ 里
 *
 * 目标就是「双击项目里那个文件就能启动，且它自己带 DS 图标」。
 * 所以产物必须叫 DevSwitch.exe 并躺在项目根目录，和 server.js 同级 ——
 * 启动器用 AppDomain.BaseDirectory 找脚本，它天然就在根目录。
 *
 * ## 为什么用 net48
 *
 * .NET Framework 4.8 是 Windows 10 1903+ / 11 的内置组件，不用额外装运行时；
 * 产物是单个 ~140KB 的 exe。net8 需要另装运行时或 self-contained（几十 MB），
 * 对「双击即用」的本地工具太重。
 *
 * ## 图标是编进 exe 资源段的
 *
 * 由 csproj 的 <ApplicationIcon> 指定，链接器把它写进 PE 的 .rsrc 段。
 * 这才是「文件本身带图标」，不依赖任何快捷方式的 IconLocation。
 *
 * ## 两个 exe 共用一份代码
 *
 * Program.cs 用「自己的文件名里有没有 demo」来决定跑 server.js 还是 start-demo.js。
 * 所以同一份源码编译两次、只改 AssemblyName/AssemblyTitle，就能得到两个入口，
 * 逻辑零重复 —— 以后改启动流程不用改两处。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROJ_DIR = path.join(ROOT, 'launcher');
const PROJ = path.join(PROJ_DIR, 'DevSwitch.csproj');
const ICO = path.join(ROOT, 'devswitch.ico');

/**
 * 要产出的两个入口。
 *
 * assemblyName 是编译时的程序集名（决定中间产物叫啥），
 * outName 是最终摆在根目录的文件名 —— Program.cs 靠这个名字判断是演示版还是正式版，
 * 所以 outName 里的 "Demo" 不能丢。
 */
const TARGETS = [
  {
    assemblyName: 'DevSwitch',
    assemblyTitle: 'DevSwitch',
    outName: 'DevSwitch.exe',
  },
  {
    assemblyName: 'DevSwitchDemo',
    assemblyTitle: 'DevSwitch Demo',
    outName: 'DevSwitch-Demo.exe',
  },
];

/** 从 PATH 和常见位置找 dotnet */
function findDotnet() {
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d.trim()) continue;
    const p = path.join(d.trim(), exe);
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略非法路径 */
    }
  }
  for (const p of [
    'C:\\Program Files\\dotnet\\dotnet.exe',
    'C:\\Program Files (x86)\\dotnet\\dotnet.exe',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 校验 exe 里确实有图标资源。
 *
 * 只检查「编译成功」是不够的 —— 如果 ApplicationIcon 路径写错，MSBuild 会
 * 静默忽略而不是报错，最后得到一个没有图标的 exe。必须查真实字节。
 *
 * 判据：PE 文件里能同时找到
 *   1. ICO 的 256px PNG 帧数据（0x89 'PNG'）
 *   2. 一个 reserved=0 / type=1 / count=N 的 ICONDIR 头
 */
function verifyIconEmbedded(exePath, expectFrames) {
  const buf = fs.readFileSync(exePath);
  const problems = [];

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (buf.indexOf(pngSig) < 0) {
    problems.push('没找到 PNG 帧数据（256px 图标帧），图标可能没编进去');
  }

  let dirFound = false;
  for (let p = 0; p + 6 <= buf.length; p++) {
    if (
      buf[p] === 0 &&
      buf[p + 1] === 0 &&
      buf[p + 2] === 1 &&
      buf[p + 3] === 0 &&
      buf.readUInt16LE(p + 4) === expectFrames
    ) {
      dirFound = true;
      break;
    }
  }
  if (!dirFound) {
    problems.push(`没找到 ${expectFrames} 帧的 ICONDIR 头`);
  }

  return problems;
}

/** 读源 ico 的帧数，用来比对 */
function countIcoFrames(icoPath) {
  const b = fs.readFileSync(icoPath);
  return b.readUInt16LE(4);
}

function main() {
  const dotnet = findDotnet();
  if (!dotnet) {
    console.error('找不到 dotnet。请安装 .NET SDK：https://dotnet.microsoft.com/download');
    process.exit(1);
  }

  if (!fs.existsSync(ICO)) {
    console.error(`找不到 ${ICO}，请先运行 npm run icon`);
    process.exit(1);
  }

  const frames = countIcoFrames(ICO);
  console.log(`编译启动器（net48，图标 ${frames} 帧）…\n`);

  const results = [];

  for (const t of TARGETS) {
    // 每个入口用独立的中间目录，避免两次编译互相覆盖产物
    const tmpOut = path.join(PROJ_DIR, 'bin', t.assemblyName);
    const outExe = path.join(ROOT, t.outName);

    process.stdout.write(`  ${t.outName.padEnd(20)} 编译中… `);

    try {
      execFileSync(
        dotnet,
        [
          'build',
          PROJ,
          '-c',
          'Release',
          '-o',
          tmpOut,
          '--nologo',
          '-v',
          'quiet',
          `-p:AssemblyName=${t.assemblyName}`,
          `-p:AssemblyTitle=${t.assemblyTitle}`,
          // 两个入口的前缀不同，但版本号要显示成各自的名字，
          // 否则「属性 → 详细信息」里两个都写 DevSwitch
          `-p:Product=${t.assemblyTitle}`,
        ],
        { stdio: 'pipe', cwd: ROOT, encoding: 'utf8' }
      );
    } catch (e) {
      console.log('失败');
      const detail = (e.stdout || '') + (e.stderr || '');
      if (detail.trim()) console.error('\n' + detail.trim() + '\n');
      process.exit(1);
    }

    const built = path.join(tmpOut, t.assemblyName + '.exe');
    if (!fs.existsSync(built)) {
      console.log('失败');
      console.error(`\n编译没有产出 exe：${built}`);
      process.exit(1);
    }

    // 覆盖前先删：正在运行的 exe 会被锁定，直接覆盖会报 EBUSY。
    // 但「删」这一步在某些环境下会被替换成「移到回收站」，而回收站
    // 对被占用/被策略限制的文件会失败并抛异常。所以这里不再把删除当成
    // 前置条件 —— 删得掉最好，删不掉就直接尝试覆盖（CopyFile 本身支持覆盖）。
    if (fs.existsSync(outExe)) {
      try {
        fs.unlinkSync(outExe);
      } catch {
        /* 删不掉就交给下面的 copyFileSync 覆盖 */
      }
    }
    try {
      fs.copyFileSync(built, outExe);
    } catch (e) {
      console.log('失败');
      console.error(`\n无法写入 ${outExe}：${e.message}`);
      console.error('如果 DevSwitch.exe 正在运行，请先关掉它的窗口再重试。\n');
      process.exit(1);
    }

    const size = fs.statSync(outExe).size;
    const problems = verifyIconEmbedded(outExe, frames);

    if (problems.length) {
      console.log('图标校验失败');
      for (const p of problems) console.error('    ✗ ' + p);
      process.exit(1);
    }

    console.log(`完成  ${(size / 1024).toFixed(1)} KB  ✓`);
    results.push({ name: t.outName, size });
  }

  console.log('');
  console.log(`图标      ${frames} 帧已编入 PE 资源段`);
  console.log(`运行时    .NET Framework 4.8（Windows 10/11 内置）`);
  console.log(`位置      ${ROOT}`);
  console.log('');
  console.log('注意：图标由 Explorer 缓存，刚编译完可能仍显示旧的。');
  console.log('      看不到新图标就跑 npm run icon:clear 再重开文件夹。');
}

if (require.main === module) main();

module.exports = { findDotnet, verifyIconEmbedded, TARGETS };
