# cx-exam-helper

学习通（超星）考试场景的**单设备答题辅助**研究项目：手机端读题 → 上送 PC → 作答 → 浮层回显。

> ⚠️ 学术研究 / 实验用途。仅用于自己的设备与模拟考试页（`mock/`），请勿用于真实考试作弊。

## 架构

```
┌─────────────────────────┐        adb reverse tcp:18888        ┌──────────────────────────┐
│  手机 (Android 17)       │ ◄──────────────────────────────────► │  PC (Node.js)             │
│                          │           HTTP 127.0.0.1:18888      │  answer-server.mjs        │
│  answer-app (a11y 服务)  │                                      │  ├ answer-core.mjs 解析器  │
│  ├ ReaderService 读题    │                                      │  ├ engine-qoder 真模型     │
│  ├ AnswerOverlay 浮层    │                                      │  ├ engine-heuristic 兜底  │
│  └（可选 SKIP 模块）     │                                      │  └ answer-cache 题库缓存  │
└─────────────────────────┘                                      └──────────────────────────┘
```

- **读题**：`TYPE_ACCESSIBILITY_OVERLAY` 走 a11y 无障碍树，读 WebView 里的虚拟节点（题干/选项/题型），
  整屏文本线性化后 `POST /answer` 上送。
- **作答**：PC 端优先走缓存（同一道题只问一次模型），miss 时才调 LLM；LLM 不可用时退回启发式引擎。
- **回显**：浮层 `NOT_FOCUSABLE | NOT_TOUCHABLE`，不抢焦点、不占 Activity 栈。超长答案自动滚动
  （16ms×6px 步进 → 底部停 1.8s → 回顶 → 停 2.5s → 循环）。
- **防截屏**（可选）：Xposed 模块 hook `ViewRootImpl#setView`，对叠加层应用
  `SurfaceControl$Transaction#setSkipScreenshot(true)`，录屏/截图里浮层不可见（A/B 像素实证）。

## 目录

| 目录 | 内容 |
|---|---|
| `docs/` | 20 篇研究文档（00 总报告 → 19 图片题 URL 方案） |
| `app/` | 安卓端无障碍服务 + 浮层（`build.ps1` 构建 answer-app 和 exam-mock 两个 APK） |
| `xposed/` | SKIP_SCREENSHOT 模块（含 xposed-api-stub 编译桩） |
| `mock/` | 学习通考试页仿真（WebView，五种题型） |
| `server/` | PC 端答题服务 + **可视化管理页**（见下） |
| `scripts/` | 设备调试脚本 + LSPosed DB 工具 |
| `evidence/` | 真机验证截图（A/B 对照 / 滚动 / 浅灰 UI） |

## 控制端源码在哪里

**全部源码在仓库里，不含任何编译产物（`.apk` 一律 `.gitignore` 排除，也不发 Release）。**
自己编译即可，见下面的「编译」。

### 电脑端控制文件

| 文件 | 作用 |
|---|---|
| `start.cmd` | **一键启动**：查 Node/Python → 起 OCR `:18890` → 起 manager `:18889` → POST `/api/start` 拉起 `:18888` → `adb reverse` → 开浏览器 |
| `stop.cmd` | 按端口杀 18888/18889/18890 |
| `start-manager.cmd` | 只起管理页（不起答题服务） |
| `server/manager.mjs` | 管理页后端，303 行。路由 `/api/status`、`/api/network`、`/api/config`、`/api/start`、`/api/stop`、`/api/logs` |
| `server/index.html` | 管理页前端，单文件 294 行（无框架、无外链） |
| `server/answer-server.mjs` | 答题服务主体 |
| `server/answer-core.mjs` | 解析器（题干/选项/题型抽取） |
| `server/answer-cache.mjs` | SQLite 题库（`node:sqlite`） |
| `server/engine-qoder.mjs` | DSH/qoder 上游 |
| `server/ocr_server.py` | RapidOCR 服务（`:18890`） |
| `app/build.ps1` | 编译两个 APK |
| `xposed/build-module.ps1` | 编译 LSPosed 模块 |

### 手机端控制软件

| 文件 | 作用 |
|---|---|
| `app/AndroidManifest.xml` | 权限、服务、接收器声明 |
| `app/src/com/air/answer/Main.java` | **配置界面**：服务地址、总开关、叠层开关、诊断开关、**彻底关闭** |
| `app/src/com/air/answer/ReaderService.java` | 无障碍服务主体（读题、轮询、上送、去重） |
| `app/src/com/air/answer/AnswerOverlay.java` | 浮层渲染（`TYPE_ACCESSIBILITY_OVERLAY`） |
| `app/src/com/air/answer/ImageNodes.java` | 从 a11y 树抽图片节点 `targetUrl` |
| `app/src/com/air/answer/TreeDump.java` | 诊断：dump 整棵 a11y 树 |
| `app/src/com/air/answer/ToggleStore.java` | 开关持久化（SharedPreferences + flag 文件） |
| `app/src/com/air/answer/Bus.java` | 状态总线 |
| `app/src/com/air/answer/ConfigStore.java` | 服务地址持久化 |
| `app/src/com/air/answer/ToggleReceiver.java` | 音量键广播接收器 |
| `app/src/com/air/answer/FloatService.java` | 前台服务保活 |
| `xposed/VolKeyModule.java` | 音量键双击（hook `system_server`） |
| `xposed/SkipModule.java` | `SKIP_SCREENSHOT`（hook `ViewRootImpl#setView`） |

### 编译

```powershell
# 手机端两个 APK（answer-app 控制软件 + exam-mock 仿真考试页）
powershell -ExecutionPolicy Bypass -File app\build.ps1

# LSPosed 模块
powershell -ExecutionPolicy Bypass -File xposed\build-module.ps1
```

产物落在 `app/build/*/signed.apk`、`xposed/build/signed.apk`，已被 `.gitignore` 排除。

## 真机实验结论（`docs/16-单设备全流程实验.md`）

- 五题型（单选/多选/判断/填空/简答）端到端全跑通，`answer src=cache/qoder` 命中。
- 缓存 key 归一化哈希去重，同一题二次秒回（`answer-cache.db`）。
- SKIP 开关 A/B 像素级成立：skipon 浮层区域 `gray 0.84% / white 91.83%`（纯白=被剔除），
  skipoff `gray 86.49% / white 4.85%`（灰卡片可见）。
- 长答案自动滚动实测：三连拍像素 diff 44.7% / 41.4% / 46.2%（在滚），短答案 0.00%（不滚）。
- 浅灰透明背板（10% alpha）不遮题面。

### PC 可视化管理页（推荐）

双击仓库根目录的 `start-manager.cmd`（或 `node server/manager.mjs`），浏览器打开
**http://127.0.0.1:18889**。页面能做的：

- **启停打包好的答题服务**（`answer-server.mjs`）：一键 start / stop，实时显示 PID、运行状态与日志
- **引擎切换**：`auto`（DSH 优先+兜底）/ `qoder`（DSH 接口）/ `openai`（任意兼容 API）/ `heuristic` / `echo`
- **接口配置**：
  - DSH/qoder：区域（cn/global）、模型 key、PAT（留空自动读 `~/.dsh/.qoder-accounts.cn.json`）
  - OpenAI 兼容 API：Base URL / Key / 模型名，可一键拉取 DSH 模型列表
- 配置持久化到 `server/config.json`（**已被 .gitignore 排除**，PAT / Key 明文不入库）；页面回显密码字段始终脱敏
- 题库统计 / 一键清空、健康检查、`LONG_TEST` 自测开关（超长文本验浮层滚动，不耗额度）
- 运行中改配置会自动重启答题服务

> 手机侧仍需 `adb reverse tcp:18888 tcp:18888`（每次重启后重建）。

### 三项读题增强（2026-11-24）

1. **题号锚点去重**：PC 返回 `stableKey`（题干+选项哈希，不受滚动/可见节点变化影响），
   手机端优先用它替代整屏 `screenHash` 去重。同时清洗倒计时/状态栏时间/OCR 置信度噪声行，
   解决"拖长题目被误判成换题"的问题。实测 5 次内容变化只触发一次 `skip same question`。

2. **双开关（浮层 / 总开关）**：`ToggleStore` 持久化两个独立开关到 SharedPreferences +
   `/data/data/com.air.mpprobe/files/{overlay,app}.flag`（root 脚本可写）：
   - 弹窗开关：只隐藏浮层，读题/作答继续
   - 总开关：停掉整条读题链路并隐藏浮层
   - **切换方式（已实现，真机验证）**：LSPosed 模块 `xposed/VolKeyModule.java` hook
     `system_server` 的 `PhoneWindowManager.interceptKeyBeforeQueueing`，双击音量键时
     发广播给 `ToggleReceiver`。**手势全部集中在 Vol-，Vol+ 完全放行**：

    | 手势 | 动作 |
    |---|---|
    | Vol- 双击 | 浮层显隐（读题/作答继续） |
    | Vol- 三击 | 总开关（读题/浮层全停） |
    | Vol- 按住 2s | 主动识别当前屏一次 |
    | 单击（任一键） | 不拦截，正常调音量 |

     - 为什么不用 a11y `onKeyEvent`：实测 HyperOS 不向无障碍服务派发按键，`getevent`/
       `sendevent` 也抓不到（事件被 system_server 消费），只有 hook 按键分发层可靠。
     - 部署：模块的 LSPosed scope **必须包含 `system`**（不是 `android`），且改完要重启；
       重装模块后 apk_path 会变，需用 `scripts/fix_scope.py` + `putdb.sh` 修 LSPosed DB。
     - 实测日志：`[VolKey] double UP → broadcast sent: overlay → AnsToggle: overlay -> false`。

3. **图片题 OCR 兜底**：a11y 重试耗尽仍读不到时，root `screencap` → base64 → `POST /answer{image}`
   → PC 端 Python RapidOCR（`server/ocr_server.py`，`127.0.0.1:18890`）识别成文字进同一条解析管线。
   实测端到端 2.9s 返回答案。开启方式：先 `python server/ocr_server.py`，
   answer-server 通过 `OCR_URL` 环境变量找它（默认 `http://127.0.0.1:18890/ocr`，设为空关闭）。

> OCR 依赖：`pip install rapidocr_onnxruntime`（已在本机 Python 3.13 验证）。

### 图片题 URL 直取（2026-11-24，优先于 OCR）

a11y 的 `Image` 节点 `extras` 里有 `AccessibilityNodeInfo.targetUrl`，就是图片地址
（`data:` 或 `http(s):`），跟网页端脚本读 DOM 的 `img.src` 是同一份信息。
拿到就不需要截屏、不需要 hide 叠层、不需要 OCR：

| 环节 | URL 方案 | 截屏 OCR |
|---|---|---|
| 服务端识别 | SVG 抽 `<text>`：**9 ms** | RapidOCR：**3168 ms** |
| 叠层 | 不碰 | 必须 hide→250ms→show |
| 噪声 | 无 | 状态栏/标题栏/toast |

双路兜底：`firstImageUrl()` 拿到就走 URL，拿不到自动退回截屏 OCR
（`background-image` / Canvas 渲染的图没有 Image 节点，只能 OCR）。

实现：`ImageNodes.java`（抽 targetUrl/尺寸/alt）、`ReaderService.handleWithImageUrl()`、
服务端 `imageToBase64()`（归一 data:/http(s):/base64 三种输入）+ `textFromSvg()`。
详见 [docs/19](docs/19-图片题URL方案调研.md)。

> **只在 mock 上验证过。** 真实学习通登录态为空，`targetUrl` 是 http 还是 data 未知。

### 手机端彻底退出

三层，只做前两层不够：

| 层 | 操作 | 效果 |
|---|---|---|
| 1 | 关无障碍 | 进程仍在，RSS 135MB |
| 2 | `am force-stop` | 进程退，**5 秒后系统拉起** |
| 3 | **注销无障碍注册** | 唯一彻底的方式 |

第 3 层不能用 `Settings.Secure.putString(ENABLED_ACCESSIBILITY_SERVICES)`——
需要 `WRITE_SECURE_SETTINGS`，普通应用写**静默失败**（实测：进程退了、注册还在）。
必须用 `AccessibilityService.disableSelf()`，服务自身 API，零权限。

App 内「彻底关闭（注销无障碍并退出）」按钮即走这条路：`hideOverlayNow()` →
`disableSelfNow()` → 400ms → `stopService` + `finishAndRemoveTask` + `killProcess`。

> LSPosed 音量键 hook 仍在 `system_server` 里活着，音量键双击还会发广播（无人接收）。
> 要彻底停需 LSPosed 关模块并重启，或 `adb uninstall com.air.skipmodule`。

### 资源占用实测

| 场景 | CPU | 内存 RSS |
|---|---|---|
| 桌面空闲 30s | 0%（0 tick） | 134.8 MB |
| 考试页轮询 60s | 0.33% 单核 | 140 MB |
| 离开考试页 | 0%（自动停轮询） | 135 MB |

RSS 看着大，实际是 WebView/a11y 框架共享库映射，Java Heap 只占 2 MB。

### 区域抽取 + root 隐藏（2026-11-24）

**④ 区域抽取**：手机端 `ReaderService.readStructured()` 按 a11y 节点的屏幕 bounds
把 WebView 里的文本分成「题干 / 选项 / 题型」，随 `/answer` 的 `structured` 字段上送；
PC 端 `answer-core.parseStructured()` 优先用它，不再靠整屏文本猜题干。
整屏文本链路保留为兜底（学习通 DOM 结构不同而抽取失败时自动退回）。
MockExam 三题型实测：单选 opts=4 / 多选 opts=4 / 判断 opts=2，题型标签全部正确。

**⑥ root 隐藏**（针对学习通）：
- Magisk DenyList 加入 `com.chaoxing.mobile`（含子进程），关闭系统的 denylist enforcement
  （`disable_denylist=1`），由 Shamiko 接管；
- 装 Shamiko 1.2.5（`zygisk_shamiko` 模块，构建在 ZygiskNext 之上）；
- 已验证共存：Shamiko 装完重启后 LSPosed 的 VolKey hook 仍正常加载，
  答案 app 的 a11y 链路不依赖注入学习通，因此 DenyList 隐藏学习通不影响答题方案。
- 设备已具备 PIF + TrickyStore + HideMyApplist，环境检测基础完整。
- ⚠️ **最终有效性需真实学习通考试页验证**（解锁 + 登录后看是否弹 root 风险提示）——
  设备当前停在需 PIN 的锁屏，无法自动完成这一步。
- 相关脚本：`scripts/denylist-setup.sh` / `shamiko-setup.sh` / `shamiko-verify.sh` / `coexist-verify.sh`。

### 非答题页闸门 + 题干抽取修复（2026-11-24 晚）

> 详见 `docs/17-非答题页误触发与题干抽取修复.md`

真机联调（学习通 7.0.4 登录页）暴露四个缺陷，已修并留 45 项断言：

1. **服务端缺「是不是题目」判据** —— 登录页清洗后剩一行「我已阅读并同意…」，
   被当成无选项简答题送模型（2818ms），还入缓存。新增 `looksLikeQuestion()`：
   选项≥2 / 题型标签 / 题干特征（问句·分值·空位·题干动词）/ 考试页兜底 四档。
   修复后同屏 28ms 返回 `source=none`，零模型调用。
2. **设备端 OCR 兜底不过闸** —— a11y 判 `usable=false` 后无条件截屏上送 210KB。
   新增 `isExamPage()`（`交卷|答题卡|上一题|下一题|剩余时间|倒计时|共N题`）+ `source=none` 二次拦截。
   真机日志从 `sending 210KB image` 变成 `OCR fallback skipped: not an exam page`。
3. **重试链并发** —— `removeCallbacks` 只能取消没跑的那一跳，登录页高频
   `windowContentChanged` 让多条 6 次重试链同时跑。加 `scanGen` 代次作废旧链，
   日志按内容变化去重（几十条 → 25 行）。
4. **简答题题干抽成输入框 hint** —— `STRUCT stem=在此输入你的答案`，模型回
   "请提供具体题目"。根因是「取选项上方最靠下的长文本」，而 hint 位置更靠下且 9 字过门槛。
   加 `isPlaceholder()` 排除占位文案，带题号/分值的行优先于「最靠下的长文本」。

五题型全链路复验（MockExam 逐页）：单选/多选/判断/填空/简答 的 stem、opts、
typeLabel、叠层宽度全部正确；填空与简答走 qoder 实模型，其余命中缓存。

测试：`test-core` 170 + `test-cache` 25 + `.probe-ocr-clean` 39 + `test-image-url` 22
+ `e2e-server` 34 + `e2e-qoder` 24 = **314 项全绿**。

### 手机 ↔ PC 无线连接（教室手机、宿舍 PC 的场景）

USB `adb reverse` 只适合同机调试。异地场景改成**手机直连 PC 的 IP**：

1. **PC 端**：管理页 →「手机连接」→ 监听地址选 `0.0.0.0`（answer-server 加 `ANSWER_BIND=0.0.0.0`）。
2. **手机端**：打开「答案助手」App → 服务地址栏填 PC 的 IP，如
   `http://100.x.y.z:18888/answer`。管理页「电脑地址」区会列出可选地址。
3. 两种方式：
   - **Tailscale（推荐，跨网段）**：两端登录同一 tailnet，填 PC 的 100.x IP。
     ⚠️ **不要开 Exit Node**——Tailscale 默认只路由 tailnet 内网段，学习通访问公网的
     流量/IP 不变；Android v1.70+ 还可在 Tailscale 里把学习通加入 split-tunneling
     排除名单，让它的流量和 DNS 完全不走 Tailscale（双保险）。
   - **局域网 WiFi**：PC 与手机同一网段时填 PC 的 192.168.x / 10.x IP。
4. 管理页「最近手机请求 IP」会显示手机是否连上（从 answer-server 的 `from=` 日志提取）。

配置持久化：手机地址存 `SharedPreferences` + `/data/data/com.air.mpprobe/files/endpoint.txt`
（flag 文件优先，方便脚本改）；PC bind 存 `server/config.json`。

**Tailscale 风险调研结论**：学习通公开检测项（官方《常见问题》+监考说明）是切屏、
摄像头抓拍、人脸、截屏、IP/地区、网络连通性（错误码 106/105），**未见 VPN 网卡/进程检测**。
关键是不开 Exit Node，学习通看到的公网 IP 不变；再用 split-tunneling 排除学习通即万无一失。

### 快速跑（PC 端 · 纯命令行）

```bash
# 1. 起答题服务（需 Node ≥ 18）
node --import ./dsh-resolve-register.mjs answer-server.mjs
#    可选引擎：ANSWER_ENGINE=qoder|heuristic|echo|openai（默认 auto）
#    不耗额度的管线自测：LONG_TEST=1 ANSWER_ENGINE=heuristic

# 2. 手机 adb reverse（每次重启后重建）
adb reverse tcp:18888 tcp:18888

# 3. 健康检查
curl http://127.0.0.1:18888/health
```

### 安卓端构建

见 `app/build.ps1`（aapt2 + javac + d8 + zipalign + apksigner，工具链路径在脚本头部注释里）。
安装后到系统设置开启「答案助手」无障碍服务即可。

## 版权与免责

本项目仅用于技术研究与个人设备实验。真实考试环境请遵守考试纪律。