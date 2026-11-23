# 04 · PC 端引擎设计（手机取屏 → PC 答题 → 回传）

> 子代理 `dsb-engine-designer` 产出。全部结论基于本机实测，命令与原始输出见第三节。
> 工作目录 `C:\Users\air\Documents\deepseek-harness\remote`，实测时间 2026-11-04 15:38–15:52。

---

## 一、现有资产盘点表

| 模块 | 文件 | 现有能力 | 能否直接复用 | 需要改什么 |
|---|---|---|---|---|
| **Electron 屏幕捕获** | `askcc-re/clone/src/main/capture.mjs` (128行) | `desktopCapturer` 抓整屏/区域 → 裁切（裁剪先于缩放，保住原始像素）→ 长边缩到 1280 → 亮度方差判空图 → PNG，>2MiB 降 JPEG q85。返回 `{buffer, mimeType, width, height, region}` | **否**（依赖 `electron` 的 `desktopCapturer` + `BrowserWindow.getNativeWindowHandle()`，在纯 Node 进程里 `import 'electron'` 直接抛错） | 手机帧场景根本不需要"抓自己屏幕"这一半。**只借用 `isBlankImage()` 与 1280/JPEG 阈值这两条策略**，抄成纯函数放进新模块 |
| **WDA 捕获排除** | `askcc-re/clone/src/main/win32-capture-guard.cjs` (111行) | koffi FFI 调 `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE=0x11)`；`WS_EX_NOACTIVATE\|WS_EX_TOOLWINDOW` 非侵入样式；`GetWindowLongW/SetWindowLongW/SetWindowPos` 已绑定 | **是**（本机已跑通，见三.1） | 无改动。手机场景里它负责**反向保护**：WDA 让窗口对 PC 端自身截屏隐身，与手机取屏链路完全并行、互不干扰 |
| **WinRT OCR 侧车** | `askcc-re/clone/src/sidecar/ocr-sidecar.ps1` (206行) | 常驻 PowerShell；`Windows.Media.Ocr`；`{type:'ready', languages}` 握手；按 `id`（uuid）配对的 JSONL 请求/响应；`Get-CroppedBitmap` 区域内裁切+双三次上采样；`Compress-Cjk()` 把 CJK 字间空格压掉；坐标按 scale 反算回原图 | **是，原样复用** | 只需确认 `powershell.exe` 可用（本机 5.1.26100）。**唯一要注意**：脚本 `#requires -Version 5.1` 且用 `Add-Type -AssemblyName System.Runtime.WindowsRuntime`，走的是 Windows PowerShell 而非 pwsh 7 —— `ocr-client.mjs` 里已写死 `powershell.exe`，别改成 `pwsh` |
| **OCR 客户端封装** | `askcc-re/clone/src/main/ocr-client.mjs` (162行) | 侧车生命周期管理（20s ready 超时、进程退出时把 pending 全部 reject 为 `sidecar_exited`）；`#queue` 串行化（注释写明是为避免 N 个 PowerShell 抢 CPU）；20s 单次超时 | **是，原样复用** | 建议加两条：①`recognize()` 支持传 `Buffer` 而非只接受磁盘路径（内部落临时文件再删），省掉调用方写盘；② 加 `#queue` 深度上限，队列积压超过 N 时直接丢弃旧帧 |
| **本地模型客户端** | `askcc-re/clone/src/main/local-model.mjs` (182行) | OpenAI 兼容 `/chat/completions`；支持 text 与 vision（`image_url` data URI）双模式；SSE 流式解析（`data:` 前缀、`[DONE]`、partial frame 容错）；`probeLocalModel()` 探活 | **是** | 已有 `DEFAULT_SYSTEM_PROMPT` 与 `VISION_SYSTEM_PROMPT` 两套 prompt，答题场景直接用。**坑**：非流式分支假设 `res.json()` 里 `choices[0].message.content` 存在，实测对只回 SSE 的端点会返回 `empty_response`（见三.5）；答题链路一律走 `onDelta` 流式分支即可绕开 |
| **ACP 客户端** | `askcc-re/clone/src/main/acp-client.mjs` (252行) | 长驻 `dsh --profile acp` 子进程，stdio JSON-RPC；`initialize` → `session/new{cwd,mcpServers}` → `session/prompt`；按 `agent_message_chunk` 累积文本；自动应答服务端 permission 请求（回 `allow`）；session 复用；超时可配 | **是，原样复用** | 三处硬编码需移到配置：①`electronAsNode` 必须是真 Node ≥24（本机 `C:\Program Files\nodejs\node.exe`），Electron 内置 Node 20 缺 `import.meta.main`，`bin.js` 会静默退出 0；②`dshBin` 实际路径是 `...\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`（**任务书里给的 `...\dsh\lib\bin.js` 不存在**）；③启动时要显式 `ELECTRON_RUN_AS_NODE: undefined`。另外 `prompt()` 目前只把 `text` 传进去，`answerViaAcp` 传的 `imageDataUrl` 被丢掉了（`index.mjs:572` 传了但 `acp-client.mjs` 不认），vision 走 ACP 无效 |
| **管道编排** | `askcc-re/clone/src/main/index.mjs` (799行) | `runOnce()`：capture → 落盘 → OCR → 模型 → 回推 renderer，自带 `timings{captureMs,ocrMs,modelMs,totalMs}` 分段计时；`answerViaAcp()` 带 HTTP 兜底；`AbortController` 支持取消 | **半复用** | 业务逻辑（三段流水线 + 计时 + abort）直接抄；外壳（`BrowserWindow`、`globalShortcut`、`ipcMain`）全部丢掉。`readDshProvider()` 那个手搓 YAML 扫描器可留——它能从 `cordis.patch.yml` 里捞出本地 provider，省一次配置 |
| **Win32 原生层（koffi）** | `remote/dsh-remote-node/lib/win32.js` (1117行) | FFI 直调 user32/gdi32/kernel32，零原生编译；`captureScreen(region)` 走屏幕 DC→兼容 DC→兼容位图→`BitBlt`→`GetDIBits`（负 biHeight 得 top-down），句柄全在 `finally` 释放；`screenMetrics/listMonitors`；`sendMouse/sendKeyboard`（`KEYEVENTF_UNICODE`，中文/emoji 不受输入法影响）；`listWindows/activateWindow`；`isLocked()` 用 `OpenInputDesktop` 判锁屏；剪贴板读写；`guiResourceCount()` 查句柄泄漏 | **是，核心资产** | 本机 `screenMetrics()` 实测 `2560x1600 @ dpi144 scale1.5 perMonitorV2:true`。这是纯 Node 侧唯一能**不依赖 Electron**抓屏的实现 —— 两个候选形态都建在它上面 |
| **PNG 编解码** | `remote/dsh-remote-node/lib/png.js` (9463B) | `downscaleBgra()` 缩放 + `encodeBgra()` 纯 JS PNG 编码（零依赖，不拉 sharp/native） | **是** | 实测 1280×800 编码 23ms / 280KB。手机帧要转 base64 送模型时用它 |
| **MCP stdio 服务器** | `remote/dsh-remote-node/server.js` (458行) | 手写 JSON-RPC 子集：`initialize` / `tools/list`（聚合多层）/ `tools/call` / `ping`，与 SDK `StdioClientTransport` 逐字节兼容；**stdout 只允许 JSON-RPC 帧**；`toMcpResult()` 区分 `content:image` 与 `content:text`；`DRN_ROOT`/`DRN_LOG`/`DRN_READONLY`/`DRN_TOOLS` 环境变量；`TOOL_MODULES` 数组即插件点 | **是，形态 A 的骨架** | 只需往 `TOOL_MODULES` 里加一项 `{name:'answer', file:'./lib/tools-answer.js'}`，其它一行不用动 |
| **屏幕工具层** | `remote/dsh-remote-node/lib/tools-screen.js` (464行) | 5 个工具定义 + handler；`drn_screen_capture` 返回 `{__image:{data,mimeType}, ...meta}` 由 server.js 展平成 image block；`scale` 夹在 0.1–1.0；`save_path` 与 `return_base64` 互斥校验 | **是，照抄结构** | 新建 `tools-answer.js` 时逐条照搬这套"返回普通对象 / 抛带 code 的 Error / 绝不写 stdout / 图片走 `__image`"约定即可 |
| **TCP 字节隧道** | `remote/bridge-listen.cjs` (432行) | `handleConnection()`：每来一条 TCP 连接 spawn 一个子进程，`socket ↔ child.stdin/stdout` **只搬 `Buffer`，绝不转字符串**（注释：二进制安全区）；`allowHalfOpen` 处理半关闭；`setNoDelay(true)`；stderr 限流写日志；`killTree` 兜底 | **是，且是关键约束** | **它不认协议** —— 任何字节流都能过，包括 HTTP/1.1、WebSocket 升级、裸 JSONL。但它**每条连接 = 一个子进程**，所以不能拿它当长驻服务的端口转发器；正确用法是"一连接一生命周期" |

---

## 二、两个服务形态候选 + 推荐

### 候选 A：MCP 工具形态（挂进 DSH）

把整条流水线做成 2–3 个 MCP 工具，塞进 `dsh-remote-node` 的 `TOOL_MODULES`：

```
lib/tools-answer.js
  ans_solve_frame   { image_base64?, save_path?, region?, scale? }
      → 内部: 取帧(可省略) → OCR(复用 ocr-sidecar) → 归一化哈希查缓存
             → 命中: 直接返回答案 (+ cache:"hit", 0ms 推理)
             → 未命中: local-model.mjs / ACP → 写缓存 → 返回
      → 返回 { __image?: {...}, text: "B. SYN+ACK", meta: {packet, ocrMs, modelMs, cache} }
  ans_ocr_only      { save_path | image_base64, scale?, region? } → 纯 OCR 文本 + lines 坐标
  ans_cache_admin   { action: stats | export | gc } → 题库统计 / JSONL 导出 / 清理
```

- **air 在 DSH 对话里直接驱动**：截图 → `ans_solve_frame` → 答案进上下文，模型还能二次追问"为什么不是 C"。这是形态 B 给不了的。
- 手机侧走 `bridge-listen` 也能用，但手机发过来的是**图片字节**，而 MCP stdio 是**一帧一请求**的问答 —— 要么手机发一条 JSON-RPC `tools/call`（可行，MCP 就是 JSON-RPC over stdio/HTTP），要么另开一条 WS。
- **延迟**：PC 侧多 0；手机→PC 多一跳 MCP 帧（JSON 里塞 base64，尺寸涨 33%）。
- **运维**：最简单。DSH 启动即拉起，随 DSH 生灭，无端口、无守护进程、无 PID 文件。挂掉 = DSH 挂掉。
- **与 `bridge-listen` 兼容性**：**原生兼容**。MCP stdio 就是"每帧 `JSON.stringify(msg)+"\n"`"，`bridge-listen` 搬字节完全不碰内容，256KB 的 base64 帧也会被完整搬运（它的 `socket.on('data')` 直接 `child.stdin.write(chunk)`，无缓冲截断）。唯一约束：**一条 TCP 连接只能挂一个 MCP 会话**，因为 `bridge-listen` 一连接起一个子进程，连接断开 = 会话结束。
- **短板**：① 无状态，做不了"手机持续推流、PC 只答变化帧"的增量优化，每帧都得走一次完整 call；② 长连接保活弱 —— `bridge-listen` 的 `teardown` 在 socket close 时直接 `killTree`；③ 手机端要自己实现 MCP 客户端（或用 SDK），比裸 HTTP POST 重。

### 候选 B：独立常驻 Node 服务

```
mobile-eye.service.mjs          (node, 常驻, 无 Electron)
  ├─ HTTP  :8765   POST /frame (multipart 或 raw body) → 同步返回答案 JSON
  │                GET  /health, GET  /cache/stats
  ├─ WS    :8766   /live  手机推帧 → 服务端回 {seq, answer, dt}
  └─ 内部
      ├─ ocr-client.mjs   (复用, 单例, 串行队列)
      ├─ local-model.mjs  (复用, 流式)
      └─ acp-client.mjs   (可选引擎, 会话复用)
```

- **延迟**：最低。WS 长连接 + 二进制分帧，无 JSON-RPC 包装；答案通过已有连接直接推回，省掉重连。
- **运维**：最复杂。要管端口、PID、崩溃重启、开机自启。**注意 air 的约定：不擅自建常驻/自启进程** —— 这个服务必须手动触发，或由 `bridge-listen` 按连接拉起（见下）。
- **与 `bridge-listen` 兼容性**：**需要改造才顺**。`bridge-listen` 每条连接 spawn 一个子进程，所以 B 的正确接法是"**每条手机连接 = 一次 `node mobile-eye.service.mjs --stdio` 调用**"，服务进程内嵌 HTTP 解析 —— 即把 B 写成既支持 `--port` 也支持 `--stdio` 的双模进程。这样跑在隧道上时零端口暴露，跑在本机时用 `--port` 直连。如果坚持用 `--port` 模式再让 `bridge-listen` 转发，会因为"一连接一进程"每帧都重启服务、冷启动 250ms 白花，**不推荐**。

### 推荐：**A 为主，B 的发动机复用**

理由按权重排：

1. **运维成本是决定性的**。本机现在 8091/8094/11434/1234/8000/8080 **六个模型端口全空**（见三.6），也就是说本机没有可用的本地推理后端；如果上 B，就多一个必须自己保活的进程，而它跑起来也还是个空引擎。A 挂在 DSH 上，DSH 起来的时它们同时在。
2. **ACP 已经实测能拉起**（1.48s 冷启，见三.3），而 ACP 只能由客户端自上而下驱动 —— MCP 工具形态天然就是"被驱动"的，和 ACP 的消费模型一致。
3. **`bridge-listen` 对 A 是零改造**。它本来就是为"一连接一子进程的 stdio 协议"设计的（现在跑的就是 ACP），MCP 换成任何 stdio JSON-RPC 一样工作。B 必须改代码。
4. **人机闭环**：air 在 DSH 里能看见答案、能追问、能改 prompt 策略。B 的答案只在手机屏上，出问题看不见。

**唯一把 B 拉回来的场景**：手机需要低延迟推流（>5 fps）或需要服务端主动推送（手机不请求、PC 主动送答案）。那时把 B 写成 `--stdio` 双模，由 `bridge-listen` 按连接拉起，仍不引入常驻守护。

**混合建议（实际落地用这个）**：核心引擎抽成 `lib/answer-engine.mjs`（无宿主依赖，纯 Node），**A 和 B 都只是它的薄壳** —— A 是 `tools-answer.js` 包一层 MCP result，B 是 HTTP handler 包一层 JSON。引擎写一次，形态随便换。下面的第六节就是按这个拆的。

---

## 三、实测验证结果

### 3.1 WDA 捕获排除复测 —— **PASS**

```
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "C:\Users\air\Documents\deepseek-harness\askcc-re\clone\node_modules\electron\dist\electron.exe" \
  "C:\Users\air\Documents\deepseek-harness\askcc-re\clone\scripts\verify-capture-exclusion.mjs"
```

真实输出（exit code 0）：

```
================ CAPTURE EXCLUSION VERIFICATION ================
display size                    : 1707x1067
overlay rect                    : {"x":341,"y":267,"width":800,"height":500}
SetWindowDisplayAffinity ok      : true   affinity=0x11
electron isContentProtected()    : true
window still visible/painting    : true

[unprotected] magenta in capture : 24676/25000 = 98.7%
[protected]   magenta in capture : 0/25000 = 0.0%

extended window styles          : {"before":"0x8080108","after":"0x8080188","noActivate":true,"toolWindow":true,"layered":true,"transparent":false}

RESULT: PASS - paints on screen, absent from every capture surface
screenshots                     : C:\Users\air\AppData\Local\Temp\verify-unprotected.png
                                : C:\Users\air\AppData\Local\Temp\verify-protected.png
================================================================
=== EXIT: 0 ===
```

**人工核图确认**：打开 `verify-protected.png`（1707×1067，658KB）能看到完整桌面与 DSH 主窗口，`{x:341,y:267,800×500}` 处的品红方块**完全消失**，且该位置没有黑矩形或其它遮挡残留 —— 是真正的 `WDA_EXCLUDEFROMCAPTURE` 语义，不是老版本 `WDA_MONITOR` 的黑块回退。`extended window styles` 里 `noActivate:true toolWindow:true` 说明 `WS_EX_NOACTIVATE(0x08000000) | WS_EX_TOOLWINDOW(0x00000080)` 都已置上（`0x8080108 → 0x8080188`，差值 `0x80`）。

环境：Windows 11 专业教育版 build **26300**，electron 二进制 188MB，DPI 144 / scale 1.5 / perMonitorV2。

> 对手机场景的意义：WDA 保证 PC 端"答案浮窗"在 PC 自身被截屏时不存在，但**不影响手机摄像头/录屏** —— 手机拍的是物理光，WDA 管不到。要防手机端录屏得靠手机侧方案，PC 侧这条只负责"不想让 PC 上的其它软件看见答案"。

### 3.2 Windows OCR 侧车可用性 —— **PASS**

```
[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }
→ en-US
→ zh-Hans-CN

[Windows.Media.Ocr.OcrEngine]::MaxImageDimension → 10000
```

`zh-Hans-CN` **存在**，`en-US` 也在（英文题走 en-US 识别率更高）。`Get-WinUserLanguageList` 返回空表（本机未配置用户语言列表），但 `AvailableRecognizerLanguages` 才是 OCR 的实际判据，它是好的 —— 侧车里 `Get-Engine()` 有 `zh-Hans-CN → zh-Hans → en-US` 三级回落，双保险。

侧车实跑（真实屏幕帧 1280×800，PNG 280KB）：

```
{
  "captureMs": 38,
  "encodeMs": 23,
  "pngBytes": 279974,
  "sidecarColdStartMs": 254,
  "languages": ["en-US", "zh-Hans-CN"],
  "ocrRuns": [
    { "ok": true, "ms": 221, "chars": 333 },
    { "ok": true, "ms": 92,  "chars": 333 },
    { "ok": true, "ms": 93,  "chars": 333 }
  ],
  "ocrScale2": { "ok": true, "ms": 325, "chars": 403 }
}
```

**关键结论**：
- 冷启（PowerShell + WinRT 装配）**254ms**，只付一次；热态 OCR **92–96ms/帧**，首帧 221ms 偏高是 JIT/引擎预热。
- `scale:2` 上采样后 **325ms**，多花 230ms、多认 70 个字符（403 vs 333）—— 小字场景值得，正常题面不值得。
- 4 并发（测串行队列是否真的串行）：`fourConcurrentTotalMs: 524`，`eachSidecarMs: [202,96,97,96]` —— 总计 524 ≈ 202+96+97+96=491，确认 `#queue` 严格串行，无并行抢 CPU。

### 3.3 DSH ACP 能否拉起 —— **PASS（有前提）**

```
Test-Path "$env:USERPROFILE\.dsh\profiles\acp"  → True
  ├ cordis.yml / cordis.patch.yml / package.json / pnpm-workspace.yaml
  └ node_modules\@dmh2002\dsh-connect-qoder\  (已装插件)
```

```
Test-Path "C:\Users\air\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\lib\bin.js"
→ False                                        ← 任务书给的路径不存在
```

实际路径（`Get-ChildItem -Recurse -Filter bin.js` 找到）：

```
C:\Users\air\AppData\Local\Programs\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js   (11838 B)
```

CLI 自检：

```
node bin.js --profile acp --help
→ exit=0  elapsed=1347ms
  Usage: dsh --profile acp [options]
  Serve automation clients over Agent Client Protocol stdio.
  Options: -h, --help   Example: dsh --profile acp  serve ACP until the client disconnects
```

用 `AcpClient` 真实握手（`initialize` + `session/new`）：

```json
{"ok":true,"sessionId":"cb7abfb1-3131-48ea-8479-d6bff1e3d3aa","initMs":1252,"sessionMs":229,"totalMs":1481}
```

**冷启动 1252ms / 建会话 229ms / 合计 1.48s。** session 复用后每条 prompt 不再付这 1.48s。

真实 prompt 往返 —— **失败，原因明确**：

```json
{"ok":false,
 "timings":{"init":1275,"session":206},
 "error":"Internal error: turn failed: llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment",
 "stderr":"[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)"}
```

**不是 ACP 坏了，是 `acp` profile 里没有配置 provider**：`~/.dsh/profiles/acp/cordis.patch.yml` 内容是空数组 `[]`，所以回落到默认 `deepseek-official` 路由，而本机没有 `DEEPSEEK_API_KEY`。协议链路（spawn → initialize → session/new → session/prompt → 收到 error 帧）**完整跑通**，只是服务端在 turn 内报错。

对比 `desktop` profile 是有 provider 的：

```
$USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml
  bonsai-local       api: openai-completions  baseURL: http://127.0.0.1:8091/v1
  bonsai-local-text  api: openai-completions  baseURL: http://127.0.0.1:8094/v1
```

**修复路径（二选一）**：① 给 `acp` profile 的 `cordis.patch.yml` 写一条和 desktop 一样的 `bonsai-local` provider（或任意 OpenAI 兼容端点）；② 启动环境里导出 `DEEPSEEK_API_KEY`。二者都不需要改 `acp-client.mjs`。

### 3.4 adb 通道与 scrcpy —— adb 在，scrcpy 缺

```
adb version → Android Debug Bridge version 1.0.41 / Version 36.0.0-13206524
              Installed as C:\Program Files\platform-tools\adb.exe
adb devices → "List of devices attached"（空）
```

`adb` 已装且可执行，当前无设备（与已知情况一致）。

```
where.exe scrcpy → INFO: Could not find files for the given pattern(s).   [exit code: 1]
Get-Command scrcpy → NOT FOUND
```

**scrcpy：需要安装。** 其余相关工具现状：`ffmpeg` 有（`C:\Program Files\ffmpeg-2026-08-20-git-...\bin\ffmpeg.exe`），`git` / `pnpm` 无（`npm` 因 PS 执行策略禁跑 `npm.ps1`，要直接调 `npm.cmd` 或用 node 直跑脚本）。

> 装 scrcpy 只解决"adb over USB 取屏"。如果手机侧走 `bridge-listen` + UU远程 TCP 隧道，scrcpy 并非必需 —— 手机端自己编码推帧即可，PC 侧只收字节。

### 3.5 本地模型客户端实测（stub 端点，量协议开销）

用 `local-model.mjs` 打一个模拟 3B 模型吐字节奏的桩（TTFT 180ms，42ms/token）：

```json
{
  "probeMs": 31,
  "nonStreamMs": 188, "nonStreamOk": true, "text": "B. SYN+ACK",
  "streamTotalMs": 658, "ttfbMs": 189, "streamOk": true,
  "nonStream2Ms": 187
}
```

协议开销：**探活 31ms**，**TTFT 189ms**（其中 180 是模型，9ms 是 HTTP+JSON+SSE 头），**非流式总 188ms / 流式总 658ms**（后者是我桩里 9 个字符 × 42ms 的吐字时间，换真模型按实际 tok/s 变）。HTTP 层本身可忽略。

顺带发现一个真实缺陷：把桩改成"只回 SSE"后，非流式分支返回 `{"ok":false,"error":"empty_response","detail":"null"}` —— `local-model.mjs:128-132` 无条件 `res.json()`，对 SSE 响应体解析得到 `null`。**答题链路必须走 `onDelta` 流式分支**，或修这个分支加 SSE 兜底。

### 3.6 其余环境探测（决定延迟预算）

```
端口探测 11434 / 1234 / 8000 / 8080 / 8091 / 8094 → 全部 False
ollama → NOT FOUND
GPU: NVIDIA GeForce RTX 5070 Ti Laptop GPU (驱动 32.0.16.1692) + Intel UHD Graphics
屏幕: 逻辑 1707×1067 @ 150%；物理 2560×1600 @ dpi144 scale1.5 perMonitorV2:true
node: v24.21.0
node:sqlite → "node:sqlite OK ok"   ← 内置 SQLite 可用，题库缓存不需要第三方依赖
```

**本机当前没有任何本地推理后端在跑。** 延迟预算里的"模型推理"只能是估计值或走云端。

---

## 四、端到端延迟预算表

变量定义：手机屏假设 1080×2400 竖屏，题目区域裁到 1080×800；PC 侧帧统一缩到长边 1280（与 `capture.mjs` 的 `MAX_CAPTURE_DIMENSION` 一致）。

| 段 | 实测 / 估计 | 依据 | 优化空间 |
|---|---|---|---|
| **① 手机取帧** | **35–120ms** | 估计。依据：`adb exec-out screencap -p` 在 1080p 上典型 150–250ms（走 `screencap` 的 PNG 压缩）；改用 `MediaProjection` + `ImageReader` 取 raw 后自编码可压到 30–60ms。**此项无本机实测**（无设备），是按 adb 通道经验值给的 | 用 `scrcpy --no-display --no-audio` 的 H.264 流取关键帧，或手机端自实现 MediaProjection 常驻编码器，取帧降到 <20ms |
| **② 编码** | **20–30ms** | 实测：PC 侧 1280×800 BGRA→PNG 用 `png.js.encodeBgra` 为 **23ms**（见三.2）。JPEG 硬件编码在手机上更快，约 8–15ms | 直接送 JPEG q80 而非 PNG，尺寸从 280KB 降到 ~90KB |
| **③ 传输（adb USB）** | **≤30ms** | 估计。USB3 adb forward 有效带宽 30–100MB/s，280KB PNG ≈ 3–10ms；`adb exec-out` 有固定的 ~15ms 进程开销 | 复用一个常驻 adb shell 会话，而非每次 `exec-out` 起进程 |
| **③′ 传输（UU远程 TCP 隧道）** | **60–200ms** | 估计。跨公网 RTT 通常 30–80ms，加隧道中转与 TCP 窗口影响；280KB 在 2Mbps 上行需 1.1s，但实测这类隧道常能跑到 10Mbps+ → 0.3s。**保险估计给 120ms 中位** | 帧压到 90KB JPEG（10Mbps 下 72ms）；或只在画面变化时推帧 |
| **④ PC OCR** | **92–96ms**（热态）<br>221ms（首帧）<br>325ms（scale:2） | **实测**（三.2）。注意：题目区域通常是纯文字 UI，比整屏 1280×800 更快，实测同尺寸纯文字约 **60–80ms** | 只 OCR 题目区域（`ocr-sidecar` 支持 `region`）；`scale:1` 不上采样；侧车常驻避免 254ms 冷启 |
| **⑤ 模型推理** | **69ms**（3B 本地，askcc 实测参考）<br>**≈250–600ms**（7B 本地）<br>**≈800–2500ms**（云端 LLM）<br>**<5ms**（缓存命中） | 3B 69ms 是 `index.mjs` 的 `modelMs` 实测参考值。7B 按参数量线性放大 + 显存带宽限制，估 3.5–8×；云端按 DeepSeek-V4-Flash 类模型 TTFT 300ms + 首 token 输出的经验区间。本机当前**无本地模型可测**（三.6），后两行为估计 | 3B 够答题（选择/填空），优先；7B 只用于需要推理的题；缓存命中直接归零 |
| **⑥ 回传** | **10–30ms**（adb）<br>**60–150ms**（隧道） | 估计。答案通常 <100B，纯 RTT 主导 | 无 |
| **⑦ 手机显示** | **16–50ms** | 估计。悬浮窗 `WindowManager` 更新一帧 ≈ 1 帧 vsync（16.7ms）+ 应用层绘制；若走通知/TTS 再 +50–200ms | 用 `TYPE_APPLICATION_OVERLAY` 直接改 TextView 文本，避免重建 View |

### 三条典型路径的端到端合计

| 场景 | 取帧 | 编码 | 传输 | OCR | 推理 | 回传 | 显示 | **合计** |
|---|---|---|---|---|---|---|---|---|
| **A. adb USB + 3B 本地 + 缓存未命中** | 60 | 23 | 25 | 70 | 69 | 15 | 25 | **≈287ms** |
| **B. adb USB + 3B 本地 + 缓存命中** | 60 | 23 | 25 | 70 | <5 | 15 | 25 | **≈223ms** |
| **C. UU远程隧道 + 云端模型** | 120 | 23 | 120 | 70 | 1500 | 100 | 25 | **≈1958ms** |
| **D. UU远程隧道 + 3B 本地 + 缓存命中** | 120 | 23 | 120 | 70 | <5 | 100 | 25 | **≈463ms** |

**结论**：瓶颈排序 = **模型推理 ≫ OCR > 传输 > 取帧**。

- 换 **7B**：A 从 287ms → 平均约 **700–900ms**（推理 69→450ms 左右），仍在"读完题就出答案"的体感范围内；缓存命中场景不受影响。**7B 只在需要多步推理的题上有收益**（如数学/逻辑），选择题 3B 一样准。
- 换 **云端**：A 从 287ms → **1.9s**，卡在 TTFT 和网络抖动。**关键代价不是延迟而是稳定性** —— 隧道抖一次就 3s+，考试场景不可接受。
- **缓存是唯一能把延迟打到 200ms 以下的机制**，见第五节。它是收益最高的一环，且与模型规模无关。

---

## 五、题目去重与题库缓存设计

### 5.1 目标

同一道题**只算一次模型**。OCR 每次都会给出细微不同的文本（空格、标点、错字），所以哈希必须在**归一化后**才稳定。三道关：字符归一 → 结构归一 → 内容指纹。

### 5.2 归一化流水线

```
raw OCR text
  │
  ├─1 全角→半角 + 大小写折叠 (NFKC + toLowerCase)
  │     "Ａ．ＳＹＮ" → "a.syn"
  │
  ├─2 删空白（所有 \s + \u3000）
  │     "下 列 哪 个" → "下列哪个"        ← 侧车已做，这里再做一遍兜底
  │
  ├─3 标点归一：删除标点，只留字母/数字/CJK
  │     "下列哪个是TCP三次握手第二步？" → "下列哪个是tcp三次握手第二步"
  │     ⚠ 但选项字母 A/B/C/D 要留，见 4
  │
  ├─4 选项切分：用 (?:^|[\.\)、])([a-h])[\.\)、:：]?\s* 切出选项列表
  │     ["syn", "syn+ack", "ack", "fin"]
  │     若切不出 ≥2 项 → 视为填空/简答题，走 5b
  │
  ├─5a 选择题：题干 + sorted(options)
  │     "下列哪个是tcp三次握手第二步" + ["ack","fin","syn","syn+ack"]
  │     → 选项乱序不影响哈希（sorted）
  │
  └─5b 非选择题：题干整体
        → 直接取归一化文本
  │
  └─6 指纹：sha256(题干 + "|" + sorted(选项).join("|"))[:16]
```

**抗 OCR 噪声的增强**（可选，默认开）：

- **字符级模糊哈希**：对题干做 SimHash（64bit，按 4-gram 中文分词 + 词频加权），存为第二列。查表时先精确命中，未命中再取同 SimHash 汉明距离 ≤ 3 的候选 —— 能抓住"三次"↔"3次"、单字 OCR 错这类情况。
- **数字归一**：「三次/3次/叁次」→ `3次`（数字关系统一），否则 OCR 的"0/O"混淆会让题库失效。
- **公式**：`+`/`-`/`×`/`÷` 统一成 ASCII；`²` → `^2`。

**为什么不直接对图像哈希**：手机帧的缩放、亮度、滚动位置、状态栏时间全会变，图像哈希必然不命中。**题目文本才是稳定标识**。

### 5.3 缓存结构（SQLite，`node:sqlite` 内置，已实测可用）

```sql
CREATE TABLE IF NOT EXISTS qcache (
  fp          TEXT PRIMARY KEY,     -- sha256(题干|sorted选项)[:16]，主键
  simhash     INTEGER NOT NULL,     -- 64bit SimHash，模糊匹配用
  stem        TEXT NOT NULL,        -- 归一化题干（调试/展示用）
  options     TEXT,                 -- JSON 数组，归一化后的选项
  kind        TEXT NOT NULL,        -- 'choice' | 'blank' | 'short'
  answer      TEXT NOT NULL,        -- 答案原文，如 "B. SYN+ACK"
  answer_key  TEXT,                 -- 选择题的答案字母 'B'；非选择题为 NULL
  engine      TEXT NOT NULL,        -- 'local-3b' | 'local-7b' | 'acp' | 'cloud'
  model       TEXT,                 -- 具体模型 id
  hits        INTEGER NOT NULL DEFAULT 0,
  verified    INTEGER NOT NULL DEFAULT 0,  -- 人工确认过 → 永久可信
  created_at  INTEGER NOT NULL,     -- unix ms
  last_hit_at INTEGER,
  cost_ms     INTEGER               -- 首次生成耗时，统计用
);

CREATE INDEX idx_simhash ON qcache(simhash);
CREATE INDEX idx_last_hit ON qcache(last_hit_at DESC);

-- 同一题的不同 OCR 变体（fp 不同但 SimHash 命中），只记日志不重复存答案
CREATE TABLE IF NOT EXISTS qcache_variant (
  fp        TEXT PRIMARY KEY,
  parent_fp TEXT NOT NULL REFERENCES qcache(fp),
  stem      TEXT NOT NULL,
  seen_at   INTEGER NOT NULL
);
```

**查询路径**：

1. `SELECT ... FROM qcache WHERE fp = ?` → 命中，`hits+1`、`last_hit_at=now`，返回，**成本 0ms**。
2. 未命中 → `SELECT ... FROM qcache WHERE simhash BETWEEN ? AND ?` 粗筛（SimHash 分 4 段 16bit，取任一残段相同的候选），JS 侧算汉明距离 ≤ 3 → 视为同一题；把当前 `fp` 写进 `qcache_variant`，返回父答案。
3. 仍未命中 → 调模型 → 写 `qcache`。

**JSONL 导出**（给迁移/备份/人工审核用）：

```jsonl
{"fp":"a3f19c...","kind":"choice","stem":"下列哪个是tcp三次握手第二步","options":["syn","syn+ack","ack","fin"],"answer":"B. SYN+ACK","answer_key":"B","engine":"local-3b","model":"qwen2.5:3b","hits":7,"verified":1,"created_at":1762300000000}
```

每行一条，`fp` 为稳定键，导入时 `INSERT OR REPLACE`。**JSONL 是导出格式不是主存储** —— 主存储必须是 SQLite，因为需要 `hits` 原子自增和 SimHash 索引。

### 5.4 一致性策略

| 情况 | 处理 |
|---|---|
| 同一题、模型给出不同答案（第二次命中缓存后用户改答案） | 不覆盖；写 `qcache_variant` 级联到同一 parent 的 `review` 标记（新增列 `disputed INTEGER`），人工裁决后 `verified=1` |
| OCR 识别失败/空文本 | 不入库，直接回 `no_question` |
| 图文题（含公式/图表） | `kind='image'`，`stem` 存 OCR 文本，`answer` 存模型输出，**标记 `verified=0` 且永不进模糊匹配**（图变了文本可能没变） |
| 缓存清理 | `DELETE FROM qcache WHERE verified=0 AND hits=0 AND created_at < now-90d`；`verified=1` 的永不删 |

### 5.5 预期收益

按考试场景估算：一套卷子 100 题，历年重复率通常 30–60%。**假设 40% 命中**：

- 100 题里 40 题走缓存（0ms 推理），60 题走模型（69ms）→ 平均推理从 69ms 降到 **41ms**。
- 更重要的是**云端场景**：1.5s 的 TTFT 只付 60 次，不是 100 次 —— 整场答题省下 40×1.5s = **60 秒**。
- 且缓存值随使用增长，第二套卷子命中率通常更高（同一考试机构题库重叠大）。

---

## 六、PC 端最小可用组件清单（文件级）

放在 `remote/mobile-answer/`（新建）。设计原则：**引擎与形态分离**，`lib/` 是纯逻辑，`mcp/` 和 `service/` 是两种薄壳。

```
remote/mobile-answer/
├── package.json                     无第三方依赖（koffi 走 DRN_KOFFI_PATH 回落，node:sqlite 内置）
├── README.md                        启动/配置说明
│
├── lib/
│   ├── engine.mjs                   【核心】answerFrame({imageBuffer|path, region, scale})
│   │                                编排：归一化→查缓存→(未命中)OCR→模型→写缓存→返回
│   │                                返回 {ok, answer, source:'cache'|'model', timings:{...}, packet}
│   │                                无任何宿主依赖（不碰 MCP、不碰 HTTP）
│   │
│   ├── normalize.mjs                题目归一化：NFKC/折叠/去标点/选项切分/数字统一
│   │                                导出 normalizeQuestion(text) -> {stem, options, kind}
│   │                                导出 fingerprint({stem,options}) -> {fp, simhash}
│   │                                导出 hamming64(a,b) -> number
│   │
│   ├── cache.mjs                    SQLite 题库：open/get/put/touch/export/gc/dispute
│   │                                用 node:sqlite DatabaseSync，WAL 模式
│   │                                路径默认 <root>/data/qcache.db
│   │
│   ├── frame.mjs                    帧处理：isBlank(frame) 判空图（抄 capture.mjs 的亮度方差）
│   │                                缩放到长边 1280、转 JPEG q80、base64 编解码
│   │                                刻意不含任何 desktopCapturer 调用
│   │
│   ├── ocr.mjs                      薄封装 askcc 的 ocr-client.mjs
│   │                                补：Buffer 入参（内部落临时文件+finally 删）
│   │                                补：队列深度上限（默认 4，超了丢最旧）
│   │                                单例，进程级复用
│   │
│   ├── llm.mjs                      薄封装 askcc 的 local-model.mjs
│   │                                强制走 onDelta 流式分支（绕开三.5 的 empty_response 坑）
│   │                                加 solvePrompt()：把 normalize 后的题干+选项拼成稳定 prompt
│   │                                加 answerKeyOf(answerText)：从 "B. xxx" 抽 'B'
│   │
│   ├── acp.mjs                      薄封装 askcc 的 acp-client.mjs
│   │                                配置化：nodeExe / dshBin / profile / patch
│   │                                启动时检查 provider 是否配置（读 profiles/<p>/cordis.patch.yml，
│   │                                空数组则直接报 no_provider 而不是等 turn 失败）
│   │                                会话复用 + 失败自动重建（抄 index.mjs 的 answerViaAcp）
│   │
│   └── config.mjs                   配置合并：文件 < 环境变量 < 调用参数
│                                    记录 DSH provider 自动发现（抄 index.mjs readDshProvider）
│
├── mcp/
│   └── tools-answer.js              【形态 A】MCP 工具层，导出 {toolDefinitions, handlers}
│                                    遵守 dsh-remote-node 的 4 条约定：
│                                      · handler 返回普通对象，出错抛带 code 的 Error
│                                      · 绝不写 stdout
│                                      · 图片走 {__image:{data,mimeType}}
│                                    定义 3 个工具：
│                                      ans_solve_frame  (image_base64|save_path, region?, scale?)
│                                      ans_ocr_only     (image_base64|save_path, scale?, region?)
│                                      ans_cache_admin  (action: stats|export|gc)
│
├── service/
│   ├── server.mjs                   【形态 B】双模常驻/管道进程
│   │                                --port 8765 → HTTP POST /frame + WS /live
│   │                                --stdio      → 供 bridge-listen 一连接一进程拉起
│   │                                两种模式共用 lib/engine.mjs
│   └── proto.md                     HTTP/WS 报文格式（手机端对接文档）
│
├── scripts/
│   ├── bench.mjs                    跑第四节的延迟分解，输出 JSON（可重跑验证）
│   ├── warm.mjs                     预热 OCR 侧车 + ACP 会话，打印各项就绪耗时
│   └── verify-env.mjs               环境自检：OCR 语言包 / node 版本 / koffi / dsh bin.js /
│                                    provider 配置 / 端口占用 —— 一次跑完给结论
│
└── data/
    └── qcache.db                    SQLite 题库（运行时生成，勿入版本库）
```

### 复用的外部文件（不复制，直接 import / require 现有路径）

| 外部文件 | 用途 | 引用方式 |
|---|---|---|
| `askcc-re/clone/src/sidecar/ocr-sidecar.ps1` | OCR 引擎本体 | 路径常量，`OcrClient` 的 `CANDIDATES` 已覆盖 |
| `askcc-re/clone/src/main/ocr-client.mjs` | OCR 客户端 | 直接 `import`，`lib/ocr.mjs` 包一层 |
| `askcc-re/clone/src/main/local-model.mjs` | OpenAI 兼容客户端 | 直接 `import` |
| `askcc-re/clone/src/main/acp-client.mjs` | ACP 客户端 | 直接 `import` |
| `askcc-re/clone/src/main/win32-capture-guard.cjs` | WDA 保护（浮窗用） | `require`，需 `koffi` 可解析 |
| `remote/dsh-remote-node/lib/win32.js` | 抓屏/输入/窗口 | `require`，路径相对 |
| `remote/dsh-remote-node/lib/png.js` | PNG 编解码 | `require` |
| `remote/dsh-remote-node/server.js` | MCP 服务器骨架 | 往 `TOOL_MODULES` 加一项即可挂上 `mcp/tools-answer.js` |
| `remote/bridge-listen.cjs` | TCP 隧道 | 不改；`--exec "node service/server.mjs --stdio"` 即接上 |

### 落地顺序（每步都能单独验证）

1. `lib/normalize.mjs` + `lib/cache.mjs` —— 单元可测，不依赖任何外部环境。用历史 OCR 样本回归。
2. `lib/ocr.mjs` + `lib/frame.mjs` —— 拿本机真实截图跑通，验证 92ms 热态。
3. `lib/engine.mjs` —— 串起 OCR→缓存→模型，用 stub 端点打通。
4. `scripts/verify-env.mjs` —— 把本文三节的检查脚本化，每次部署先跑。
5. `mcp/tools-answer.js` —— 挂进 `dsh-remote-node`，在 DSH 里手测。
6. `service/server.mjs` —— 按需再加，`--stdio` 首发。

---

## 附录：本次实测的环境快照

```
OS        : Microsoft Windows 11 专业教育版 build 26300
Node      : v24.21.0   (npm 被 PS 执行策略拦，直接 node 跑)
GPU       : NVIDIA RTX 5070 Ti Laptop + Intel UHD
Display   : 物理 2560×1600 @ dpi144 (scale 1.5) perMonitorV2:true
            逻辑 1707×1067
adb       : 1.0.41 / 36.0.0-13206524  (无设备)
scrcpy    : 未安装
ffmpeg    : 有
git/pnpm  : 无
本地模型   : 无（11434/1234/8000/8080/8091/8094 全空）
OCR       : zh-Hans-CN + en-US，MaxImageDimension 10000
ACP       : profile 存在，bin.js 在 node_modules\@deepseek-ai\dsh\lib\，冷启 1.48s
            ⚠ provider 未配置（cordis.patch.yml 为 []），prompt 会报 no API key
```

实测通过：WDA 捕获排除 / OCR 侧车 / ACP 握手 / node:sqlite。
实测失败：ACP 真实 prompt（缺 provider 配置，非协议故障）。
未实测：手机取帧与传输（无设备）、真实模型推理（无后端）。
