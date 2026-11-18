// 窗口 Z 序取证工具
//
// 用途：客观测量某个窗口在顶层窗口 Z 序里的排名，用来验收
// 「启动器点击后，浏览器窗口到底有没有浮到最前面」。
//
// 之前全靠人眼看截图，效率极低而且容易误判；有了 rank 这个数字，
// 「浮起来了」和「还压在下面」就是 1 和 68 的区别，没有解释空间。
//
// 用法：
//   node .e2e/zorder.js            # 只列 DevSwitch 面板窗口的 rank
//   node .e2e/zorder.js --all      # 顺便列出最前面 12 个可见窗口
//
// 实现说明：PowerShell 通过管道输出中文标题时会按系统 ANSI 码页编码，
// 到 node 这边必然乱码，标题匹配就失效了。所以这里让它把结果直接写成
// UTF-8 文件，再由 node 读 —— 少一次编码转换，判定才可靠。

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PS1 = path.join(__dirname, '_zorder.ps1');
const OUT = path.join(os.tmpdir(), 'devswitch-zorder.txt');

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Z {
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);

    public static List<string> Dump() {
        var list = new List<string>();
        IntPtr fg = GetForegroundWindow();
        IntPtr h = GetTopWindow(IntPtr.Zero);
        int rank = 0;
        while (h != IntPtr.Zero && rank < 500) {
            rank++;
            if (IsWindowVisible(h)) {
                var sb = new StringBuilder(512);
                GetWindowTextW(h, sb, 512);
                string title = sb.ToString();
                var cb = new StringBuilder(256);
                GetClassNameW(h, cb, 256);
                string cls = cb.ToString();
                uint pid; GetWindowThreadProcessId(h, out pid);
                int ex = GetWindowLong(h, -20);
                bool topmost = (ex & 0x00000008) != 0;
                bool min = IsIconic(h);
                list.Add(string.Format("{0}\t{1}\t{2}\t{3}\t{4}\t{5}\t{6}",
                    rank, h.ToInt64(), pid, topmost ? 1 : 0, min ? 1 : 0,
                    (h == fg) ? "FOREGROUND" : "-", title + " || " + cls));
            }
            h = GetWindow(h, 2); // GW_HWNDNEXT
        }
        return list;
    }
}
"@
[Z]::Dump() | Out-File -FilePath 'OUTPATH' -Encoding utf8
`.replace('OUTPATH', OUT.replace(/\\/g, '\\\\'));

fs.writeFileSync(PS1, script, 'utf8');

const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1];
execFileSync('powershell.exe', args, { encoding: 'utf8' });

// Out-File -Encoding utf8 在 Windows PowerShell 5.1 里会带 BOM，剥掉
let raw = fs.readFileSync(OUT, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

const rows = raw.split(/\r?\n/).filter(l => l.trim()).map(l => {
  const [rank, hwnd, pid, topmost, min, fg, rest] = l.split('\t');
  return {
    rank: +rank, hwnd: +hwnd, pid: +pid,
    topmost: topmost === '1', min: min === '1', fg: fg === 'FOREGROUND',
    text: rest || '',
  };
});

const showAll = process.argv.includes('--all');

console.log('Z 序排名（1 = 最前面）：\n');

// 只认浏览器窗口上的面板标题 —— VS Code 也会在标题里带上 DevSwitch，
// 那是项目文件名，不是面板。这里必须一起过滤，否则判定全乱。
const panels = rows.filter(r =>
  /DevSwitch|租户切换/.test(r.text) && /Chrome_WidgetWin|MozillaWindowClass|IEFrame/i.test(r.text)
);

// 「普通层排名」才是用户视角真正关心的数字。
//
// 为什要单独算：屏幕上常驻着一批 TOPMOST 置顶窗口（音乐播放器、uTools
// 这类），它们永远压在普通窗口之上，是用户自己选择的结果、也不会挡住
// 我们的面板。如果只看全局 rank，面板窗口会被这 8 个置顶窗口「顶」到
// rank 89，看起来像没浮起来，实际上它在普通窗口层里已经是第一。
//
// 所以：n == 该窗口之前有多少个**非置顶**的可见窗口。
const normalRankOf = (target) => {
  const normalBefore = rows.filter(r => !r.topmost && r.rank < target.rank);
  return normalBefore.length + 1;
};

if (panels.length === 0) {
  console.log('  ✗ 没有 DevSwitch 面板窗口（浏览器里没开着面板页）');
} else {
  for (const p of panels) {
    const hex = '0x' + p.hwnd.toString(16).toUpperCase();
    const n = normalRankOf(p);
    console.log(`  panel  rank=${String(p.rank).padStart(3)}  hwnd=${hex}` +
      (p.topmost ? '  [TOPMOST]' : '') +
      (p.min ? '  [最小化]' : '') +
      (p.fg ? '  <<< FOREGROUND' : ''));
    console.log(`         普通层排名=${n}` + (n === 1 ? '  ✓ 已在所有普通窗口之上' : ''));
    console.log(`         ${p.text.split(' || ')[0]}`);
  }
}

if (showAll) {
  console.log('\n最前面 12 个可见窗口：');
  for (const r of rows.slice(0, 12)) {
    const t = r.text.split(' || ')[0];
    console.log(`  ${String(r.rank).padStart(3)}  ${r.fg ? 'FG' : '  '}${r.topmost ? 'T' : ' '}  ${t.slice(0, 68)}`);
  }
}

console.log(`\n可见顶层窗口总数：${rows.length}`);
