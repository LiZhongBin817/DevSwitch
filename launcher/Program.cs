using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DevSwitch
{
    /// <summary>
    /// DevSwitch 的图形启动器。
    ///
    /// 为什么要有个 exe：.bat 的图标由「扩展名 → 图标」的全局映射决定，
    /// 所有 .bat 共用 CMD 的齿轮图标，系统层面没有给单个 .bat 换图标的手段。
    /// 只有可执行文件能把图标编进自己的资源段，所以启动入口做成 exe。
    ///
    /// 行为：
    ///   1. 检查 Node
    ///   2. 以脚本所在目录为工作目录启动 server.js
    ///   3. **等端口真的能连上了，由启动器自己去打开浏览器**
    ///   4. 退出码 2 = 面板已在运行，静默退出（不再让用户按键）
    ///   5. 其他非 0 = 出错，把真实原因显示在窗口里
    ///
    /// ## 为什么「打开浏览器」从 node 挪到了这里
    ///
    /// 原先由 server.js 里的 openPanelInBrowser() 负责。那条链是：
    ///   DevSwitch.exe → node.exe → spawn(浏览器)
    /// 在部分机器上这条链会**静默断掉**：进程创建看起来成功、日志里也没有任何
    /// 「打开失败」，但浏览器就是不出来。而 node 那边又只能靠一个 /__open 探针
    /// 判断成败，探针一旦被代理或安全软件拦掉，就变成「明明开了却报没开」。
    ///
    /// 所以改成本进程直接用 ShellExecute 打开。
    ///
    /// ## 但「打开」不等于「看得见」
    ///
    /// 曾经这里以「Process.Start 没抛异常」就判定成功并打印「✓ 已在浏览器中打开」，
    /// 而用户屏幕上什么都没有 —— 请求确实发出去了，只是被交给了浏览器的一个
    /// 已有实例（最小化的、或在后台的），于是「发出去」变成了「看不见」。
    ///
    /// 现在改用**窗口句柄**做判据：用 EnumWindows 找一个标题同时含
    /// "DevSwitch" 和 "租户切换" 的顶层窗口（那正是 index.html 的 title），
    /// 找到之后再 ShowWindow/SetForegroundWindow 把它拉到前台。
    /// 这样「成功」这个字样是有实据的，而且顺手解决了「窗口在后面」的问题。
    /// 两轮都找不到窗口就如实说没打开、把地址打出来，绝不谎报。
    ///
    /// ## 为什么要先等端口
    ///
    /// 浏览器比服务先起来的话，用户第一眼看到的是「无法访问此网站」，
    /// 得手动刷新一次才知道其实起来了。所以这里先探 TCP，通了再开。
    /// </summary>
    internal static class Program
    {
        /// <summary>与 server.js 里的 EXIT_ALREADY_RUNNING 对应</summary>
        private const int ExitAlreadyRunning = 2;

        /// <summary>与 server.js 里的默认端口保持一致</summary>
        private const int DefaultPort = 4599;

        /// <summary>
        /// 启动器日志文件。
        ///
        /// 为什么需要它：这个 exe 一出问题就是「双击后窗口一闪」
        /// 或者「一句看不出原因的话」，没有任何可查的痕迹。
        /// 写一份日志到用户目录，出问题时能直接看，不用靠猜。
        /// 放在 LocalAppData 而不是程序目录：程序目录可能在只读位置。
        /// </summary>
        private static string _logPath;
        private static bool _logReady;

        [STAThread]
        private static int Main(string[] args)
        {
            // 最外层兜底：任何未预料的异常都要留下可读原因。
            //
            // 之前这里没有兜底，出问题时窗口里只有一句
            // 「由于 Exception.ToString() 失败，因此无法打印异常字符串」——
            // 连异常类型都没有，等于什么都没说。而那句话本身就是
            // 「连 ToString() 都炸了」的兜底文案，说明原始异常带不出来。
            // 所以这里不但要 catch，还要用逐项取值的 SafeDescribe 去拼描述，
            // 因为 ex.Message 本身也可能是抛异常的源头。
            try
            {
                return Run(args);
            }
            catch (Exception ex)
            {
                string info = SafeDescribe(ex);
                Log("FATAL " + info);
                try
                {
                    Console.Error.WriteLine();
                    Console.Error.WriteLine("  [X] 启动器异常");
                    Console.Error.WriteLine();
                    foreach (string line in info.Split('\n'))
                    {
                        Console.Error.WriteLine("      " + line);
                    }
                    if (_logReady)
                    {
                        Console.Error.WriteLine();
                        Console.Error.WriteLine("      日志：" + _logPath);
                    }
                    Console.Error.WriteLine();
                }
                catch
                {
                    // 连 stderr 都写不了（无控制台），那就只剩日志了
                }
                Pause();
                return 1;
            }
        }

        private static int Run(string[] args)
        {
            InitLog();

            try
            {
                Console.OutputEncoding = Encoding.UTF8;
            }
            catch
            {
                // 输出重定向时设置编码可能抛异常。编码设不上只是中文可能不好看，
                // 不该让程序崩。
            }

            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

            // 同一个启动器要支撑两个入口：正式版跑 server.js，演示版跑 start-demo.js。
            // 用 exe 自己的文件名区分 —— 谁被双击就按谁的名字决定跑哪个脚本。
            string selfName = SelfName();
            bool isDemo = selfName.IndexOf("demo", StringComparison.OrdinalIgnoreCase) >= 0;

            try
            {
                Console.Title = isDemo ? "DevSwitch Demo" : "DevSwitch";
            }
            catch
            {
                // 没有控制台（被重定向/被别的程序捕获）时会抛，忽略即可
            }

            string scriptName = isDemo ? "start-demo.js" : "server.js";
            string script = Path.Combine(root, scriptName);

            if (!File.Exists(script))
            {
                return Fail(
                    "找不到 " + scriptName,
                    "这个启动器必须和项目文件放在同一个目录里。",
                    "缺失的文件：\n" + script);
            }

            string node = FindNode();
            if (node == null)
            {
                return Fail(
                    "没有找到 Node.js",
                    "请先安装 Node.js 18 或更新版本，然后重新双击本程序。",
                    "下载地址：https://nodejs.org  （装 LTS 版本即可）");
            }

            int port = ResolvePort();
            string url = "http://127.0.0.1:" + port + "/";

            Log("start node=" + node + " script=" + script + " port=" + port);

            // 用命令行参数告诉 node「浏览器这边自己会开，你别管」，
            // **绝对不要用 psi.EnvironmentVariables 传** —— 见下面的血泪注释。
            var psi = new ProcessStartInfo(node, "\"" + script + "\" --no-browser")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                // 不重定向输出：子进程直接写到这个控制台窗口，
                // 保持和 .bat 一样能看到服务日志
            };

            // ⚠ 这里曾经有一行 psi.EnvironmentVariables["OPEN_BROWSER"] = "1"，
            //   它在这台机器上直接把启动器炸了，报：
            //
            //     System.ArgumentException
            //     已添加项。字典中的关键字:"HTTPS_PROXY"所添加的关键字:"https_proxy"
            //       在 System.Diagnostics.ProcessStartInfo.get_EnvironmentVariables()
            //
            //   原因：很多代理软件会同时设 HTTPS_PROXY 和 https_proxy（大小写两个），
            //   Windows 环境块允许这种重复；而 .NET Framework 的 EnvironmentVariables
            //   内部是**大小写不敏感**的 Hashtable，装载时遇到这对键就抛异常。
            //   更狠的是这个异常发生在 getter 里 —— 光是**读**一下就崩，
            //   连 try/catch 包住赋值都没用（除非包住 getter 本身）。
            //
            //   后果非常隐蔽：exe 在启动 node 之前就死了，node 从来没跑起来，
            //   浏览器自然也不会开。用户看到的就是「双击了，什么都没发生」。
            //
            //   所以现在完全不碰 EnvironmentVariables —— 改用命令行参数，
            //   这条路径不经过任何环境块处理，环境变量再脏也不影响。

            // 把控制台里按下 Ctrl+C 的信号转给子进程，行为与 .bat 一致
            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
            {
                e.Cancel = true;
                // 交给子进程自己处理退出，这里不强行终止
            };

            Process child;
            try
            {
                child = Process.Start(psi);
            }
            catch (Exception ex)
            {
                return Fail("启动 Node 失败", ex.Message, null);
            }

            if (child == null)
            {
                return Fail("启动 Node 失败", "进程没有成功创建。", null);
            }

            Log("node started pid=" + SafePid(child));

            // 等端口真的能连上再开浏览器。
            // 15 秒是个宽松上限：正常启动只要几十到几百毫秒，
            // 但机器忙、杀软扫描、Node 首次冷启动都可能慢一些。
            // 传入 child 是为了「node 提前挂了就别再傻等」——
            // 否则脚本报错时用户要对着黑窗口干等 15 秒。
            bool up = WaitForPort(port, 15000, child);
            Log("port " + port + " listening=" + up);

            if (up)
            {
                string ok = OpenBrowser(url);
                if (ok != null)
                {
                    try
                    {
                        Console.WriteLine();
                        Console.WriteLine("  ✓ " + ok);
                        Console.WriteLine();
                    }
                    catch
                    {
                        // 无控制台，忽略
                    }
                }
                else
                {
                    // 实在开不出来：不要假装成功，直接把地址摆出来。
                    // 用户复制粘贴一次就能用，比一句骗人的「已打开」有用得多。
                    PrintManual(url, "没能自动打开浏览器（试过系统关联和新窗口两种方式）");
                }
            }
            else
            {
                PrintManual(url, "服务还没起来，浏览器没有自动打开");
            }

            child.WaitForExit();
            int code = child.ExitCode;
            Log("node exited code=" + code);

            // 2 = 已经有实例在跑，它已经把面板给你了。
            // 这种情况不该让人再按一次键，直接安静退出。
            if (code == ExitAlreadyRunning)
            {
                return ExitAlreadyRunning;
            }

            if (code != 0)
            {
                Console.WriteLine();
                Console.WriteLine("  [DevSwitch] 退出码 " + code);
                Console.WriteLine();
                Console.WriteLine("  如果提示端口被占用，要么：");
                Console.WriteLine("    1) 关掉占用端口的程序，再运行一次");
                Console.WriteLine("    2) 换个端口：set PORT=5000  然后再运行");
                Console.WriteLine();
                Console.WriteLine("  如果你是自己关窗口或按了 Ctrl+C，那属正常，可以忽略上面的提示。");
                Pause();
                return code;
            }

            Console.WriteLine();
            Console.WriteLine("  [DevSwitch] 已停止。");
            Console.WriteLine();
            Pause();
            return 0;
        }

        // ───────────────────────── 打开浏览器 ─────────────────────────

        /// <summary>
        /// 面板页面的标题特征。index.html 的 &lt;title&gt; 是
        /// 「DevSwitch · 本地登录 / 租户切换」，浏览器窗口标题会在后面拼上
        /// 「 - Google Chrome」这类后缀。
        ///
        /// 用它当判据的好处：只有浏览器真的把这个页面显示出来了，才会出现这个标题。
        /// 页面没加载成功时（服务没起来 / 连接被拒），浏览器显示的是自己的错误页，
        /// 标题是「127.0.0.1」之类，不含这两个词 —— 所以它能顺带证明
        /// 「服务确实连上了」。
        ///
        /// 光靠标题还不够：实测 VS Code 打开本项目时，窗口标题
        /// 「DevSwitch-Demo.bat - dev-switch - Visual Studio Code」
        /// 也含 "DevSwitch"。所以 FindPanelWindows 里还有一道
        /// 「必须是浏览器进程」的过滤，见 IsBrowserWindow。
        /// </summary>
        private const string TitleMarkA = "DevSwitch";
        private const string TitleMarkB = "租户切换";

        /// <summary>
        /// 打开面板，并且**确认它真的出现在屏幕上**。
        ///
        /// ## 我们到底在跟什么较劲
        ///
        /// 这台机器上实测出的三种情况（都有日志/计数为证）：
        ///
        /// | 方式                          | 窗口数变化 |
        /// |-------------------------------|-----------|
        /// | shell 关联（默认 profile）      | 2 → 2     |
        /// | chrome.exe --new-window        | 2 → 2     |
        /// | 独立 --user-data-dir + 新窗口   | 2 → 3 ✓   |
        ///
        /// 前两种为什么不动：默认 profile 的 Chrome 主进程是带着
        /// `--single-argument &lt;某个 git 地址&gt;` 启动的，这类实例对后续的
        /// 开窗请求会**静默丢弃** —— 不报错、不开窗、什么都不发生。
        ///
        /// 但独立 user-data-dir 这条路**不能用**：本工具的核心就是
        /// Cookie 写进 localhost / 127.0.0.1，让业务页面共享登录态；
        /// 换个 profile 就等于换了个浏览器，业务页面还是没登录。
        /// 为了「能看见」而牺牲主功能，是捡芝麻丢西瓜。
        ///
        /// ## 所以真正要解决的是「窗口已经在，但看不见」
        ///
        /// 请求其实是生效的 —— 页面已经在那个实例里打开了。
        /// 用户看不见是因为窗口在后台/最小化，而 Windows 有**前台锁**：
        /// 只有当前前台进程（或刚收到用户输入的进程）才允许抢焦点，
        /// 否则 SetForegroundWindow 直接返回 false（日志里
        /// `foregroundNow=0` 就是它被拒的样子）。
        ///
        /// 标准解法是先模拟一次 Alt 键按下/抬起 —— 系统据此认为
        /// 「用户有输入动作」，从而释放前台锁，之后再抢焦点就能成功。
        /// 这不是歪门邪道，是长期被各类启动器使用的公开做法。
        /// </summary>
        private static string OpenBrowser(string url)
        {
            IntPtr[] before = FindPanelWindows();
            Log("panel windows before=" + before.Length);

            IntPtr hwnd = IntPtr.Zero;
            bool isNew = false;

            // ① 首选的打开方式：走浏览器的远程调试接口（CDP）。
            //
            //    为什么把它排第一 —— 这是本机唯一实测能真正把页面送到用户眼前的
            //    通道。这台机器的 Chrome 带着自定义 profile + 调试端口在跑：
            //
            //        chrome.exe --remote-debugging-port=9222 \
            //                   --user-data-dir="C:\PersonalCustom\..."
            //
            //    在这种配置下：
            //      · shell 关联（Process.Start(url)）→ 请求被静默丢弃，无任何变化
            //      · chrome.exe --new-window URL     → 同样被丢弃（profile 对不上）
            //      · CDP PUT /json/new?URL           → **标签页立刻出现，标题正确** ✓
            //
            //    而且 CDP 走的是 HTTP，不碰窗口焦点、不需要抢前台，
            //    连锁屏状态下都能把页面建出来。
            bool viaCdp = CdpOpenPanel(url, before);
            Log("open via CDP=" + viaCdp);

            if (viaCdp)
            {
                // CDP 是在**已有的 Chrome 窗口里**开/激活标签页，窗口句柄不变，
                // 所以不能等「新窗口」，只能等那个窗口的标题变成面板标题。
                hwnd = WaitForPanelTab(before, 4000);
                isNew = false;
                if (hwnd != IntPtr.Zero)
                {
                    Log("CDP panel tab live in window hwnd=" + hwnd);
                }
            }

            // ② 没有调试端口（普通用户的常态）：点名浏览器 exe 开新窗口。
            //
            //    关键是要带上那个实例真实的 --user-data-dir —— 否则请求会被
            //    静默丢弃（详见 ForceNewWindow 的说明）。
            if (hwnd == IntPtr.Zero)
            {
                Log("CDP not available, trying force new window");
                if (ForceNewWindow(url))
                {
                    if (before.Length > 0)
                    {
                        // 已经有面板窗口：浏览器会把 URL 交给它，窗口句柄不变
                        hwnd = WaitForPanelTab(before, 4000);
                    }
                    else
                    {
                        hwnd = WaitForNewPanelWindow(before, 8000);
                        isNew = hwnd != IntPtr.Zero;
                    }
                    if (hwnd != IntPtr.Zero)
                    {
                        Log("panel window after force-new-window hwnd=" + hwnd);
                    }
                }
            }

            // ③ 最后退回 shell 关联（最保守的一条路）。
            if (hwnd == IntPtr.Zero)
            {
                Log("fallback to shell open");
                ShellOpen(url);
                if (before.Length > 0)
                {
                    hwnd = WaitForPanelTab(before, 4000);
                }
                else
                {
                    hwnd = WaitForNewPanelWindow(before, 6000);
                    isNew = hwnd != IntPtr.Zero;
                }
                if (hwnd != IntPtr.Zero)
                {
                    Log("panel window after shell open hwnd=" + hwnd);
                }
            }

            if (hwnd == IntPtr.Zero)
            {
                Log("browser open FAILED - no panel window at all");
                return null;
            }

            // 复用已有窗口时，先确保它没有被最小化 —— 一个收在任务栏里的窗口，
            // SetForegroundWindow 未必能把它浮上来，用户看到的仍是「什么都没发生」。
            if (!isNew && IsIconic(hwnd))
            {
                Log("existing panel window is minimized, restoring");
                ShowWindow(hwnd, SwShowMaximized);
                Thread.Sleep(150);
            }

            bool front = ForceForeground(hwnd, 5000);
            Log("panel hwnd=" + hwnd + " new=" + isNew + " foreground=" + front);

            if (front)
            {
                return isNew
                    ? "已在浏览器中打开 " + url
                    : "面板已在浏览器中打开，已切到前台";
            }

            // 窗口确实存在、也确实渲染了页面，但系统始终不肯把前台给它。
            // 这种情况已经走完 LiftToTop 兜底 —— 窗口此刻在 Z 序最前面、肉眼可见，
            // 只是焦点不在它身上（Windows 前台锁的硬限制，启动器无权强制）。
            // 所以文案要说「已经浮到前面、点一下就能用」，而不是含糊的「没切到前台」。
            return isNew
                ? "已在浏览器中打开 " + url + "（窗口已置前，点一下即可操作）"
                : "面板已显示在最前面，点一下即可操作";
        }

        /// <summary>
        /// 把窗口真正变成**前台窗口**，并且以 `GetForegroundWindow()` 为唯一判据。
        ///
        /// ## 为什么不能信 API 的返回值
        ///
        /// 之前的写法是 `if (SetForegroundWindow(hwnd)) return true;`，
        /// 然后打印「✓ 已在浏览器中打开」。但实测证明这条判据是假的：
        /// 日志里明明写着 `activate: ok on first try`，用户屏幕上却什么都没有。
        ///
        /// 用 EnumWindows + PrintWindow 做的取证还原了真相 ——
        /// 面板窗口一直在，`IsWindowVisible=True`、`IsIconic=False`、
        /// `DwmGetWindowAttribute(CLOAKED)=0`，Page 也渲染得完完整整，
        /// 唯独 `GetForegroundWindow()` 指向的是别人的窗口，Z 序上它被压在下面。
        ///
        /// 也就是说：`SetForegroundWindow` 返回 true 只代表**请求被受理**，
        /// 不代表窗口真的浮上来了。Windows 的前台锁（foreground lock）
        /// 会让它在不报错的情况下被静默降级 —— 这正是「谎报」的根源。
        ///
        /// ## 所以这里改成「多策略 + 轮询验证」
        ///
        /// 每一轮换一种手段，每次都用 `GetForegroundWindow() == hwnd` 验收。
        /// 全都不成才算失败，失败时调用方会如实说「没能切到前台」。
        ///
        /// 最后那一招「最小化自己的控制台」是关键：双击 exe 时，
        /// 黑窗口本身就是占满屏幕的那个前台窗口，浏览器开出来正好被它挡住。
        /// 把控制台收进任务栏，浏览器自然就露出来了 —— 用户要的正是这个效果。
        /// </summary>
        private static bool ForceForeground(IntPtr hwnd, int totalMs)
        {
            IntPtr console = GetConsoleWindow();
            Stopwatch sw = Stopwatch.StartNew();
            int round = 0;

            while (sw.ElapsedMilliseconds < totalMs)
            {
                round++;

                if (GetForegroundWindow() == hwnd)
                {
                    Log("foreground ok round=" + round);
                    return true;
                }

                // 最小化的窗口先恢复。用 SW_SHOWMAXIMIZED 而不是 SW_RESTORE：
                // 实测 SW_RESTORE 会把原本最大化的窗口缩成普通大小（用户看到的是
                // 一个突兀的小窗），而面板本来就是最大化用的。
                if (IsIconic(hwnd))
                {
                    ShowWindow(hwnd, SwShowMaximized);
                    Thread.Sleep(120);
                }

                // ① 直接抢 —— 多数情况下（启动器刚被双击，算「刚收到用户输入」）这里就成
                SetForegroundWindow(hwnd);
                if (WaitForeground(hwnd, 250)) { Log("fg via SetForegroundWindow"); return true; }

                // ② 借当前前台线程的输入队列，绕过前台锁
                AttachAndActivate(hwnd);
                if (WaitForeground(hwnd, 250)) { Log("fg via AttachThreadInput"); return true; }

                // ③ 老 API，前台锁放开后它通常还能奏效
                SwitchToThisWindow(hwnd, true);
                if (WaitForeground(hwnd, 250)) { Log("fg via SwitchToThisWindow"); return true; }

                // ④ 模拟 Alt —— 系统据此认为「用户有操作」，临时解开前台锁
                PressAlt();
                Thread.Sleep(80);
                SetForegroundWindow(hwnd);
                if (WaitForeground(hwnd, 250)) { Log("fg via Alt unlock"); return true; }

                // ⑤ 收掉自己的控制台。双击场景下，**这一招往往才是决定性的**：
                //    挡在前面的不是别的程序，正是我们自己那个黑窗口。
                if (console != IntPtr.Zero && GetForegroundWindow() == console)
                {
                    Log("console is foreground and blocking, minimizing it");
                    ShowWindow(console, SwMinimize);
                    Thread.Sleep(120);
                    SetForegroundWindow(hwnd);
                    if (WaitForeground(hwnd, 300)) { Log("fg via console minimize"); return true; }
                }

                // ⑥ 改 Z 序：把窗口抬到普通层最前面。
                //
                //    前三轮都抢不到焦点时**不要继续空转**（实测每一轮都失败，
                //    白白耗掉几秒，用户看到的是「点了没反应」）。这里直接改
                //    Z 序 —— 它不受前台锁管辖，能立刻让窗口出现在眼前。
                //
                //    先抬起、再继续尝试抢焦点：抬起是马上能看到的效果，
                //    焦点能不能给是次要的（用户点一下就正常了）。
                //
                //    round 的限制很关键：LiftToTop 里要枚举 700 多个窗口，
                //    本身要几十毫秒，每轮都做会把二维码变成秒级的等待。
                //    只在第一轮做一次就够 —— Z 序不会因为我们后面的尝试而变差。
                if (round == 1)
                {
                    LiftToTop(hwnd);
                    if (WaitForeground(hwnd, 200))
                    {
                        Log("fg via LiftToTop");
                        return true;
                    }

                    // 抬起这一步行了（窗口已经在普通层最前面、肉眼可见），
                    // 但焦点没抢到 —— 这时候**必须立刻收工**，不能再来四轮。
                    //
                    // 实测：这台机器上前五招 100% 失败，继续轮询只会让启动器
                    // 多卡 5 秒才打印结果，用户那边窗口早就看见了，纯粹是白等。
                    // 焦点抢不到是 Windows 前台锁的硬限制，不是重试能解决的。
                    if (CountNormalWindowsAbove(hwnd) == 0)
                    {
                        Log("window is on top already, giving up on focus (foreground lock)");
                        return false;
                    }
                }

                Thread.Sleep(150);
            }

            return false;
        }

        /// <summary>
        /// 调整窗口的 Z 序，让它浮到「普通窗口」那一层的最前面。
        ///
        /// ## 为什么这一招比抢焦点更靠谱
        ///
        /// 前面五招都在争夺「前台窗口」这个身份（`GetForegroundWindow()` 指向它），
        /// 而 Windows 的前台锁会让这些尝试**静默失败** —— 实测日志里
        /// SetForegroundWindow 返回 true、AttachThreadInput、SwitchToThisWindow、
        /// 模拟 Alt 全部无效，前台窗口始终指向别人。
        ///
        /// 但用户真正要的是「**看得见**」，不是「能直接打字」。`SetWindowPos`
        /// 走的是另一条路 —— 改 Z 序，不受前台锁管辖。
        ///
        /// ## 为什么用 HWND_TOP 而不是置顶
        ///
        /// 实测数据（同一窗口）：
        ///
        /// | 操作                      | 窗口在 Z 序中的位置 |
        /// |---------------------------|-------------------|
        /// | 初始（被两个窗口压住）      | 普通层第 3        |
        /// | 置顶 HWND_TOPMOST          | 全局第 1（到顶）   |
        /// | 取消置顶 HWND_NOTOPMOST     | 退回普通层第 3    |
        /// | **HWND_TOP（本方法）**      | **普通层第 1** ✓  |
        ///
        /// 第三行就是「置顶再取消」为什么无效：`HWND_NOTOPMOST` 只把窗口
        /// 从置顶层放回普通层，**不改变它在普通层里的相对位置**，于是又回到
        /// 原来那两个窗口下面 —— 用户眨一次眼就错过了中间那一瞬。
        ///
        /// 而 `HWND_TOP` 直接要求「放到本层最前面」，一次到位、不需要后续取消，
        /// 不会像保持置顶那样一直挡在任务管理器、密码框前面。
        ///
        /// ## 为什么不能信 SetWindowPos 的返回值
        ///
        /// 实测：`SetWindowPos(HWND_TOP)` 返回 **False**，但用 EnumWindows
        /// 数 Z 序时窗口**确实已经在普通层第一位**了。这个 API 的返回值
        /// 在这里不可靠（大概率是被 SWP_NOACTIVATE 影响），
        /// 所以判据必须换成实测 Z 序，不能拿返回值当结论 ——
        /// 否则会出现「明明浮起来了却被当成失败、又去做多余的置顶」。
        /// </summary>
        private static void LiftToTop(IntPtr hwnd)
        {
            try
            {
                Log("raising window to top of normal band (HWND_TOP)");
                SetWindowPos(hwnd, HwndTop, 0, 0, 0, 0,
                    SwpNomove | SwpNosize | SwpNoactivate);

                // 用实测 Z 序判定成败：数一数在它前面还有几个**非置顶**的可见窗口。
                // 0 个就说明它已经是普通层最前面，目的达到。
                int ahead = CountNormalWindowsAbove(hwnd);
                Log("normal-band windows above=" + ahead);

                if (ahead > 0)
                {
                    // 真没抬起来（极少见：shell 层级异常）。退到置顶保持 ——
                    // 它一定能让窗口出现在最前，代价是会盖住置顶类程序，
                    // 所以只在 HWND_TOP 实测失败时用。
                    Log("HWND_TOP did not raise (ahead=" + ahead + "), falling back to topmost hold");
                    LiftToTopAndHold(hwnd);
                }
            }
            catch (Exception ex)
            {
                Log("LiftToTop failed: " + SafeMessage(ex));
            }
        }

        /// <summary>
        /// 数一数目标窗口前面还有几个**非置顶**的可见顶层窗口。
        /// 返回 0 表示它已经是普通窗口层里的第一个。
        ///
        /// 为什么要排除置顶层：屏幕上常驻着音乐播放器、uTools 这类
        /// 用户主动置顶的窗口，它们永远在普通窗口之上，且不会挡住我们的面板。
        /// 把它们算进来会让「已经浮到最前」被误判成「还压在下面」。
        /// </summary>
        private static int CountNormalWindowsAbove(IntPtr target)
        {
            int ahead = 0;
            IntPtr h = GetTopWindow(IntPtr.Zero);
            int guard = 0;
            while (h != IntPtr.Zero && guard++ < 600)
            {
                if (h == target) return ahead;

                if (IsWindowVisible(h))
                {
                    int ex = GetWindowLong(h, GwlExstyle);
                    bool topmost = (ex & WsExTopmost) != 0;
                    if (!topmost)
                    {
                        ahead++;

                        // 把压在面板上面的窗口记下来。
                        //
                        // 只记个数的话，「ahead=1」完全无法区分两种情况：
                        //   a) 真有别的程序窗口盖住了面板 —— 需要抬升
                        //   b) 那是浏览器自己的另一个窗口/浮动层 —— 抬升也没用
                        // 这两种情况处理方式完全不同，所以必须看到名字。
                        // 只记前 3 个，避免日志被刷爆。
                        if (ahead <= 3)
                        {
                            Log("  above#" + ahead + " hwnd=" + h
                                + " class=" + SafeClassName(h)
                                + " title=" + SafeTitle(h));
                        }
                    }
                }
                h = GetWindow(h, GwHwndnext);
            }
            return ahead;
        }

        /// <summary>读窗口类名，失败返回空串。只是诊断用，不抛异常。</summary>
        private static string SafeClassName(IntPtr hwnd)
        {
            try
            {
                var sb = new StringBuilder(256);
                int n = GetClassNameW(hwnd, sb, sb.Capacity);
                return n > 0 ? sb.ToString() : "";
            }
            catch
            {
                return "";
            }
        }

        /// <summary>读窗口标题，失败返回空串。只是诊断用，不抛异常。</summary>
        private static string SafeTitle(IntPtr hwnd)
        {
            try
            {
                int len = GetWindowTextLengthW(hwnd);
                if (len <= 0) return "";
                var sb = new StringBuilder(len + 2);
                GetWindowTextW(hwnd, sb, sb.Capacity);
                string t = sb.ToString();
                // 标题可能很长（浏览器标签标题），截断防止刷屏
                return t.Length > 60 ? t.Substring(0, 60) + "…" : t;
            }
            catch
            {
                return "";
            }
        }

        /// <summary>
        /// 把窗口推到 Z 序最顶层并**保持住**，直到用户点它或 30 秒超时。
        ///
        /// 这是 `LiftToTop` 的兜底路径，只在 `HWND_TOP` 被系统拒绝时才会走到。
        /// 「置顶再马上取消」实测对用户无效（见 LiftToTop 里的 Z 序表），
        /// 所以只能保持；而保持会盖住一切窗口，因此必须给了断条件：
        /// 用户点了它（成为前台窗口）就立刻取消，或者最多 30 秒。
        /// 用户的正常路径是「看到窗口 → 点一下 → 开始用」，点的那一下就解除了。
        /// </summary>
        private static void LiftToTopAndHold(IntPtr hwnd)
        {
            try
            {
                Log("lifting window to topmost (hold)");
                SetWindowPos(hwnd, HwndTopmost, 0, 0, 0, 0,
                    SwpNomove | SwpNosize | SwpNoactivate);
            }
            catch (Exception ex)
            {
                Log("LiftToTopAndHold failed: " + SafeMessage(ex));
                return;
            }

            // 后台线程负责收尾：用户点过它、或超过 30 秒，就取消置顶。
            // 用独立线程而不是在这里 Sleep —— 主线程还要往下走去打印提示、
            // 等 node 进程退出，不能为了收尾把整个启动流程卡住 30 秒。
            Thread t = new Thread(delegate()
            {
                try
                {
                    Stopwatch sw = Stopwatch.StartNew();
                    while (sw.ElapsedMilliseconds < 30000)
                    {
                        // 用户已经点到它了：目的达成，恢复普通层级
                        if (GetForegroundWindow() == hwnd)
                        {
                            Log("panel became foreground, releasing topmost");
                            break;
                        }
                        Thread.Sleep(250);
                    }

                    SetWindowPos(hwnd, HwndNotopmost, 0, 0, 0, 0,
                        SwpNomove | SwpNosize | SwpNoactivate);
                    Log("topmost released");
                }
                catch (Exception ex)
                {
                    Log("topmost release failed: " + SafeMessage(ex));
                }
            });
            t.IsBackground = true;   // 不阻止进程退出
            t.Start();
        }

        /// <summary>轮询等前台窗口变成目标，最多等 ms 毫秒。</summary>
        private static bool WaitForeground(IntPtr hwnd, int ms)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                if (GetForegroundWindow() == hwnd) return true;
                Thread.Sleep(30);
            }
            return GetForegroundWindow() == hwnd;
        }

        /// <summary>
        /// 把目标窗口挂到当前前台线程的输入队列上再抢焦点。
        ///
        /// 前台锁的判定依据是「调用线程所在的输入队列是否为前台队列」，
        /// AttachThreadInput 之后我们的线程就并进了前台队列，于是 SetForegroundWindow
        /// 不再被拒。用完必须解绑，否则会拖累前台线程的输入处理。
        /// </summary>
        private static void AttachAndActivate(IntPtr hwnd)
        {
            uint fgThread = 0;
            uint myThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                IntPtr fg = GetForegroundWindow();
                fgThread = GetWindowThreadProcessId(fg, out _);
                if (fgThread != 0 && fgThread != myThread)
                {
                    attached = AttachThreadInput(myThread, fgThread, true);
                }
                BringWindowToTop(hwnd);
                SetForegroundWindow(hwnd);
            }
            catch
            {
                // 抢焦点失败不影响「页面已经打开」这个事实
            }
            finally
            {
                if (attached)
                {
                    try { AttachThreadInput(myThread, fgThread, false); } catch { }
                }
            }
        }

        /// <summary>交给系统 shell 处理这个 URL（等价于「运行」里粘贴地址回车）。</summary>
        private static bool ShellOpen(string url)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(url);
                psi.UseShellExecute = true;
                Process p = Process.Start(psi);
                // 复用已有实例时 p 是 null，这是正常的，不能据此判失败
                Log("shell open ok pid=" + SafePid(p));
                return true;
            }
            catch (Exception ex)
            {
                Log("shell open failed: " + SafeDescribe(ex));
                return false;
            }
        }

        // ─────────────────── 浏览器远程调试接口（CDP）通道 ───────────────────

        /// <summary>
        /// 通过浏览器的远程调试接口把面板打开/激活到最前面。
        ///
        /// ## 为什么需要这条路（本机实测的唯一可行通道）
        ///
        /// 这台机器的 Chrome 是这样起来的：
        ///
        ///     chrome.exe --remote-debugging-port=9222 \
        ///                --user-data-dir="C:\PersonalCustom\chromeRemoteDebugProfile"
        ///
        /// 它用的是**自定义 profile**。Chrome 的行为是：后来启动的进程如果
        /// profile 与已在运行的实例不一致，就把 URL 请求**静默丢弃** ——
        /// 不报错、不开窗、任务管理器里进程数一个都不变。
        ///
        /// 同一台机器上的实测对比（这是本轮排查的决定性证据）：
        ///
        /// | 方式                                        | 结果 |
        /// |---------------------------------------------|------|
        /// | shell 关联 Process.Start(url)                | 无任何窗口变化 |
        /// | chrome.exe --new-window URL（不带 profile）  | 进程数 39 → 39，无新标签页 |
        /// | **CDP PUT /json/new?URL**                    | **标签页立刻出现，标题正确** ✓ |
        ///
        /// 所以：浏览器开着调试端口时，CDP 是唯一能把页面真正送进去的通道。
        ///
        /// ## 三个细节，踩过才知道
        ///
        /// 1) **必须用 PUT**。Chrome 111 之后 GET 被禁，用 GET 会返回
        ///    "Using unsafe HTTP verb GET to invoke /json/new"。
        ///
        /// 2) **必须 req.Proxy = null**。这台机器上有系统代理
        ///    （http_proxy=127.0.0.1:55152），走代理时请求会被拿去「解析」
        ///    127.0.0.1 然后 502。调试端口只监听回环，绝不能过代理。
        ///
        /// 3) **不要每次都新开标签页**。用户双击的意图是「让我看到面板」，
        ///    不是「再给我堆一个标签页」。实测连续双击会堆到 4 个。所以先看
        ///    /json/list 里有没有现成的面板标签页：有就激活它；没有才新建。
        ///
        /// ## 端口从哪来
        ///
        /// 先读浏览器进程命令行里的 --remote-debugging-port（最准），
        /// WMI 读不到就探测常见端口。都没有就返回 false，让调用方走别的路。
        /// </summary>
        private static bool CdpOpenPanel(string url, IntPtr[] before)
        {
            int port = FindDebugPort();
            if (port <= 0)
            {
                Log("CDP: no debug port found, skipping");
                return false;
            }

            Log("CDP: using debug port " + port);

            // ① 先看有没有已经开着的面板标签页。
            //
            //    判据比 URL 前缀更严格一点：必须真的是本工具的面板地址。
            //    光比 "127.0.0.1:4599" 会误伤带查询串的旧页面 —— 其实那种
            //    也该复用，所以这里就用 host:port 前缀匹配。
            string existingId = CdpFindPanelTarget(port);
            if (!string.IsNullOrEmpty(existingId))
            {
                Log("CDP: found existing panel target " + existingId + ", activating");

                // 激活它。Chrome 会切到这个标签页，并把承载它的窗口提到前面。
                // 这一步是「让用户看见」的关键 —— 不需要跟 Windows 前台锁搏斗。
                bool act = CdpPut(port, "/json/activate/" + existingId);
                Log("CDP: activate existing = " + act);

                if (act)
                {
                    // 标签页可能已经过期（服务停过、页面报错）。刷新一下，
                    // 保证用户看到的永远是活的页面。
                    CdpRefreshTarget(port, existingId);
                    return true;
                }
            }

            // ② 没有现成的，就新建一个。
            //
            //    注意 /json/new 的 URL 要整体转义 —— 里面的冒号斜杠
            //    不转义的话 Chrome 会按自己的规则解析，可能开成空白页。
            string endpoint = "/json/new?" + Uri.EscapeDataString(url);
            bool created = CdpPut(port, endpoint);
            Log("CDP: new tab created = " + created);
            return created;
        }

        /// <summary>
        /// 在调试端口的标签页列表里找本工具的面板标签页，返回它的 id。
        ///
        /// 找不到返回 null。这里用最朴素的字符串扫描而不是引入 JSON 库 ——
        /// net48 里引 System.Web.Extensions 会多带一个 dll，为读两个字段
        /// 不值得。/json/list 的输出形态是稳定的扁平数组，扫 "id" 和 "url"
        /// 两个键足够可靠。
        /// </summary>
        private static string CdpFindPanelTarget(int port)
        {
            string json = CdpGet(port, "/json/list");
            if (string.IsNullOrEmpty(json)) return null;

            // 面板地址的前缀就是 http://127.0.0.1:<面板端口>/
            // 这里不写死端口，用 PanelUrlPrefix 拼出来 —— 用户改过 PORT 也能认。
            string marker = "127.0.0.1:" + ResolvePort();

            int idx = 0;
            while (true)
            {
                // 每个 target 对象里，id 一定出现在 url 之前（Chrome 的字段顺序）。
                // 先定位 url，再往回找最近的 id，这样天然把两者配成一对。
                int urlPos = json.IndexOf("\"url\"", idx, StringComparison.Ordinal);
                if (urlPos < 0) return null;

                int urlValStart = json.IndexOf('"', json.IndexOf(':', urlPos) + 1);
                if (urlValStart < 0) return null;
                int urlValEnd = json.IndexOf('"', urlValStart + 1);
                if (urlValEnd < 0) return null;
                string targetUrl = json.Substring(urlValStart + 1, urlValEnd - urlValStart - 1);

                if (targetUrl.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    // 往回找这个对象里的 "id"
                    int idPos = json.LastIndexOf("\"id\"", urlPos, StringComparison.Ordinal);
                    if (idPos >= 0)
                    {
                        int idValStart = json.IndexOf('"', json.IndexOf(':', idPos) + 1);
                        if (idValStart >= 0)
                        {
                            int idValEnd = json.IndexOf('"', idValStart + 1);
                            if (idValEnd > idValStart)
                            {
                                return json.Substring(idValStart + 1, idValEnd - idValStart - 1);
                            }
                        }
                    }
                }

                idx = urlValEnd + 1;
            }
        }

        /// <summary>
        /// 让 Chrome 重新加载某个标签页，保证用户看到的是活页面。
        ///
        /// 用 /json/activate 之前那个页面可能已经因为服务重启而过期
        /// （显示 "无法访问此网站"）。不刷新的话，用户切过去看到的是一张
        /// 错误页 —— 那和「没打开」在观感上没有区别。
        ///
        /// 刷新走 Page.reload 需要 WebSocket，这里用更轻的办法：
        /// 让 Chrome 把这个 target 导航到一个带时间戳的同一地址。
        /// 加时间戳是为了强制真正发请求，而不是吃缓存。
        /// </summary>
        private static void CdpRefreshTarget(int port, string targetId)
        {
            // /json/activate 已把标签页切到前台。这里只补一次导航，
            // 让页面重新连上当前正在跑的服务。
            //
            // 单独用一个带 cache-buster 的地址，避免拿到之前的失败缓存。
            string url = "http://127.0.0.1:" + ResolvePort() + "/?_=" + DateTime.Now.Ticks;
            bool ok = CdpPut(port, "/json/new?" + Uri.EscapeDataString(url));
            if (ok)
            {
                // 新开了一个，就把旧的那个关掉，避免堆积。
                // 顺序很重要：先开新的再关旧的，用户不会看到空白瞬间。
                bool closed = CdpPut(port, "/json/close/" + targetId);
                Log("CDP: refreshed panel (new opened, old " + targetId + " closed=" + closed + ")");
            }
        }

        /// <summary>GET 一个调试接口路径，返回响应体；失败返回 null。</summary>
        private static string CdpGet(int port, string path)
        {
            try
            {
                System.Net.HttpWebRequest req = (System.Net.HttpWebRequest)
                    System.Net.WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = "GET";
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                req.Proxy = null;   // 绝不能走系统代理，见 CdpOpenPanel 的说明
                req.KeepAlive = false;

                using (System.Net.HttpWebResponse resp =
                    (System.Net.HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
            catch (Exception ex)
            {
                Log("CDP GET " + path + " failed " + SafeMessage(ex));
                return null;
            }
        }

        /// <summary>
        /// PUT 一个调试接口路径（/json/new、/json/activate、/json/close 都必须 PUT）。
        /// 返回 true 表示 HTTP 2xx。
        /// </summary>
        private static bool CdpPut(int port, string path)
        {
            try
            {
                System.Net.HttpWebRequest req = (System.Net.HttpWebRequest)
                    System.Net.WebRequest.Create("http://127.0.0.1:" + port + path);
                req.Method = "PUT";
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                req.Proxy = null;
                req.KeepAlive = false;
                req.ContentLength = 0;

                using (System.Net.HttpWebResponse resp =
                    (System.Net.HttpWebResponse)req.GetResponse())
                {
                    int code = (int)resp.StatusCode;
                    if (code < 200 || code >= 300)
                    {
                        Log("CDP PUT " + path + " status=" + code);
                    }
                    return code >= 200 && code < 300;
                }
            }
            catch (Exception ex)
            {
                Log("CDP PUT " + path + " failed " + SafeMessage(ex));
                return false;
            }
        }

        /// <summary>GET /json/version 探活：能拿到 JSON 就说明调试接口活着。</summary>
        private static bool CdpAlive(int port)
        {
            string body = CdpGet(port, "/json/version");
            if (string.IsNullOrEmpty(body)) return false;
            return body.IndexOf("Browser", StringComparison.OrdinalIgnoreCase) >= 0
                || body.IndexOf("webSocketDebuggerUrl", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// 找出浏览器的远程调试端口。
        ///
        /// 先读进程命令行里的 --remote-debugging-port（最准确）；
        /// 读不到（权限不足、WMI 服务异常、或浏览器根本没带这个参数）
        /// 就探测几个常见端口，用 /json/version 探活确认。
        /// 全都失败返回 0。
        /// </summary>
        private static int FindDebugPort()
        {
            // ① 命令行里找。这是权威来源 —— 用户可能把端口改成任意值。
            try
            {
                using (System.Management.ManagementObjectSearcher searcher =
                    new System.Management.ManagementObjectSearcher(
                        "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='chrome.exe' " +
                        "OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe'"))
                {
                    foreach (System.Management.ManagementObject mo in searcher.Get())
                    {
                        string cmd = null;
                        try { cmd = mo["CommandLine"] as string; } catch { }
                        if (string.IsNullOrEmpty(cmd)) continue;
                        if (cmd.IndexOf("--type=", StringComparison.Ordinal) >= 0) continue;

                        int p = ParseDebugPort(cmd);
                        if (p > 0)
                        {
                            Log("CDP: found port " + p + " in pid " + mo["ProcessId"]);
                            return p;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // WMI 不可用是常态之一（权限收紧、服务被停），不值得报警
                Log("CDP: WMI scan failed " + SafeMessage(ex));
            }

            // ② 退回常见端口探测。
            int[] common = { 9222, 9223, 9229, 9333 };
            foreach (int p in common)
            {
                if (CdpAlive(p))
                {
                    Log("CDP: probe found live debug port " + p);
                    return p;
                }
            }
            return 0;
        }

        /// <summary>
        /// 从命令行里抠出 --remote-debugging-port=N 的 N。
        /// 支持 `=9222` 和 ` 9222` 两种写法。
        /// </summary>
        private static int ParseDebugPort(string cmd)
        {
            const string flag = "--remote-debugging-port";
            int i = cmd.IndexOf(flag, StringComparison.OrdinalIgnoreCase);
            if (i < 0) return 0;

            i += flag.Length;
            if (i < cmd.Length && (cmd[i] == '=' || cmd[i] == ' ')) i++;

            int start = i;
            while (i < cmd.Length && cmd[i] >= '0' && cmd[i] <= '9') i++;
            if (i == start) return 0;

            int port;
            if (int.TryParse(cmd.Substring(start, i - start), out port) && port > 0 && port < 65536)
            {
                return port;
            }
            return 0;
        }

        /// <summary>
        /// 等**某个浏览器窗口的标题变成面板标题**。
        ///
        /// 为什么不能用 WaitForNewPanelWindow：CDP 打开的是**已有窗口里的
        /// 标签页**，窗口句柄不变。等「新句柄」永远等不到，白白耗掉几秒。
        ///
        /// 这里换判据：看**当前有没有一个浏览器窗口的标题是面板标题**。
        /// Chrome 切到新标签页时会把窗口标题改成该页标题，标题一变就说明
        /// 页面确实渲染出来了 —— 这也顺带证明了服务真的连上了（连不上时
        /// 浏览器显示错误页，标题只会是 127.0.0.1）。
        ///
        /// before 里的旧句柄要排除：那些是复用场景下本来就有的窗口，
        /// 我们要确认的是「这次操作之后确实有一个窗口在显示面板」。
        /// 但复用已有窗口时它本来就在 list 里，所以只要找到就认。
        /// </summary>
        private static IntPtr WaitForPanelTab(IntPtr[] before, int totalMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            IntPtr last = IntPtr.Zero;
            while (sw.ElapsedMilliseconds < totalMs)
            {
                IntPtr[] now = FindPanelWindows();
                if (now.Length > 0)
                {
                    last = now[0];
                    return last;
                }
                Thread.Sleep(120);
            }
            return last;
        }


        /// <summary>
        /// 点名浏览器 exe，用 --new-window 开一个**真正的新窗口**。
        ///
        /// ## 为什么必须带上浏览器实例自己的 --user-data-dir
        ///
        /// 这是本机实测出来的关键一条。这台机器的 Chrome 是这样起的：
        ///
        ///     chrome.exe --remote-debugging-port=9222 \
        ///                --user-data-dir="C:\PersonalCustom\chromeRemoteDebugProfile"
        ///
        /// 此时如果只执行：
        ///
        ///     chrome.exe --new-window "http://127.0.0.1:4599/"
        ///
        /// 新进程会去找「同 profile 的已有实例」并转交请求，但它用的是**默认**
        /// profile，而内存里跑着的实例属于自定义 profile —— 对不上，于是
        /// **请求被静默丢弃**：不报错、不开窗、进程数都不变（实测 39 → 39）。
        ///
        /// 把 --user-data-dir 原样带上之后，profile 对上了，请求成功投递，
        /// Chrome 自己开出一个位于前台的新窗口。同一台机器上的实测对比：
        ///
        /// | 命令 | 结果 |
        /// |---|---|
        /// | `chrome.exe --new-window URL` | 静默丢弃，无任何变化 |
        /// | `chrome.exe --user-data-dir=&lt;同实例&gt; --new-window URL` | **新窗口出现** ✓ |
        ///
        /// 所以这里的核心不是 --new-window，而是**把 profile 对齐**。
        ///
        /// ## 为什么这条路比 CDP 好
        ///
        /// CDP 的 /json/new 只能在某个已有的 Chrome 窗口里加一个**后台标签页**，
        /// 窗口本身不动 —— 用户看不到它，日志里就是「标签页有了，但压在面板
        /// 上面的全是 Chrome 自己的窗口」。而 --new-window 是浏览器自己开的
        /// 新窗口，天然在前台，不需要跟 Windows 前台锁搏斗。
        /// </summary>
        private static bool ForceNewWindow(string url)
        {
            string exe = DefaultBrowserExe();
            if (string.IsNullOrEmpty(exe))
            {
                Log("ForceNewWindow: 取不到默认浏览器 exe");
                return false;
            }

            string name = "";
            try
            {
                name = Path.GetFileNameWithoutExtension(exe).ToLowerInvariant();
            }
            catch
            {
                // 名字取不到就当非 chromium
            }

            bool chromium = name.Contains("chrome") || name.Contains("edge")
                || name.Contains("brave") || name.Contains("vivaldi");

            if (!chromium)
            {
                // 非 chromium 内核没有 --new-window 也不吃 user-data-dir，
                // 直接把 URL 当参数交给它即可。
                return TryStart(exe, new[] { "\"" + url + "\"" }, url);
            }

            // 找出正在运行的浏览器实例用的 --user-data-dir。
            // 找不到（浏览器没在跑、或跑的是默认 profile）就退化为不带，
            // 此时行为与旧实现一致。
            //
            // 必须按**同款浏览器**找：机器上可能同时开着 Chrome 和 Edge，
            // 把 Edge 的 profile 路径套给 Chrome，Chrome 会去创建一个全新的
            // profile 并当成首次启动 —— 那是另一个浏览器环境，cookie 全丢，
            // 面板打开也是没登录的。
            string udd = FindRunningUserDataDir(Path.GetFileNameWithoutExtension(exe));
            var argv = new System.Collections.Generic.List<string>();
            if (!string.IsNullOrEmpty(udd))
            {
                argv.Add("--user-data-dir=" + udd);
                Log("ForceNewWindow: matching user-data-dir=" + udd);
            }
            else
            {
                Log("ForceNewWindow: no running --user-data-dir found, using default profile");
            }
            argv.Add("--new-window");
            argv.Add("\"" + url + "\"");

            return TryStart(exe, argv.ToArray(), url);
        }

        /// <summary>
        /// 起一个进程。成功返回 true。
        ///
        /// 用 UseShellExecute=false + CreateNoWindow：浏览器不该把自己的日志
        /// 吐进启动器的控制台窗口。
        /// </summary>
        private static bool TryStart(string exe, string[] argv, string url)
        {
            string arg = string.Join(" ", argv);
            try
            {
                var psi = new ProcessStartInfo(exe, arg)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                Process.Start(psi);
                Log("force new window via " + exe + " arg=" + arg);
                return true;
            }
            catch (Exception ex)
            {
                Log("ForceNewWindow failed: " + SafeDescribe(ex));
                return false;
            }
        }

        /// <summary>
        /// 从正在运行的浏览器进程里读出 --user-data-dir。
        ///
        /// 为什么要这个：Chrome 用自定义 profile 在跑时，新起的进程如果
        /// 不带同一个 --user-data-dir，请求会被**静默丢弃**（详见 ForceNewWindow
        /// 的说明）。把值读出来原样带上，是让请求真正送达的唯一办法。
        ///
        /// 参数 browserName 用来限定「只看同款浏览器」：机器上同时开着
        /// Chrome 和 Edge 是常事，拿错 profile 会让浏览器以为自己是首次启动，
        /// 换了个干净环境 —— cookie 全丢，面板打开也是没登录的。
        ///
        /// 读不到就返回 null —— 调用方按默认 profile 处理，行为与旧实现一致。
        /// </summary>
        private static string FindRunningUserDataDir(string browserName)
        {
            string want = (browserName ?? "").ToLowerInvariant();
            if (want.Length == 0)
            {
                return null;
            }

            try
            {
                using (System.Management.ManagementObjectSearcher searcher =
                    new System.Management.ManagementObjectSearcher(
                        "SELECT ProcessId, Name, CommandLine FROM Win32_Process WHERE Name='chrome.exe' " +
                        "OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe'"))
                {
                    foreach (System.Management.ManagementObject mo in searcher.Get())
                    {
                        string cmd = null;
                        string pname = null;
                        try { cmd = mo["CommandLine"] as string; } catch { }
                        try { pname = mo["Name"] as string; } catch { }
                        if (string.IsNullOrEmpty(cmd)) continue;

                        // 只要同款浏览器
                        if (pname != null &&
                            pname.ToLowerInvariant().IndexOf(want, StringComparison.Ordinal) < 0)
                        {
                            continue;
                        }

                        // 渲染/GPU 子进程也会继承这个参数，但它们不是「实例」，
                        // 认它们没意义，跳过。
                        if (cmd.IndexOf("--type=", StringComparison.Ordinal) >= 0) continue;

                        string udd = ParseUserDataDir(cmd);
                        if (!string.IsNullOrEmpty(udd))
                        {
                            return udd;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log("FindRunningUserDataDir failed " + SafeMessage(ex));
            }
            return null;
        }

        /// <summary>
        /// 从命令行抠出 --user-data-dir 的值。
        /// 支持 `--user-data-dir=path`、`--user-data-dir="path with space"`、
        /// `--user-data-dir path` 三种写法。
        /// </summary>
        private static string ParseUserDataDir(string cmd)
        {
            const string flag = "--user-data-dir";
            int i = cmd.IndexOf(flag, StringComparison.OrdinalIgnoreCase);
            if (i < 0) return null;

            i += flag.Length;
            if (i < cmd.Length && (cmd[i] == '=' || cmd[i] == ' ')) i++;
            if (i >= cmd.Length) return null;

            // 带引号：取到闭合引号
            if (cmd[i] == '"')
            {
                int end = cmd.IndexOf('"', i + 1);
                if (end < 0) return null;
                return cmd.Substring(i + 1, end - i - 1);
            }

            // 不带引号：取到下一个空格。
            // 注意路径里可能有空格，但 Chrome 在命令行里只要路径带空格就一定会
            // 加引号，所以这里取到空格为止是安全的。
            int j = i;
            while (j < cmd.Length && cmd[j] != ' ') j++;
            string val = cmd.Substring(i, j - i);
            return val.Length > 0 ? val : null;
        }

        /// <summary>
        /// 从注册表读默认浏览器的可执行文件路径。
        ///
        /// 两跳：
        ///   HKCU\...\UrlAssociations\http\UserChoice  →  ProgId（如 ChromeHTML）
        ///   HKCR\&lt;ProgId&gt;\shell\open\command      →  "C:\...\chrome.exe" -- "%1"
        ///
        /// 解析命令行时只取第一个引号内的部分（没有引号就取到第一个空格），
        /// 这是所有浏览器注册时都遵守的写法。
        /// </summary>
        private static string DefaultBrowserExe()
        {
            try
            {
                using (Microsoft.Win32.RegistryKey k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice"))
                {
                    if (k == null) return null;
                    string progId = k.GetValue("ProgId") as string;
                    if (string.IsNullOrEmpty(progId)) return null;
                    Log("default browser progid=" + progId);

                    using (Microsoft.Win32.RegistryKey cmd = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey(
                        progId + @"\shell\open\command"))
                    {
                        if (cmd == null) return null;
                        string line = cmd.GetValue(null) as string;
                        return ParseExeFromCommand(line);
                    }
                }
            }
            catch (Exception ex)
            {
                Log("DefaultBrowserExe failed: " + SafeDescribe(ex));
                return null;
            }
        }

        private static string ParseExeFromCommand(string line)
        {
            if (string.IsNullOrEmpty(line)) return null;
            line = line.Trim();

            if (line.StartsWith("\""))
            {
                int end = line.IndexOf('"', 1);
                if (end > 0)
                {
                    string p = line.Substring(1, end - 1);
                    return File.Exists(p) ? p : null;
                }
                return null;
            }

            int sp = line.IndexOf(' ');
            string raw = sp > 0 ? line.Substring(0, sp) : line;
            return File.Exists(raw) ? raw : null;
        }

        /// <summary>
        /// 轮询等待**新出现的**面板窗口。
        ///
        /// 和旧版的区别：旧版只要「存在任何面板窗口」就返回，于是屏幕上有一个
        /// 几小时前的旧窗口时，它会立刻返回那个旧句柄并宣布成功 —— 新窗口
        /// 根本没等，用户眼前什么都没变。这正是之前谎报的机制。
        ///
        /// 现在只认 before 里没有的句柄。超时返回 IntPtr.Zero，
        /// 由调用方决定要不要退回到「复用已有窗口」。
        /// </summary>
        private static IntPtr WaitForNewPanelWindow(IntPtr[] before, int totalMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < totalMs)
            {
                foreach (IntPtr h in FindPanelWindows())
                {
                    if (!Contains(before, h))
                    {
                        return h;
                    }
                }
                Thread.Sleep(150);
            }
            return IntPtr.Zero;
        }

        private static bool Contains(IntPtr[] arr, IntPtr v)
        {
            if (arr == null) return false;
            foreach (IntPtr h in arr)
            {
                if (h == v) return true;
            }
            return false;
        }

        /// <summary>
        /// 枚举所有「标题像面板页」的顶层窗口。
        ///
        /// ## 为什么要按进程名过滤
        ///
        /// 只匹配标题是不够的。实测发现：Visual Studio Code 打开这个项目时，
        /// 窗口标题是「DevSwitch-Demo.bat - dev-switch - Visual Studio Code」，
        /// 里面也含 "DevSwitch"，于是被误判成面板窗口。
        /// 后果是启动器一看「已经有窗口了」就直接宣布成功 —— 又是一次谎报。
        ///
        /// 所以标题命中之后还要确认：这个窗口属于**浏览器进程**。
        /// 白名单用「包含关键字」而不是精确匹配，避免漏掉各种发行版
        /// （Chrome / Edge / Brave / Vivaldi / 360 / QQ 浏览器 …）。
        /// </summary>
        private static IntPtr[] FindPanelWindows()
        {
            var found = new System.Collections.Generic.List<IntPtr>();
            int scanned = 0;      // 枚举到的顶层窗口总数
            int titled = 0;       // 其中有标题的
            int titleHit = 0;     // 标题同时含 DevSwitch + 租户切换
            var nearMiss = new StringBuilder();

            try
            {
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    try
                    {
                        scanned++;

                        if (!IsWindowVisible(hWnd)) return true;

                        int len = GetWindowTextLengthW(hWnd);
                        if (len <= 0) return true;

                        var sb = new StringBuilder(len + 2);
                        GetWindowTextW(hWnd, sb, sb.Capacity);
                        string title = sb.ToString();
                        if (title.Length == 0) return true;

                        titled++;

                        if (title.IndexOf(TitleMarkA, StringComparison.OrdinalIgnoreCase) < 0) return true;
                        if (title.IndexOf(TitleMarkB, StringComparison.Ordinal) < 0) return true;

                        titleHit++;

                        bool isBrowser = IsBrowserWindow(hWnd);
                        if (!isBrowser)
                        {
                            nearMiss.Append(" [标题匹配但非浏览器 hwnd=").Append(hWnd)
                                    .Append(" title=").Append(title).Append("]");
                            return true;
                        }

                        found.Add(hWnd);
                    }
                    catch (Exception ex)
                    {
                        // 单个窗口取标题失败不影响继续枚举，但要留痕 ——
                        // 之前这里静默吞掉，导致「窗口明明在却检出 0 个」无从查起。
                        nearMiss.Append(" [异常 ").Append(SafeMessage(ex)).Append("]");
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch (Exception ex)
            {
                Log("EnumWindows failed: " + SafeDescribe(ex));
            }

            // 只在「结果与上一次不同」时落日志。
            // 这个函数在等待循环里会被调用几十次（每 150ms 一次），
            // 每轮都写会把日志刷满几千行，真正重要的行反而被埋掉。
            string summary = "topWindows=" + scanned + " titled=" + titled
                             + " titleHit=" + titleHit + " found=" + found.Count
                             + (nearMiss.Length > 0 ? " notes:" + nearMiss : "");

            if (summary != _lastScanSummary)
            {
                _lastScanSummary = summary;
                Log("scan: " + summary);
            }

            return found.ToArray();
        }

        /// <summary>上一次扫描结果的摘要，用于抑制重复日志。</summary>
        private static string _lastScanSummary;

        /// <summary>这些片段出现在进程名里，就认为它是浏览器。</summary>
        private static readonly string[] BrowserProcKeys =
        {
            "chrome", "msedge", "firefox", "brave", "vivaldi", "opera",
            "360se", "360chrome", "qqbrowser", "sogouexplorer", "liebao",
        };

        private static bool IsBrowserWindow(IntPtr hWnd)
        {
            uint pid = 0;
            try
            {
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == 0)
                {
                    Log("IsBrowserWindow: GetWindowThreadProcessId 返回 0, hwnd=" + hWnd);
                    return false;
                }
            }
            catch (Exception ex)
            {
                Log("IsBrowserWindow: GetWindowThreadProcessId 失败 " + SafeMessage(ex));
                return false;
            }

            // ① 先看窗口类名。这条路径**不需要跨进程权限**，
            //    在「取不到进程名」的场合仍然可靠 —— 浏览器主窗口的类名
            //    非常稳定（见 IsBrowserWindowClass）。
            if (IsBrowserWindowClass(hWnd))
            {
                return true;
            }

            // ② 再看进程名。取不到（权限不足/进程已退出）时只留痕，不据此否定 ——
            //    之前在受限上下文里 GetProcessById 抛异常，这里 catch 后直接
            //    return false，结果「窗口明明在、标题也对」却被判成不是浏览器，
            //    日志里只留下一个「标题匹配但非浏览器」的谜语。这是那次误判的根源。
            string name;
            try
            {
                using (Process p = Process.GetProcessById((int)pid))
                {
                    name = p.ProcessName.ToLowerInvariant();
                }
            }
            catch (Exception ex)
            {
                Log("IsBrowserWindow: 取进程名失败 pid=" + pid + " " + SafeMessage(ex));
                return false;
            }

            foreach (string k in BrowserProcKeys)
            {
                if (name.IndexOf(k, StringComparison.Ordinal) >= 0)
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 浏览器主窗口的窗口类名。
        ///
        /// 为什么需要它：`Process.GetProcessById(pid).ProcessName` 要打开目标进程
        /// 拿映像名，在某些上下文里会被拒绝（权限/完整性级别差异），抛异常后
        /// 整条判定就退化成「这不是浏览器」。而 GetClassNameW 只读窗口本身的信息，
        /// 不需要跨进程权限，因此在那种场合仍然准确。
        ///
        /// 这些类名都是各浏览器长期稳定的：Chromium 系统一用 Chrome_WidgetWin_1，
        /// Firefox 用 MozillaWindowClass，IE/旧 WebView 用 IEFrame。
        /// </summary>
        private static readonly string[] BrowserWindowClasses =
        {
            "Chrome_WidgetWin_1", "Chrome_WidgetWin_0",
            "MozillaWindowClass", "IEFrame", "ApplicationFrameWindow",
        };

        private static bool IsBrowserWindowClass(IntPtr hWnd)
        {
            try
            {
                var sb = new StringBuilder(256);
                int n = GetClassNameW(hWnd, sb, sb.Capacity);
                if (n <= 0) return false;

                string cls = sb.ToString();
                foreach (string k in BrowserWindowClasses)
                {
                    if (cls.Equals(k, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
                return false;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// 模拟一次 Alt 键按下/抬起，用来解开 Windows 的前台锁。
        ///
        /// 用 SendInput 而不是 keybd_event：后者已被标记为过时，
        /// 且在部分环境下不触发前台锁的解锁逻辑。
        /// </summary>
        private static void PressAlt()
        {
            try
            {
                INPUT[] inputs = new INPUT[2];

                inputs[0].type = InputKeyboard;
                inputs[0].u.ki.wVk = VkMenu; // Alt
                inputs[0].u.ki.dwFlags = 0;

                inputs[1].type = InputKeyboard;
                inputs[1].u.ki.wVk = VkMenu;
                inputs[1].u.ki.dwFlags = KeyEventKeyUp;

                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            }
            catch (Exception ex)
            {
                Log("PressAlt failed: " + SafeDescribe(ex));
            }
        }

        // ───────────────────────── Win32 ─────────────────────────

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        private const int SwShow = 5;
        private const int SwShowMaximized = 3;
        private const int SwMinimize = 6;
        private const int SwRestore = 9;
        private const byte VkMenu = 0x12;
        private const uint KeyEventKeyUp = 0x0002;
        private const uint InputKeyboard = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        // Z 序遍历三件套：GetTopWindow 拿第一个，GetWindow(h, GW_HWNDNEXT) 往下走。
        // 这套 API 是「按屏幕上的前后顺序」枚举窗口，正是判断「谁压在谁上面」
        // 唯一可靠的办法 —— 任何返回值型的 API 都不如直接数位置来得实在。
        [DllImport("user32.dll")]
        private static extern IntPtr GetTopWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        private const uint GwHwndnext = 2;      // 下一个（更靠后的）窗口
        private const int GwlExstyle = -20;     // 扩展样式
        private const int WsExTopmost = 0x00000008;  // 置顶标志位

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        // SetWindowPos 的 hWndInsertAfter 特殊值。
        // 前两个来自 WinUser.h：#define HWND_TOPMOST ((HWND)-1) / HWND_NOTOPMOST ((HWND)-2)。
        // HWND_TOP 是 0 —— 语义是「放到本层（当前所在的层级带）的最前面」，
        // 不会把窗口提到置顶层，因此不会像 TOPMOST 那样盖住一切。
        private static readonly IntPtr HwndTop = IntPtr.Zero;
        private static readonly IntPtr HwndTopmost = new IntPtr(-1);
        private static readonly IntPtr HwndNotopmost = new IntPtr(-2);
        private const uint SwpNosize = 0x0001;
        private const uint SwpNomove = 0x0002;
        private const uint SwpNoactivate = 0x0010;

        private static void PrintManual(string url, string why)
        {
            try
            {
                Console.WriteLine();
                Console.WriteLine("  ⚠ " + why);
                Console.WriteLine("    请手动打开：" + url);
                Console.WriteLine();
            }
            catch
            {
                // 无控制台
            }
        }

        // ───────────────────────── 端口探测 ─────────────────────────

        /// <summary>
        /// 轮询等端口可连接，最多等 totalMs 毫秒。
        ///
        /// 同时盯着子进程：它一旦退出就不用再等了 —— 服务不可能再起来，
        /// 继续等只会让用户对着窗口干等 15 秒才看到真正的错误。
        /// </summary>
        private static bool WaitForPort(int port, int totalMs, Process child)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < totalMs)
            {
                if (PortOpen(port))
                {
                    return true;
                }
                if (ChildExited(child))
                {
                    Log("child exited while waiting for port");
                    return false;
                }
                System.Threading.Thread.Sleep(120);
            }
            return false;
        }

        private static bool ChildExited(Process child)
        {
            try
            {
                return child == null || child.HasExited;
            }
            catch
            {
                // 读不到就当作没退出，别因此中断等待
                return false;
            }
        }

        /// <summary>
        /// 试连一次回环端口。
        ///
        /// 用 BeginConnect + WaitOne 而不是 TcpClient.Connect 直接给超时：
        /// 后者在 .NET Framework 上没有可靠的超时控制，连不通时可能挂很久。
        /// </summary>
        private static bool PortOpen(int port)
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                    bool ok = ar.AsyncWaitHandle.WaitOne(400);
                    if (!ok || !c.Connected)
                    {
                        return false;
                    }
                    c.EndConnect(ar);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static int ResolvePort()
        {
            try
            {
                string raw = Environment.GetEnvironmentVariable("PORT");
                int p;
                if (!string.IsNullOrEmpty(raw) && int.TryParse(raw, out p) && p > 0 && p < 65536)
                {
                    return p;
                }
            }
            catch
            {
                // 读环境变量失败就用默认值
            }
            return DefaultPort;
        }

        // ───────────────────────── 找 node ─────────────────────────

        /// <summary>
        /// 找 node.exe。
        ///
        /// 不能只依赖 PATH —— 用 nvm 或安装器装在用户目录时，PATH 未必带上。
        /// 所以先信任 PATH，再补几个常见位置。
        /// </summary>
        private static string FindNode()
        {
            string fromPath = FindOnPath("node.exe");
            if (fromPath != null)
            {
                return fromPath;
            }

            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
                Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", @"Programs\nodejs\node.exe"),
                Path.Combine(Environment.GetEnvironmentVariable("APPDATA") ?? "", @"nvm\node.exe"),
                Path.Combine(Environment.GetEnvironmentVariable("NVM_SYMLINK") ?? "", "node.exe"),
            };

            foreach (string c in candidates)
            {
                try
                {
                    if (!string.IsNullOrEmpty(c) && File.Exists(c))
                    {
                        return c;
                    }
                }
                catch
                {
                    // 路径非法就跳过，不影响其他候选
                }
            }

            return null;
        }

        private static string FindOnPath(string exe)
        {
            string path = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }

            foreach (string dir in path.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir))
                {
                    continue;
                }
                try
                {
                    string full = Path.Combine(dir.Trim(), exe);
                    if (File.Exists(full))
                    {
                        return full;
                    }
                }
                catch
                {
                    // 单个目录有问题不影响继续找
                }
            }

            return null;
        }

        // ───────────────────────── 杂项 ─────────────────────────

        /// <summary>
        /// 取自己的文件名（不带扩展名），用来区分正式版/演示版。
        ///
        /// 原实现直接读 Process.MainModule.FileName。在某些受限环境里
        /// 读取主模块会抛异常，一抛就是启动即崩，代价太大。
        /// 所以逐级降级：主模块 → 命令行第 0 项 → 兜底常量。
        /// </summary>
        private static string SelfName()
        {
            try
            {
                return Path.GetFileNameWithoutExtension(
                    Process.GetCurrentProcess().MainModule.FileName);
            }
            catch
            {
                // 读不到主模块就退一步
            }

            try
            {
                string[] argv = Environment.GetCommandLineArgs();
                if (argv != null && argv.Length > 0)
                {
                    return Path.GetFileNameWithoutExtension(argv[0]);
                }
            }
            catch
            {
                // 再退一步
            }

            return "DevSwitch";
        }

        /// <summary>
        /// 拼一条安全的异常描述。
        ///
        /// 为什么不用 ex.ToString()：这次踩的就是这个坑 ——
        /// ToString() 自己抛异常，结果窗口里只剩
        /// 「由于 Exception.ToString() 失败，因此无法打印异常字符串」，
        /// 连异常类型都丢了。这里每个属性单独 try，坏一个不影响其他，
        /// 总能拼出点有用的东西。
        /// </summary>
        private static string SafeDescribe(Exception ex)
        {
            StringBuilder sb = new StringBuilder();
            int depth = 0;

            for (Exception cur = ex; cur != null && depth < 5; cur = SafeInner(cur), depth++)
            {
                if (depth > 0)
                {
                    sb.AppendLine("--- inner ---");
                }
                sb.AppendLine("type: " + SafeType(cur));
                sb.AppendLine("message: " + SafeMessage(cur));
                string st = SafeStackTrace(cur);
                if (!string.IsNullOrEmpty(st))
                {
                    sb.AppendLine("stack: " + st);
                }
            }

            return sb.ToString().TrimEnd();
        }

        private static Exception SafeInner(Exception ex)
        {
            try
            {
                return ex.InnerException;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeType(Exception ex)
        {
            try
            {
                return ex.GetType().FullName;
            }
            catch
            {
                return "(取不到异常类型)";
            }
        }

        private static string SafeMessage(Exception ex)
        {
            try
            {
                return ex.Message;
            }
            catch
            {
                return "(取不到异常消息)";
            }
        }

        private static string SafeStackTrace(Exception ex)
        {
            try
            {
                return ex.StackTrace;
            }
            catch
            {
                return "";
            }
        }

        private static string SafePid(Process p)
        {
            if (p == null)
            {
                return "-";
            }
            try
            {
                return p.Id.ToString();
            }
            catch
            {
                return "?";
            }
        }

        private static void InitLog()
        {
            // 为什么候选项这么多：Environment.GetFolderPath(LocalApplicationData)
            // 在某些精简系统、被组策略限制的账户、或环境变量被裁剪的父进程下
            // 会返回**空字符串**。那样 Path.Combine("", "DevSwitch") 就成了
            // 相对路径，Directory.CreateDirectory 失败，日志从此静默消失 ——
            // 出问题时用户找不到任何痕迹，比不写日志更糟。
            //
            // 顺序原则：先挑「一定可写且稳定」的，再挑「用户目录」，最后才退到临时目录。
            //   1. 程序目录 —— 双击 exe 的场景下必然可写，且和用户找文件的地方一致
            //   2. LocalAppData / AppData —— 标准的每用户数据位置
            //   3. 临时目录 —— 最后的兜底
            string baseDir = null;
            try
            {
                baseDir = AppDomain.CurrentDomain.BaseDirectory;
            }
            catch
            {
                // 取不到就跳过
            }

            string[] bases =
            {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetEnvironmentVariable("LOCALAPPDATA"),
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                Environment.GetEnvironmentVariable("APPDATA"),
                baseDir,
                Path.GetTempPath(),
            };

            var tried = new StringBuilder();

            foreach (string b in bases)
            {
                try
                {
                    if (string.IsNullOrWhiteSpace(b))
                    {
                        tried.Append("(空)").Append(" ; ");
                        continue;
                    }

                    string dir = Path.Combine(b, "DevSwitch");

                    // 相对路径说明 base 本身不可信，跳过 —— 否则日志会写到
                    // 当前工作目录，下次从别处启动就找不到了。
                    if (!Path.IsPathRooted(dir))
                    {
                        tried.Append(dir).Append("(非绝对路径)").Append(" ; ");
                        continue;
                    }

                    tried.Append(dir).Append(" ; ");
                    Directory.CreateDirectory(dir);
                    _logPath = Path.Combine(dir, "launcher.log");

                    // 简单滚动：超过 256KB 就重开，避免越积越大
                    try
                    {
                        FileInfo fi = new FileInfo(_logPath);
                        if (fi.Exists && fi.Length > 256 * 1024)
                        {
                            File.Delete(_logPath);
                        }
                    }
                    catch
                    {
                        // 删不掉就继续往里写
                    }

                    // 真正落一次盘再认账。只判断「目录建好了」是不够的 ——
                    // 目录可建而文件不可写的情况（ACL、杀软锁）确实存在，
                    // 那样 _logReady=true 却一条都写不进去，等于自欺。
                    _logReady = true;
                    Log("───── launcher start ─────");
                    if (!File.Exists(_logPath))
                    {
                        _logReady = false;
                        _logPath = null;
                        continue;
                    }

                    Log("log path=" + _logPath);
                    return;
                }
                catch (Exception ex)
                {
                    // 换下一个候选位置，并把原因记下来（不记就永远是「不知道为啥」）
                    try
                    {
                        tried.Append("[失败:").Append(SafeMessage(ex)).Append("] ; ");
                    }
                    catch
                    {
                        tried.Append("[失败] ; ");
                    }
                }
            }

            _logReady = false;

            // 日志全军覆没时，至少把「试过哪些地方」写到 stderr，
            // 免得下次又变成「什么都查不到」。
            try
            {
                Console.Error.WriteLine("  [DevSwitch] 日志无法写入，尝试过：" + tried);
            }
            catch
            {
                // 连 stderr 都没有，那就真没办法了
            }
        }

        /// <summary>写一行日志。任何失败都静默 —— 日志不能成为新的崩溃源。</summary>
        private static void Log(string msg)
        {
            if (!_logReady)
            {
                return;
            }
            try
            {
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + msg
                              + Environment.NewLine;
                File.AppendAllText(_logPath, line, Encoding.UTF8);
            }
            catch
            {
                // 忽略
            }
        }

        private static int Fail(string title, string message, string detail)
        {
            Log("FAIL " + title + " | " + message + " | " + (detail ?? ""));
            Console.WriteLine();
            Console.WriteLine("  [X] " + title);
            Console.WriteLine();
            foreach (string line in message.Split('\n'))
            {
                Console.WriteLine("      " + line);
            }
            if (!string.IsNullOrEmpty(detail))
            {
                Console.WriteLine();
                foreach (string line in detail.Split('\n'))
                {
                    Console.WriteLine("      " + line);
                }
            }
            Console.WriteLine();
            Pause();
            return 1;
        }

        /// <summary>
        /// 等一次按键。
        ///
        /// 用 ReadKey 而不是 Console.ReadLine：ReadLine 遇到输入重定向会立刻返回，
        /// 窗口一闪就没了，用户根本看不到错误信息。
        /// </summary>
        private static void Pause()
        {
            try
            {
                if (!Console.IsInputRedirected)
                {
                    Console.WriteLine("  按任意键关闭…");
                    Console.ReadKey(true);
                }
            }
            catch
            {
                // 没有控制台可用就算了，不能因为等待按键而崩掉
            }
        }
    }
}
