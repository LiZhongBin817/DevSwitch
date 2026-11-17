# DevSwitch

本地开发用的「登录 + 租户/组合切换」小工具。零依赖，只用一个 Node 服务同时做两件事：

1. 托管页面
2. **反向代理**你的本地后端 —— 页面请求全部经 `/api/proxy` 转发，所以**不需要后端配 CORS，也不用担心 Cookie 跨域**

---

## 快速开始

**最省事**：双击项目里的 **`DevSwitch.bat`** —— 会检查 Node、启动服务、服务就绪后自动开浏览器。

> 不用自己拼地址、也不用等。**重复双击也没事**：它会认出「面板已经在跑」，
> 直接把页面在浏览器里打开给你，然后自己安静退出 —— 不会再起一个、也不会报端口错误。
> 只有 4599 被**别人的程序**占着时才需要换端口。

**或者用命令行**：

```bash
cd "E:\学习项目\dev-switch"

# 只启动工具（连你自己的后端）
node server.js

# 或者：一键跑演示（同时起模拟后端 8081 + 工具 4599）
node start-demo.js
```

然后打开 http://127.0.0.1:4599

> 演示账号：`admin / 123456`、`dev / 123456`
> 演示配置写在独立的 `data-demo/` 里，**不会改动你真实的 `data/state.json`**
>（可以双击 `DevSwitch-Demo.bat` 达到同样效果）。

端口可改：`PORT=5000 node server.js`（模拟后端用 `MOCK_PORT`）

> **装 Node、看启动日志、怎么停、起不来怎么办** —— 详见 [USAGE.md § 2 启动](./USAGE.md#2-启动)，
> 那份文档是从「先装 Node」一步步讲的，这一节只列命令。


---

## 接上你自己的后端

页面上就能全部配好，不用改代码。三步：

### 1️⃣ 顶部填后端地址

比如 `http://localhost:8080`，点「检测」确认在线。

> **回环地址优先填 `localhost`。** 它能同时覆盖 IPv6（`::1`）和 IPv4（`127.0.0.1`），
> 而 `127.0.0.1` 只认 IPv4 —— 后端若只绑了 `::1`，填 `127` 就会 `ECONNREFUSED`。
> 填了 `127` 也不至于失败，面板会自动换名兜底并如实告诉你（见
> [回环自动兜底](#后端有的只认-localhost有的只认-127001回环自动兜底)）。

### 2️⃣ 配置 → 登录

按你后端的登录接口填：

| 配置项 | 说明 | 例子 |
|---|---|---|
| 登录路径 | 接口路径 | `/api/auth/login` |
| Content-Type | `json` 或 `form` | `json` |
| 请求体模板 | 用 `{{username}}` `{{password}}` 占位 | `{"username":"{{username}}","password":"{{password}}"}` |
| Token 取值路径 | 从响应 JSON 里取 token 的点路径 | `data.accessToken` |

也支持 Cookie 会话：勾上「保存并回传 Set-Cookie」，Token 路径留空即可。

### 3️⃣ 配置 → 切租户 / 租户列表

两种租户模式，按你的后端选：

- **纯请求头模式**（后端靠 `X-Tenant-Id` 这类头识别租户）
  → 把「切租户」保持关闭，只在「请求头」里配好租户头即可。切换瞬间生效，不调接口。

- **接口切换模式**（要调 `switch-tenant` 换发 token）
  → 开启「切租户」，填路径和请求体模板，用 `{{tenantId}}` / `{{tenantCode}}` 占位。

租户列表可以手动维护，也可以在「租户列表」里配好接口后点左侧「⟳ 拉取」自动获取。
列表路径支持 `data` / `data.list` / `data.records` 这类点路径，并按 `idField` / `nameField` 映射字段。

---

## 连 tsie / BaseResp 体系后端（pds-std 这类）

如果你连的后端是 **tsie-framework**（`pds-platform-be` 等），有 4 个坑必须知道，否则会「看起来登录成功、其实全是失败」：

### 坑 1：HTTP 200 不代表成功

这套框架的业务失败**也返回 HTTP 200**，真正的成败在响应体里：

| `retCode` | 含义 |
|---|---|
| `T200` | 成功 |
| `T401` | 账号或密码错误 |
| `T302` | 未登录 / Token 失效 |

所以「登录」和「切租户」里都要填 **成功码字段 = `retCode`**、**成功码值 = `T200`**。
工具会先比 `retCode`，只有没配这个校验时才退回看 HTTP 状态码。

### 坑 2：JWT 在 Cookie 里，不在响应体

框架默认 `TokenOperateMode.Cookie`，JWT 通过 `Set-Cookie: Authorization=<jwt>` 下发。
响应体里**没有** `accessToken`，配了 `data.accessToken` 永远是空。

→ 「Token 来源」选 **Cookie**，「Token 名称」填 `Authorization`。

### 坑 3：路径要带 context-path

Spring Boot 的 `server.servlet.context-path` + `spring.mvc.servlet.path` 是**拼起来**的：

```
context-path = /pds-std   +   servlet.path = /api
= 真实地址 /pds-std/api/login
```

直接访问 `/api/login` 会 404。

### 坑 4：切租户失败也返回 T200

`DefaultTenantSwitchHandler.failSwitch()` 用的是 `BaseRespBuilder.success()`，
失败时 `retCode` 仍是 `T200`，真实原因只写在 `retMsg`（如「切换租户失败, 错误原因: xxx」）。

→ 工具对切租户做了**双重判定**：`retCode` 必须是 `T200`，**且** `retMsg` 里不能出现「失败/错误/异常」。
切成功后服务端会重新下发 `Authorization` cookie，工具会自动接住。

### 推荐配置（pds-platform-be）

```
后端地址        http://127.0.0.1:8080

登录     POST  /pds-std/api/login        json  {"username":"{{username}}","password":"{{password}}"}
         Token 来源 = Cookie，Token 名称 = Authorization
         成功码 retCode = T200

切租户   POST  /pds-std/api/switchTenant form  tenantId={{tenantId}}
         成功码 retCode = T200

租户列表 GET   /pds-std/api/pf/tenant/all
         列表路径 = data，ID = tenantId，名称 = name
```

### 登录失败怎么读

tsie 框架的登录失败处理器对**不同异常返回同一句笼统文案**，光看 `retMsg` 会误判：

| 你看到的 `retMsg` | 真实含义 | 怎么区分 |
|---|---|---|
| `账户名或者密码输入错误!` | 纯密码错 | 明确 |
| `账户名或者密码输入错误，再尝试错误 N 次用户将被锁定!` | 密码错，还剩 N 次 | 明确 |
| **`请联系项目组成员`** | **锁定 / 禁用 / 密码过期**（三者共用） | 只能看 `data` 字段 |
| `用户认证失败` | 用户不存在 / 用户中心不可达 | 明确 |

`请联系项目组成员` 之所以无法区分，是因为框架里这三个分支写的是同一句话：

```java
} else if (exception instanceof CredentialsExpiredException) {   // 密码过期
    returnData = "请联系项目组成员";
} else if (exception instanceof DisabledException) {             // 被禁用
    returnData = "请联系项目组成员";
} else if (exception instanceof LockedException) {               // 被锁定
    returnData = "请联系项目组成员";
}
```

真实原因被塞在响应体的 **`data`** 字段里（`BaseRespBuilder.fail().setData(exception.getMessage())`），
形如 `org.springframework.security.authentication.LockedException: 用户锁定`。

→ 本工具会把 `data` 一并显示，并翻译成人话，例如：

```
登录失败：[T401] 请联系项目组成员（服务端异常：org.springframework...LockedException: 用户锁定）

🚫 账号已被锁定（连续密码错误触发，默认锁 24 小时）。
继续重试没有意义，请到用户中心解锁 / 找回密码，或改用「导入 Cookie」绕过登录。
```

### 登录被锁了怎么办

这套后端有**连续密码错误锁定**策略，默认参数（`UserLockProperties`）：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `failCount` | 5 | 连续错 5 次触发锁定 |
| `lockMinutes` | **1440（24 小时）** | 锁多久 |
| `alertCount` | 3 | 剩余次数 ≤ 3 时开始提示 |
| `minutesInThePass` | 30 | 统计窗口 |

⚠️ **注意锁定是 24 小时，不是几分钟。** 一旦看到 `请联系项目组成员`，说明已经锁上了：

1. **别再试密码** —— 每次失败都可能刷新锁定计时，越试越久
2. 找管理员在用户中心解锁 / 重置密码
3. **直接导入 Cookie 绕过登录** —— 见下节，这条最快，不影响干活

工具会自动熔断：一旦服务端报出剩余次数或锁定态，「当前会话」卡片上会出现一条红色警戒条，
直接拦住后续自动登录，并提供一个「改用导入 Cookie」按钮。

---

## 导入 Cookie（绕过登录接口）

「当前会话」卡片上的 **导入 Cookie** 按钮，可以把浏览器里已经登好的会话直接搬进来，
完全不走登录接口，因此**不会消耗密码错误次数**。

**拿 Cookie 的方法**：浏览器里正常登录你的系统 → F12 → Network → 随便点一个请求 →
Request Headers 里的 `Cookie:` 整行复制；或者 Application → Cookies → 全选复制。

支持粘贴这几种格式：

```
Authorization=eyJhbGci...; JSESSIONID=xxx        ← Cookie 头原样
Authorization=eyJhbGci...\nJSESSIONID=xxx        ← 一行一个
[{"name":"Authorization","value":"eyJ..."}]      ← DevTools 复制的 JSON
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefg     ← 只贴 JWT 本体
```

导入后即可正常「拉取租户」「切租户」「请求调试」，和正常登录完全一样。

### 紧急情况：账号已锁，但马上要干活

登录接口走不通时，这是最快的路：

1. 浏览器打开你的系统（`http://localhost:8080` 的前端页面），用另一个没被锁的账号登录
   —— 或者让同事在他机器上登一下，把 Cookie 发你
2. F12 → Network → 点任意一个请求 → 复制 Request Headers 里 `Cookie:` 整行
3. 回到本工具，点「导入 Cookie」，粘贴，确定
4. 直接「拉取租户」→ 点租户切换，全程不碰登录接口，也就不会再消耗密码尝试次数

> 注意：切租户会换发新 JWT，工具会自动更新手里的 Cookie；但浏览器里那个会话不会变。

## 把会话写进浏览器（让 localhost 直连就是登录态）

用「导入 Cookie」或登录拿到会话后，这些 Cookie **只活在工具的内存里**。
你直接在浏览器打开 `http://localhost:8080` 的业务页面，照样是未登录 —— 因为浏览器不知道有这回事。

「当前会话」卡片下方的 **写入浏览器** 按钮就是干这个的：把会话里的 Cookie 通过
`Set-Cookie` 写进浏览器自己的 Cookie 罐。写完之后，直接在地址栏敲业务页面地址就是登录态，
不用再登录、也不用在 DevTools 里手改。

### 为什么非要走服务端

后端下发的是 `Set-Cookie: Authorization=...; HttpOnly`。前端 JS 用 `document.cookie` 写不回去：

- `HttpOnly` 这个标记 JS 根本设不了
- 已写入的 `HttpOnly` 项，JS 也读不回来（F12 里 `document.cookie` 看不到它，属于正常）

所以只能由服务端下发真正的 `Set-Cookie` 响应头。工具会把后端给的 `Path`/`HttpOnly`
**原样复刻**，不会偷偷降级成普通 Cookie。

### 主机名：自动覆盖 localhost 与 127.0.0.1

**Cookie 不区分端口，但区分主机名。** `localhost` 和 `127.0.0.1` 在浏览器眼里是两个毫不相干
的站点，Cookie 绝不互通；给 `Set-Cookie` 加 `Domain` 也救不了（`127.0.0.1` 不是 `localhost`
的子域，浏览器会直接拒收）。

所以要实现「两个地址打开业务页面都是登录态」，**唯一**的办法是让浏览器分别向两个主机名
各发一次请求。工具就是这么做的：**登录成功后自动执行**（也可以手动点 **写入浏览器**），会

1. 先往当前主机名写（`POST /api/browser-cookie`）
2. 再通过一个隐藏 iframe 加载另一个主机名下的 `/__cookie-bridge` 页面，
   由**那个页面**（而不是当前页面）发 `Set-Cookie` —— 这样 Cookie 才会落在它自己的主机名上

结果：无论你用 `http://localhost:4599` 还是 `http://127.0.0.1:4599` 打开面板，
写完之后 `localhost:8080` 和 `127.0.0.1:8080` **都能直接访问**，都是登录态。
「清除」同样是两边一起清。

> 已用真实浏览器（CDP）验证：在 `127.0.0.1:4599` 面板上写入后，浏览器罐里
> `127.0.0.1` 和 `localhost` 两个 domain 都有 `Authorization`，且
> `Network.getCookies({urls:['http://localhost:8080/...']})` 能把它带上。

## 后端有的只认 localhost、有的只认 127.0.0.1（回环自动兜底）

本机同时跑着好几个后端是常态，而它们的绑定方式并不一致：

- 有的 `server.listen(8080)` 不写地址 → Node 通常会同时绑 `::` 和 `0.0.0.0`
- 有的显式写 `listen(PORT, '127.0.0.1')` → **只绑 IPv4**
- 有的显式写 `listen(PORT, '::1')` → **只绑 IPv6**

而 `target` 只能填一个主机名。填 `127.0.0.1`，遇到只绑 IPv6 的后端就是
`ECONNREFUSED`；填 `localhost` 又怕反向出问题。用户被迫为每个后端改配置 —— 这不合理。

### 实测矩阵（Node 22，Happy Eyeballs 默认开启）

| 从哪发起 | 后端只绑 IPv4 | 后端只绑 IPv6 |
|---|---|---|
| `localhost` | ✅ 通 | ✅ 通 |
| `127.0.0.1` | ✅ 通 | ❌ `ECONNREFUSED` |

**`localhost` 是超集，`127.0.0.1` 只认 IPv4。** 短板完全在 `127.0.0.1` 这一侧。

原因：Node 22 的 `net.getDefaultAutoSelectFamily()` 默认为 `true`，`fetch('http://localhost:...')`
会同时展开 `::1` 与 `127.0.0.1` 逐个尝试（`attemptTimeout = 250ms`）。
而 `127.0.0.1` 是字面量 IPv4 地址，没有任何 DNS 或地址族回退的余地。

### 兜底规则

连接层报 `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` 时，自动把主机名换成
下一个候选再试一次。候选顺序：

```
你填的那个  →  localhost  →  [::1]  →  127.0.0.1
```

即「先尊重你写的，再往覆盖更广的那一侧靠」。每换一次都会打日志：

```
· 回环兜底已开启：127.0.0.1 连不上时自动改用 localhost / [::1] 重试
[loopback] 127.0.0.1 连不上，已自动改用 localhost（ECONNREFUSED）
```

**只在连接层错误时换名，绝不错杀这几种情况：**

| 情况 | 是否换名 | 为什么 |
|---|---|---|
| `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` | ✅ 换 | 对面没人在听，换名字可能就有人了 |
| 超时（`TimeoutError`） | ❌ 不换 | 服务在线只是慢，换名字只会多等一轮，还会把「后端卡住」误报成「地址不对」 |
| `ENOTFOUND`（域名解析不了） | ❌ 不换 | 跟地址族无关 |
| 非回环目标（`example.com`、`192.168.1.5`） | ❌ 不换 | **绝不猜**。只认 `localhost` / `127.0.0.1` / `::1` |

还有两个实现上的坑，都写进注释了：

- **`URL.hostname` 设置 IPv6 必须带方括号。** `u.hostname = '::1'` 会被**静默忽略**
  —— 不报错、URL 原样不变。必须写 `u.hostname = '[::1]'`。
- **Happy Eyeballs 失败时错误是聚合的。** `e.cause.code` 是 `undefined`，真正的失败码在
  `e.cause.errors[]` 数组里。判断「所有地址都被拒」必须读数组，只有全部是
  `ECONNREFUSED` 才值得换名。

### 界面上看得见

填的地址和实际连上的不一致时，面板不会闷声换掉：

- 顶栏探测条显示 `在线 200 · 12ms · 经 localhost 连通`
- 会话卡片的**后端通道**区块写明「你填的是 `127.0.0.1`，该地址上没有服务在听，已自动改用
  `localhost` 连上」，并给出真正的后端基址
- **Cookie 提示也按实际连通的主机名算**，不是按配置里填的那个 —— 否则会出现
  「界面说同主机名，浏览器却因跨站把 Cookie 拦了」的错位

为什么要这么啰嗦：面板悄悄换了名字连上，表面上一切正常，但换台机器或后端换了绑定方式，
同一份配置就忽然不通，而且毫无线索。把这条摆出来，问题从「靠猜」变成「一眼」。

### 关掉它

配置 → 请求头 → **回环主机名自动兜底**（对应 `state.json` 的 `autoLoopback`）。

关掉后只连你填的那一个，连不上就如实报错，`attemptedHosts` 也只有一项。
老配置里没有这个字段时按**开启**处理（`!== false`），前后端都这么判，无需迁移。

> 更省心的做法：**直接填 `localhost`**。它是唯一能同时覆盖 IPv4 和 IPv6 的写法，
> 兜底就是为「懒得改配置」和「历史配置已经写死了 127」准备的。

### ⚠️ 后端把 Cookie 的 Domain 写死了（本项目最深的一个坑）

真实后端（tsie 框架）登录时下发的是：

```
Set-Cookie: Authorization=<JWT>; Path=/; HttpOnly; Domain=127.0.0.1
Set-Cookie: JSESSIONID=<...>;   Path=/pds-std; HttpOnly
```

**`Domain=127.0.0.1` 是服务端写死的，面板改不了。** 后果非常反直觉：

| 你在哪个地址登录 | 浏览器怎么处理 `Authorization` | 业务接口结果 |
| --- | --- | --- |
| `http://127.0.0.1:8080` | ✅ 正常接受 | `T200`，有登录态 |
| `http://localhost:8080` | ❌ **静默拒收**（只有 `JSESSIONID` 能落地） | `T302 请先登录` |

浏览器拒收是**静默的**：登录接口照样返回 `retCode: T200 登录成功`，界面上看不出任何错误，
但那条 Cookie 根本没进浏览器罐 —— 于是「登录成功了，打开系统还是请先登录」。

这一点**跟本工具无关**：即使你在 `localhost` 上的业务页面里手点登录，也一样拿不到登录态。
（已用 CDP 实测：在 `localhost:8080` 页面内 `fetch` 登录接口，罐里只有 `JSESSIONID`，
随后请求 `/api/pf/tenant/all` 得到 `T302`；换成 `127.0.0.1:8080` 立刻 `T200`。）

**所以**：想有登录态，浏览器地址栏的主机名必须就是后端写死的那个 —— `127.0.0.1`。
面板现在会读出会话 Cookie 里的 `Domain` 并在界面上直接提示这件事。

> 本工具的双主机名桥仍然有效，但要理解它的作用边界：它解决的是
> 「**Cookie 已经在手里，怎么让两个主机名都带上**」。
> 如果后端从一开始就拒绝把 Cookie 交给 `localhost`，那桥也无从修补 ——
> 这时桥的价值在于：你在 `127.0.0.1` 上登录拿到 Cookie 后，桥把它同步到 `localhost`，
> 于是 `localhost:8080` 也能直接用（这是 CDP 实测通过的：两个主机名都返回 `T200`）。
> 区别只在**谁去登录**：让面板去登录（它能在 127 上成功拿到 Cookie），而不是在 localhost 页面里登录。


#### 桥为什么必须用 SameSite=None; Secure

这一条是实测出来的，不是猜的：桥页面跑在**跨站 iframe** 里，属于第三方上下文，
Chrome 对在那里写 Cookie 有硬限制。四种写法各试一遍：

| Set-Cookie 写法 | 跨站 iframe 里能否落地 |
| --- | --- |
| `Path=/`（不带 SameSite） | ❌ 被静默丢弃 |
| `SameSite=Lax` | ❌ 被静默丢弃 |
| `SameSite=None`（不带 Secure） | ❌ 被静默丢弃 |
| `SameSite=None; Secure` | ✅ **能落地** |

好消息是 `localhost` / `127.0.0.1` 被浏览器当作可信来源（secure context），
所以 `Secure` 挂在 `http://` 上也不会被拒 —— 正好能用。

相应地，**清除时过期属性的写法必须跟写入时完全一致**（同样带 `SameSite=None; Secure`），
否则浏览器认为那是另一个 Cookie，旧的原封不动留着。

另外，服务会**同时监听 `127.0.0.1` 和 `::1`**。原因：Windows 上 `localhost` 常先解析到 `::1`，
若只在 `127.0.0.1` 上应答，从 `127.0.0.1` 打开的页面就桥不到 `localhost`，那半边永远是空罐。

### 清除

点 **清除** 即可从浏览器罐里抹掉（两个主机名一起清）。这个入口**不依赖页面内存状态** ——
刷新页面后会话没了、`written` 记录清零，按钮依然在，照样能清干净。
（判据是「配置里的会话 Cookie 名 + JSESSIONID」，配合服务端回读罐内实况。）

---

## 怎么用

**组合** 是这个工具的核心：一个组合 = 「账号 + 租户」。点一下 = 登录 + 切租户，一步到位。

- 左侧点**账号** → 只登录，租户保持当前
- 左侧点**租户** → 只切租户，账号保持当前
- 点**组合** → 登录 + 切租户一起做
- **请求调试** 区直接打后端，自动带上当前 Token / 租户头，可勾选是否携带
- 「复制 curl」能把你刚发的请求（含完整鉴权头）复制成命令行，方便贴到终端或分享给同事
- 「导入 Cookie」可以从浏览器搬一个现成会话进来，**不调用登录接口**（详见下文）

### 租户太多？用筛选

真实环境租户动辄几十上百条，一直往下滑很烦。租户列表上方有个筛选框：

| 操作 | 效果 |
|---|---|
| 直接输入 | **输入即过滤**，边打字边缩 |
| 输入 `阿尔法` | 按**名称**模糊匹配（`阿尔法科技`、`阿尔法新能源分公司`） |
| 输入 `T_BETA` | 也能按**租户 ID / 编码**匹配 |
| 输入 `阿尔法 分公司` | **空格分隔 = 多关键词取交集**，只留同时含这两个词的 |
| 大小写 | 不敏感，`gamma` 能匹配 `T_GAMMA` |
| 按 `Esc` | 一键清空、恢复全部 |

两个细节：

- 右侧计数显示 `命中数 / 总数`（如 `2 / 47`），无匹配时变红提示 `0 / 47`，不会让你对着空白列表发呆
- 列表区**自己滚动**（最高 420px），不会把整个侧栏拉成一条长龙；底部有一层渐隐，提示「下面还有」，滚到底自动消失

### 组合里选租户也能搜

「新建组合」弹窗里的租户字段不是原生下拉，而是**可搜索的选择框**——几百条租户靠滚动找是不可能的。

| 操作 | 效果 |
|---|---|
| 点一下输入框 | 展开列表，同时**全选已有文字**，一打字就整体替换 |
| 输入关键字 | 边打字边过滤，规则和上面的租户筛选完全一致（名称 / ID / 空格多关键词） |
| `↑` `↓` | 在结果里移动高亮，会自动滚到可见处 |
| `Enter` | 选中高亮项；只有一条命中时直接回车就选它（多条又没高亮则不猜，避免选错） |
| 点某一行 | 选中它，填入真实 `tenantId` |
| `Esc` | **只收起下拉，不关弹窗** |
| 直接点别处（放弃） | 显示还原成已选值，不会留下半截搜索词 |

三个细节：

- 最多渲染 **120 条**，超出的在列表底部提示「还有 N 条，继续输入可缩小范围」——全画出来没必要，也没人滚到第 200 条以后
- ID 只显示**能区分的尾 8 位**（如 `…75520002`）。真实 ID 是 32 位哈希，前面二十来位 584 条全一样，整串摆出来既挤掉中文名的宽度、又没法区分。鼠标悬停能看到完整名称 + 完整 ID
- 带这种字段的弹窗会自动加宽到 520px，长租户名（`华能新疆能源开发有限公司布尔津风力发电分公司`）能一行显示完

---

## 配置文件

所有配置存在 `data/state.json`，也可以直接手改（改完刷新页面生效）。

```jsonc
{
  "target": "http://localhost:8080",     // 后端地址。回环地址填 localhost 最稳（同时覆盖 IPv4/IPv6）
  "requestTimeoutMs": 30000,
  "autoLoopback": true,                  // 连不上时自动换回环主机名重试一次（缺省即开启）

  "login": {
    "enabled": true,
    "method": "POST",
    "path": "/pds-std/api/login",
    "contentType": "json",               // json | form
    "bodyTemplate": "{\"username\":\"{{username}}\",\"password\":\"{{password}}\"}",
    "tokenSource": "cookie",             // cookie | header | body
    "tokenHeaderName": "Authorization",  // Cookie / 响应头里的凭证名
    "tokenPath": "data.accessToken",     // tokenSource=body 时才用
    "successPath": "retCode",            // 业务成功码字段，留空则只看 HTTP 状态
    "successValue": "T200",
    "headersTemplate": "{}",
    "saveCookies": true
  },

  "tenantSwitch": {                      // 关闭则只切本地注入的租户头
    "enabled": true,
    "method": "POST",
    "path": "/pds-std/api/switchTenant",
    "contentType": "form",               // form | json
    "bodyTemplate": "{\"tenantId\":\"{{tenantId}}\"}",
    "successPath": "retCode",
    "successValue": "T200"
  },

  "tenantList": {                        // 用于「⟳ 拉取」
    "enabled": true,
    "path": "/pds-std/api/pf/tenant/all",
    "listPath": "data",
    "idField": "tenantId",
    "nameField": "name",
    "successPath": "retCode",
    "successValue": "T200"
  },

  "authHeader":   { "enabled": false, "name": "Authorization", "valueTemplate": "Bearer {{token}}" },
  "tenantHeader": { "enabled": false, "name": "X-Tenant-Id",   "valueTemplate": "{{tenantId}}" },
  "extraHeaders": "{}",

  "accounts": [ { "id": "acc_admin", "name": "管理员", "username": "admin", "password": "123456" } ],
  "tenants":  [ { "id": "t_demo", "name": "演示租户", "code": "demo" } ],
  "combos":   [ { "id": "combo_1", "name": "超管 @ 演示租户", "accountId": "acc_admin", "tenantId": "t_demo" } ]
}
```

### 可用模板变量

| 场景 | 变量 |
|---|---|
| 登录请求体 | `{{username}}` `{{password}}` `{{accountName}}` |
| 切租户请求体 | `{{tenantId}}` `{{tenantCode}}` `{{tenantName}}` |
| Token 头 | `{{token}}` |
| 租户头 | `{{tenantId}}` `{{tenantCode}}` `{{tenantName}}` |

---

## 回归测试

改完 `app.js` 想确认没把上面的协议判断改坏，跑这个：

```bash
node .e2e/e2e.js
```

它会自动做这些事，**不碰你真实的配置和账号**：

1. 在 `9082` 起一个「假 tsie 后端」（`.e2e/tsie-mock.js`），刻意复刻那 4 个坑：
   HTTP 200 返回 `T401`/`T302`、JWT 只走 `Set-Cookie: Authorization`、
   切租户失败也回 `T200`、路径带 `/pds-std/api` 前缀
2. 在 `4600` 起一份面板副本，用独立生成的 `data/state.json`（测试账号 `e2e / pass1234`），
   假后端里备了 7 个租户（含中英文名、长 ID、同名分公司）用来验证筛选
3. 用真 Chrome（headless + CDP）跑完 **110 项断言**，跑完自动清理

> ⚠️ 同一时间**只能跑一份**。它固定用 4600（面板）/ 9082（假后端）/ 9333（CDP）三个端口，
> 并发跑会互相抢端口，症状是「面板已加载 ❌ / doLogin is not defined」——那不是代码坏了。

> ⚠️ **项目路径别带中文**（或至少别指望 `fs.cpSync`）。Node 22.22.2 上，只要路径里有中文，
> `fs.cpSync` 会让整个 node 进程**直接崩掉** —— 退出码 `0xC0000409`（STATUS_STACK_BUFFER_OVERRUN），
> 没有 JS 异常、没有任何输出，表现就是「脚本一声不响地退出了」，退出码看着还像 127（命令找不到），
> 极容易误判成权限问题或路径写错。
> 本项目已改为 `readdir` + `copyFileSync` 手写递归复制，所以放在 `E:\学习项目\` 下也能正常跑。
> 如果你要往 `.e2e/` 里加代码，**别再用 `cpSync`**。

覆盖点：

- **协议层**：登录取 Cookie 里的 JWT、拉租户、切租户、**切租户失败不被 T200 骗过去**、
  未登录 `T302` 判定、密码错误 `T401` 判定
- **锁定态**：锁定计数与熔断、**`data` 字段透出与原因翻译**、警告态不被误判为锁定态
- **租户筛选**：按名称 / 按 ID、大小写不敏感、多关键词交集、无匹配计数 `0 / N` 与提示文案、清空恢复、
  **筛选时输入框不丢焦点、光标位置不跳**、**同一帧内连打多键只重绘一次**（rAF 合并）
- **列表滚动**：高度被限制在 420px、内部可滚动、顶部有渐隐、滚到底渐隐消失
- **组合弹窗的租户选择**：名称 / ID / 多关键词搜索、无匹配提示、点选写入真实 `tenantId`、
  键盘 `↓`+`Enter` 选中、`Esc` 只收下拉不关弹窗、放弃选择还原已选值、
  长哈希 ID 只显示唯一尾 8 位、短 ID 原样显示
- **写入浏览器 Cookie**（用 CDP 的 `Network.getAllCookies` 直接查浏览器罐，这是唯一可信的证据）：
  写入前罐里干净、写入后罐里真的出现 `Authorization`、**`HttpOnly` 属性被原样复刻**、
  JS 读不到 `HttpOnly` 项（符合预期而非失败）、界面状态文字如实反映、**同主机不同端口能带上**
- **双主机名同步（Cookie 桥）**：直写接口只落在本主机名、`localhost` 那边确实带不上（这就是要桥的原因）、
  桥后**两个主机名上都有 `Authorization` 且都是 `HttpOnly`**、`localhost:8080` 能带上登录态、
  **清除时两边一起清干净**
- **后端硬编码 Domain 的提示**：能从会话里读出 `Domain`、面板与它不一致时界面给出明确警告
  （否则用户只会觉得工具坏了）
- **持久性**：刷新页面后罐里仍在且清除入口不消失、**刷新后仍能清干净**（不依赖内存状态）
- **回环主机名兜底**（16 项）：先确认 `[::1]` 上确实连不上（前提成立才谈得上兜底）、
  填 `[::1]` 时自动换名连上、回报 `askedHost` / `host` / `hostSwitched` / `resolvedBase`、
  换名后拿到的是真数据而非空壳 200、**关掉 `autoLoopback` 后如实失败且只试一个主机名**、
  非回环目标（`127.0.0.2`）绝不换名猜测、**Cookie 提示跟随实际连通的主机名而非配置**、
  老配置缺字段时补成 `true` 且复选框如实显示已勾选
- 页面无 JS 异常

> 真实数据量验证：用你实际拉下来的 **584 个租户**测过，全量渲染约 46ms、
> 逐字输入命中后 1–7ms、最坏情况（输入「公司」命中 253 条）约 22ms，打字不卡。
>
> 组合弹窗的下拉也用这 584 条量过：刚展开渲染 120 条并提示「还有 465 条」，
> 下拉高 264px、底边 744 / 窗口 865，不溢出视口；输入「分公司」命中 69 条，
> **中文名截断 0 行**（改 ID 显示规则前是 4 行）。

输出全绿即正常：

```
🎉 全部通过
```

### 单独排查「Cookie 到底落到哪了」

想在你自己的机器上确认双主机名同步真的生效（不动配置、不碰账号）：

```bash
node .e2e/manual-check.js
```

它会用 127.0.0.1 打开**正在跑的 4599 面板**，走一遍桥接，然后打印
浏览器罐里 Cookie 落在哪个 domain、以及访问 `localhost:8080` / `127.0.0.1:8080`
时浏览器会不会带上。期望看到两个地址都是「是」。

另外两个专门查「登录了却没登录态」的脚本（都不打印任何 Cookie 明文）：

```bash
node .e2e/probe-login.js     # 真实账号打一次登录接口，只报 Cookie 名字与属性
node .e2e/domain-test.js     # 分别在 localhost / 127.0.0.1 页面内登录，看罐里到底落下了什么
```

`probe-login.js` 会直接暴露后端是否写了 `Domain=127.0.0.1`；
`domain-test.js` 会给出下表那种结论（`localhost` → `T302`、`127.0.0.1` → `T200`）。
这两个是定位「登录成功但业务系统仍要登录」最快的手段。

> 需要本机装了 Chrome（默认路径 `C:/Program Files/Google/Chrome/Application/chrome.exe`）。
> 只依赖 Node 内置模块和 Node 22 内置的 `WebSocket`，不用装任何 npm 包。

## 说明

- 需要 Node ≥ 18（用到了内置 `fetch`）
- 页面配置会写回 `data/state.json`；「恢复默认」会删掉该文件
- 会话（Token / Cookie）默认只存在页面内存里，刷新页面需重新登录；
  **登录成功后会自动写入浏览器 Cookie 罐**（也可手动点「写入浏览器」重做），
  之后浏览器里那份是浏览器自己持久化的，与本工具的刷新无关
- `mock-backend.js` 只是演示用的假后端，接真后端时不需要它
- `.e2e/` 是回归测试，日常使用不需要它，也不影响面板运行
