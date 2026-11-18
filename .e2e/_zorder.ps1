
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
[Z]::Dump() | Out-File -FilePath 'C:\\Users\\admin\\AppData\\Local\\Temp\\devswitch-zorder.txt' -Encoding utf8
