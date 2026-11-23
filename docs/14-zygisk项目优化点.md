# Zygisk-fxxkchaoxing（cx-agent）源码深挖：对我们现有项目的技术优化点

> 调研对象：https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing （main 分支，tree `1e7a152`，pushed 2026-11-07，190★，v2.0.6/2026103011）
> 调研方式：GitHub API 拉完整 tree + raw.githubusercontent 下载 49 个源码文件逐行精读（本地缓存 `research/.cxsrc/`）。
> 背景：我们已验证 LSPosed `setSkipScreenshot(0x40)` → 答案 App 窗口屏幕可见/抓拍消失；答案载体是独立透明 Activity（`com.air.mpprobe`）；取题走 AccessibilityService 读节点树；链路 a11y→HTTP 18888(adb reverse)→Bus→叠层。
> **一句话结论**：这是一个"注入学习通进程内、WebView JS 直接读题作答"的完整替代品；对我们最有价值的是 **①应用内 HUD 的免权限挂载 + 与考试页同窗口的抓拍语义、②WebView DOM 读题替代 a11y 全屏节点、③root daemon + 文件轮询的零 hook 触发通道**。它的"对时"是商业授权机制（跟考试无关），"#GUARD 反检测"只在 JS 回调层，解决不了 Java 层 exit-count。**不建议整体切换架构**，择优移植即可。

---

## 一、项目机制总览（源码级）

### 1. 两层架构：Zygisk 壳 + 自有业务 dex
- Zygisk 壳 `agent/zygisk/src/main.cpp`（2349 行）：`preAppSpecialize` 用 `nice_name` 过滤包名 → `connectCompanion()` 从 root companion 读 targets 白名单（4s socket 超时，失败=默认开）→ `postAppSpecialize` 里 `installObserver()` + `startBridge()` 后**直接 return**——`dlopen(kAgentPath)` 那段是死代码（[main.cpp:2318-2338](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L2318-L2338)）。实际运行时壳只做两件事：装 JNI 桥 + 起 500ms 文件轮询线程。
- 业务层 `agent/core/`：agent 自己的 dex（`cxagent.core.AgentBridge` 等），用第二个 `InMemoryDexClassLoader` 装进学习通进程（[core/README.md:148-160](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/README.md#L148-L160)）。包含 jsoup 1.17.2 + kotlin-stdlib（**kotlin-reflect 绝不进 dex**，会触发宿主资源遮蔽 `AssertionError`，[core/README.md:89-104](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/README.md#L89-L104)）。
- 两个独立 root 可执行：`bin/cxvolkeyd`（音量键 daemon，C，`src/cxvolkey.c` 40KB）、`bin/cxtimegate`（对时工具，`timegate_main.cpp`）。`service.sh`（KSU late_start）拉起 daemon。

### 2. 触发通道 = 写文件 + 500ms 轮询（零 hook）
`cache/cx-trigger` 是全部控制的统一入口，root 原子写（tmp+rename+chown+复制 SELinux 标签），注入进程 `triggerPoller` 500ms 消费（[main.cpp:1919-1985](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L1919-L1985)，[agent/README.md:35-47](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/README.md#L35-L47)）：
```
#AI / #AI2 / #AI2R / #NEXTJS / #GUARD / #DUMPHTML / #PARSEHTML
#HUD show|update|hide|toggle [text] / #FETCH url / #TIMEGATE / 任意 JS
```
硬保护：触发文件 mtime >10s 丢弃（`CX_TRIGGER_STALE_MS`，防"下次启动一打开就自己答题"）。busy 互斥 + 60s 自愈（读题全 null 死锁踩过坑，[main.cpp:239-240](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L239-L240)）。

### 3. 执行模型：主线程注入 JS，ValueCallback 回收执
- poller 线程只置 pending → `Handler.post(CxRunnable)` → 主线程 `nativeRunImpl()`：从 `WindowManagerGlobal.getInstance().mViews` 拿所有根 View，递归找 WebView，对每个调 `evaluateJavascript(g_jsPayload, ValueCallback)`（[main.cpp:575-625](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L575-L625)）。
- **不走 console.log**：release WebView 不转发 console，直接拿 ValueCallback 的 JSON 返回值（[main.cpp:699-763](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L699-L763)）。回调里 `json_unwrap()` 手工解 `\uXXXX`（含 UTF-16 代理对）——Android 的 JSON 编码会把 `< > & ' =` 转成 `\u` 转义，不解码 parser 一个容器都找不到（真机踩过，[main.cpp:648-697](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L648-L697)）。

### 4. 答题全链路（#AI2，6 步）
```
#DUMPHTML 抓 outerHTML（挑含题目容器且最长的那份存 cx-page.html）
 → QuestionParser.parseHtml（jsoup）→ 信封 {"ok":true,"mode":"考试","question":{...}}
 → AgentBridge.ask(cfg, question) → "HTTP=200\n<AI content>"
 → AnswerScripts.plan(envelope, aiText) → {"mode","type","params"}（归一化）
 → buildAnswerJs(mode,type,params) → 填参作答 JS
 → 主线程 evaluateJavascript → 多 WebView 回执聚合（cx-answer-result.json）
```
（[core/README.md:620-684](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/README.md#L620-L684)）。旧 #AI 链路另有 OCS 题库优先 + 三档 AI 投票（"三省六部"，主 AI 权重 2/[ai_pipeline.h:1-13,215-287](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/ai_pipeline.h#L215-L287)）+ vision 截图（`View.draw(Canvas)` 自截 WebView，base64 塞进 image_url）。

---

## 二、逐条优化点（7 条）

### 1. 应用内 HUD（状态条）——**强相关，可借鉴**

**它怎么做**（[agent/README.md:226-336](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/README.md#L226-L336)，[CxHud.java](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/src/cxagent/core/CxHud.java)）：
- 注入进程本来就在学习通里，`WindowManagerGlobal.getInstance().mViews` 拿到的根 View 就是当前窗口的 DecorView → JNI `AgentBridge.hudShow(root, text)` → `CxHud.attach()` → `TextView`（半透明黑底 0xB3000000 + 圆角 8dp + 白字 12sp + 点击隐藏）`root.addView()`。**零权限、零 hook、零新进程**，不需要 `SYSTEM_ALERT_WINDOW`，不需要前台 Service。
- 选根四级兜底：①含 WebView 且 `isAttachedToWindow()` ②含 WebView ③最后已 attach 的 ViewGroup（首页无 WebView 走这条）④最后 ViewGroup（[main.cpp:411-480](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L411-L480)）。
- 幂等 + Activity 重建自动重挂：weak global ref 记旧容器，`attach` 用**真实 `getParent()`** 判断（只看缓存的 `sParent` 在旧 DecorView 被丢弃后永远不会重挂——真机踩过）。跨根先 remove 再 add。所有入口 `catch(Throwable)`，JNI 只返回 boolean，HUD 挂不上绝不影响答题主链。

**关键判断：HUD 跟考试页同窗口，天然一起被 SKIP 吗？**
- 它是加在学习通**自己的 DecorView** 上，跟考试 WebView 属于**同一个 Window**。你已验证 `setSkipScreenshot(0x40)` 是给"答案 App 窗口"设的（LSPosed hook `setSkipScreenshot` 作用于该 window 的 flags）。**推论**：如果学习通考试页自己设了 FLAG_SECURE（或你们给它加 0x40），那么 HUD 作为该窗口子 View 会被同一个 window flag 一起保护——抓拍（系统 `PixelCopy`/`MediaProjection` 截屏）拿不到整个窗口，HUD 自然也看不到。
- **反过来的风险**：学习通抓拍如果是走 **JS `View.draw(Canvas)` / WebView 自身截图**（该项目自己 `snapWebView()` 就是这么干的，[main.cpp:289-309](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L289-L309)），那 draw 的是**单个 WebView**，挂在 DecorView 上的 TextView **不在 WebView 子树里 → 抓拍也不会拍到 HUD**。这对我们是**双重安全**：无论抓拍走系统截屏（被 window flag 挡）还是 WebView 局部 draw（HUD 在树外），HUD 都不可见；而人眼看到的是完整屏幕。
- 注意边界：`setSkipScreenshot` 只挡系统级截屏 API；如果学习通用**摄像头**拍屏，任何软件方案都无效——这是物理层，不展开。

**我们能不能用**：可以，而且比我们现在的独立 Activity 更省事——不用切 Activity、不用处理透明/无焦点/窗口层级、不会触发 `onPause`/切屏计数。**但要反过来用**：我们答案是显示在**自己的透明 Activity** 里（已设 0x40），HUD 方案是显示在学习通窗口里（学习通窗口我们没改 flag）。若直接把答案卡片 addView 到学习通 DecorView，则它跟考试页同窗口、没有 0x40 保护 → **会被抓拍拍到**（除非学习通自己设了 FLAG_SECURE）。所以正确借鉴姿势是：**保留我们的独立 0x40 Activity 显示答案**，只借鉴 HUD 的"无权限 addView + 容器重挂 + 幂等"代码风格，用于显示**不含答案的状态信息**（如"正在识别…"）或作为降级通道。

**落地难度**：低（1-2 天）。`CxHud.java` 438 行可直接移植到我们的 LSPosed 模块（去掉 JNI 入口，Xposed hook 里调 `CxHud.attach(activity.getWindow().getDecorView(), text)` 即可）。
**具体建议**：①移植 `CxHud` 的 attach/update/detach/toggle + `getParent()` 重挂判据；②只显示状态文字，答案仍走 0x40 Activity；③如果将来要"完全不切 Activity"，先实测学习通考试 WebView 是否设了 FLAG_SECURE（`adb shell dumpsys window | grep FLAG_SECURE`），确认后再决定是否把答案卡片迁入 DecorView。

---

### 2. #GUARD 反检测——**与其说是答案，不如说是反例**

**它怎么做**（[ai_pipeline.h:497-506](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/ai_pipeline.h#L497-L506)）：一段注入到 WebView 的 JS，把 10 个 `window` 回调强制 noop：
```
clientScreenOccupancyEventAction / clientSnapshotReject / screenOccupancyReAuthCallBack
screenShotPopTip / switchScreenSuspendedWindowLog / clientSnapShotLog / snapshotMonitorLog
newProtocolClientSnapShotLog / newProtocolSnapshotMonitorLog / paste
```
返回 `'GUARD:suppressed n/10'`。`guard_auto` 开启时拼在读题 JS 前一次派发（[main.cpp:1901-1906](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L1901-L1906)）。
README/CHANGELOG 宣称"压制页面自身检测脚本"、"前置/后置/截屏在存盘层拦截（hook 点加密 + DexKit 动态定位）"——**后者在 LSPosed 版 `app/`，本仓库不含**（[CHANGELOG.md:26](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/CHANGELOG.md#L26)）。

**能不能解决我们的"切屏检测"风险（exit-count/receiveExamLogs）**：**基本不能**。
- `exit-count`/`receiveExamLogs` 是学习通 **Java/原生层**的上报逻辑（Activity 生命周期 / 独立监测服务），不是这 10 个 WebView JS 回调。JS noop 碰不到。
- 它压制的"切屏挂起日志/快照日志"是**网页端**自己记的日志，跟 App 层的切屏计数是两条链路。
- 但有一个**间接价值**：它提示了学习通切屏监控的**网页侧回调名清单**，我们做 LSPosed hook 时可以顺着这些名字反查宿主 Native/JS Bridge 方法（如 `window.clientSnapshotReject` 对应的 `@JavascriptInterface`），找到 Java 层 hook 点。

**落地难度**：中（作为线索用）。直接 `evaluateJavascript` 注入这段 JS 很简单，但 Lesson：不要以为注入了就万事大吉。
**具体建议**：①把这段 JS 存成"网页侧监控回调清单"，用 LSPosed hook `WebView.addJavascriptInterface` 枚举宿主注入的 JS 对象，定位 `exit-count` 的真实 Java 调用点；②不把 #GUARD 当作主防御，我们的主防御仍是"不切 Activity + setSkipScreenshot"。

---

### 3. 读题 parser——**最值得整体借鉴的技术点**

**它怎么做**（两级）：
- **第一级：WebView 内 JS 直接 DOM 查询**（[ai_pipeline.h:61-79](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/ai_pipeline.h#L61-L79)）：`AI_JS_EXTRACT_FMT` 用 `document.querySelectorAll('div.singleQuesId.ans-cc-exam')` 定位题容器，按 `.multioption/.singleoption/.judgeoption/textarea` 判题型 `t`，`innerText` 按行过滤装饰文字（题号 `^\d+[.、]?$`、分值 `^（?\d+(\.\d+)?分）?$`、题型标签 `^(单选题|多选题|...)\s*（共\d+题...）$`），返回 `{"q":...,"t":...}`。**不读 a11y 节点树**。
- **第二级：jsoup 二次结构化**（[QuestionParser.java:94-214](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/src/cxagent/core/QuestionParser.java#L94-L214)，83KB）：`#DUMPHTML` 抓的 outerHTML 存盘后，`parseHtml` 按容器 class 分派到 5 类 parser：`div.singleQuesId.ans-cc-exam`→考试、`div.Py-mian1.singleQuesId`→章节测验、`div.wid750.singleQuesId, div.pad30`→作业、`parseQuizQuestion`→随堂练习、`parsePublicCourseQuestion`→公网课程。输出统一信封 `{"ok":true,"mode":...,"question":{"question_type":..,"stem":..,"options":[{"key","text"}],...}}`。含 `decodeUnicodeEscapes`（[L1451-1473](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/src/cxagent/core/QuestionParser.java#L1451-L1473)）、`extractStemImages`（题干图片 URL）、`extractBlankCountWithJsoup`（填空空数）、`determineQuizType` 等专用方法。有 5 个桌面 JVM 闸门测试（`test_parser_jvm.py` 等）保证与一代源码不漂移。

**比我们"整屏节点全读"强在哪**：
1. **结构化**：直接拿到题干/选项/题型/qid，我们 a11y 拿到的是线性文本流，还要自己切分；
2. **稳定**：CSS class 选择器比 a11y `content-desc`/节点顺序抗版本变化（学习通 UI 改版时 class 更稳定）；
3. **带题型**：`t` 字段直接驱动后续 answer JS 选择，我们目前题型靠 PC 端 LLM 猜；
4. **带 qid**：作答时能回写 `#answer<qid>` hidden input，避免"UI 选了但提交没记住"；
5. **图片题**：`extractStemImages` + vision 模型，a11y 完全拿不到题干图片。

**可复用的正则/DOM 解析逻辑**：上面 `AI_JS_EXTRACT_FMT` 的清洗 filter（4 条正则）、`QuestionParser.parseHtml` 的容器分派表、`decodeUnicodeEscapes`。

**落地难度**：中高（2-4 天）。我们走 a11y 是因为不能注入 JS 到学习通 WebView——但可以**混合**：保留 a11y 触发（检测题目出现），改用"注入 JS 读 DOM"获取结构化题目（需要 LSPosed hook WebView 或用调试端口）。如果不想注入 JS，至少把 4 条清洗正则和题型判定规则搬到 PC 端后处理。
**具体建议**：①移植 4 条清洗正则到 PC 答案服务，处理 a11y 读出的题干；②在 PC 端加 `question_type` 字段（single/multi/judge/blank）由规则+LLM 联合判定；③中期评估 LSPosed hook `WebView.evaluateJavascript` 注入读题 JS 的可行性（我们已有 LSPosed 环境，hook 成本低于 Zygisk）。

---

### 4. 音量键触发——**强相关，可直接迁移**

**它怎么做**（[agent/README.md:51-222](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/README.md#L51-L222)，[cxvolkey.c](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/src/cxvolkey.c)）：
- root 独立 daemon 扫 `/dev/input/event0..31`，用 `ioctl(EVIOCGBIT(EV_KEY))` 找出带 `KEY_VOLUMEUP/DOWN` 的设备（[cxvolkey.c:490-523](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/src/cxvolkey.c#L490-L523)），非阻塞 `read()` 事件流。
- **关键：只读不吞**（README §1.9 明确："吞键需要 hook/输入注入，违反零 hook 前提"）。**没有 `EVIOCGRAB`**——所以音量键照常被系统/学习通消费，daemon 只是旁路监听。这就是"怎么在考试页里捕获音量键而不被学习通吃掉"的答案：**根本不需要抢，旁路看一眼就行**。
- 手势状态机：双击 up（松开后 ≤400ms 再按）、长按 up（≥800ms）、双击 down、up+down 组合（≤250ms）；单击/短按住不触发（不占用正常音量调节）。触发后静默 600ms 防连发。
- 门禁：①目标进程活着（`pidof`）②前台检查 `oom_score_adj ≤ 200`（读 `/proc/<pid>/oom_score_adj`）③原子写 `cx-trigger`（tmp+rename）④SELinux 标签复制（`getxattr` 父目录 → `setxattr` 新文件）⑤注入侧 10s 过期兜底⑥flock 单实例。
- 配置 `cxvolkey.conf` 全参数化，SIGHUP 重载。`--list`/`--selftest`/`--dry-run` 三个排查开关。

**我们能不能用**：**完全可以，而且比打开独立 App 触发更符合"不切屏"目标**。我们已有 root + Magisk，可直接把 `cxvolkeyd` 编出来放 `/data/adb/modules/` 用 service.sh 拉起，把手势命令改成我们的触发（写我们自己的 trigger 文件或直接 `am broadcast` 给 AccessibilityService）。双击音量上 = "开始识别+显示答案"，组合键 = "隐藏答案"，双击音量下 = "下一题"。
**落地难度**：低中（1-2 天）。C 源码独立、只链 liblog、NDK clang 直接编（25KB），可原样编译。需要适配：把写 `com.chaoxing.mobile/cache/cx-trigger` 改成写我们 App 可读的路径（注意 SELinux 标签）。
**具体建议**：①直接移植 `cxvolkey.c`，改 `target=`、`trigger=` 两项配置；②用 `--dry-run` 真机验证按键可见性（小米 11 Lite 可能有额外 input 设备）；③把 daemon 的 `double_cmd` 指向我们的 a11y 触发（或写一个 socket/文件 poller 在我们的模块里）。

---

### 5. 作答 JS 编排——**如果要从"显示答案"升级到"自动作答"，这是现成资产**

**它怎么做**：
- **资产层**：12 个作答 JS 文件（`agent/core/assets/answer/*.js`，从一代 `ModuleMain.java` 反抽），覆盖 单选/多选/判断/填空/简答/阅读理解/完形/连线/排序/听力/分录。`manifest.json` 记每个文件的来源行号、字符数、参数名（`selectedIndex`/`indicesJson`/`answersJson`/`rcAnswersJson`/`clozeAnswersJson`/`matchAnswersJson`/`sortAnswersJson`/`subAnswersJson`）。
- **模板层**（`ai_pipeline.h:82-163`）：4 个通用模板，核心技巧：
  - `AI_JS_SINGLE_FMT`：`$('.singleoption').eq(t).addClass('on')` + **回写 hidden input** `#answer<qid>` + `dispatchEvent(new TouchEvent('touchend',...))` + `.click()` 双保险。
  - `AI_JS_MULTI_FMT`：构造完整 `Touch` 对象（clientX/screenX/radiusX/force）派发 touchstart/touchend，比纯 `.click()` 更接近真实点击；答案排序去重后写 `#answers<qid>`。
  - `AI_JS_JUDGE_FMT`：`input[name^="answer"]` 写 `true`/`false`。
  - `AI_JS_BLANK_FMT`：4 层 fallback——`window.editors[].ueditor`（要解包 `.ueditor`，直接 return true 会"假成功"）、`window.editor`、9 个 input/textarea 选择器去重、`contenteditable`、单空兜底。
- **归一化层**（`AnswerScripts.plan()`，[core/README.md:650-664](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/README.md#L650-L664)）：AI 文本（可能带 ```` ```json ```` 围栏/说明文字/HTTP 前缀）→ 手写括号配对抠 JSON → 按 mode/type 映射成 `params`，字母 A→1-based index、多选排序去重、多空数组。
- **流程层**（`AnswerFlow.kt`）：作答后 next/章节子题切换/save，4 个 flow 资产。

**我们能不能用**：能，直接拿来把"显示答案"升级成"自动点选"。但也有代价：自动作答会**消除我们必须显示答案的理由**（可以不切 Activity 了），同时把检测面从"显示"转移到"操作"（学习通可能检测 JS 派发的 TouchEvent 非真实输入、答题速度异常）。
**落地难度**：中（3-5 天，取决于我们要不要自动作答）。若只显示答案，不用碰这块。
**具体建议**：①先只借鉴 `TouchEvent` 派发 + hidden input 回写这两个技巧（用于我们未来可能的"一键填入"按钮）；②`plan()` 的 AI 文本清洗（剥围栏/括号配对抠 JSON）可直接搬到 PC 端答案服务；③如果要全自动作答，12 个 JS 资产 + manifest + `gen_answer_js.py --check` 闸门整套移植。

---

### 6. 时效校验/对时——**是商业授权，不是考试功能，别借鉴**

**它怎么做**（[time_gate.h](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/time_gate.h)）：12 源并发对时（NTP×9：aliyun/tencent/ntsc/pool/google；HTTP-Date×3：baidu/qq/aliyun），单源 4s 超时，`fail-closed`（拿不到可信时间就拒绝工作，**绝不用本机时间兜底**），缓存 300s 新鲜度 + 10s 节流。`CX_TG_EXPIRY_TIMESTAMP = 1794195914L`（**2026-11-09**，即作者定的强制更新到期日）。做题时才同步对时（用时校验），空闲不发任何包。WebUI 状态只看 `verdict=OK`。

**为什么自带联网校时、对考试答题有什么用**：**对考试没用**。这是作者的**产品授权/强制更新窗口**——防用户改系统时间绕过到期。Zygisk 版特意改成"用时校验"是为了不打扰正常使用（[time_gate.h:20-38](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/time_gate.h#L20-L38)）。唯一可借鉴的工程点是 **`fail-closed` 时间戳校验思路**：如果我们未来要做"考试倒计时/交卷提醒"，可以借鉴"网络时间为准、不信本机时间"的设计（考试系统时间一般也校时）。
**落地难度**：不适用。
**具体建议**：不移植。若真需要网络对时，写一个 30 行的 NTP 客户端即可，不需要 12 源竞速 + 状态文件那套。

---

### 7. 反检测/隐藏——**Zygisk 优势在这里其实有限，别高估**

**它怎么做**：
- README 宣称"Zygisk 注入"、CHANGELOG 宣称"hook 点加密 + DexKit 动态定位"。但**源码实证**：
  - 本仓库**没有任何 maps 隐藏 / mount 遮蔽 / 线程名伪装 / Frida 端口探测的实现**。`main.cpp:988-1027` 明确列出一代（LSPosed 版 `app/`）有 `canGetRoot()`/`detectFridaPorts()`/激活降级/配置加密锁/logd flush，而"本壳 N/A 不搬"（[main.cpp:1025-1026](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp#L1025-L1026)）。
  - 反检测实际只有两层：①`#GUARD` JS 回调 noop（见第 2 条）；②**零 hook 设计**——除 HUD 的 `addView` 外，全靠 JNI 反射 + `evaluateJavascript`，不 inline hook 任何函数，因此没有 inline hook 的特征字节。
- Zygisk 相对 LSPosed 的**真实优势**：Zygisk 在 zygote specialize 阶段注入，native so 由 Magisk/KernelSU 管理（隐藏 so 映射、卸载未使用模块等由框栋负责）；LSPosed 要装 XposedBridge 到 classloader、有 `XposedBridge` 类特征。但本项目**照样装了第二个 dex 到 InMemoryDexClassLoader**——`dexdump` 可见 `cxagent.core.*` 类，并非完全无痕。**它并没有解决"检测 agent dex"的问题**。
- CHANGELOG v2.0.4 提到"NetProxy 等本地代理导致误判运行环境异常" → 它加了 3 条"不依赖端口的调试/注入检测"（模块名/线程名/内存特征）——**这是它检测别人（检测自己运行环境是否安全），不是对抗学习通的检测**。

**我们能不能用**：我们已用 LSPosed + Zygisk Next，环境齐备。真正该借鉴的是它的**"零 hook 优先"哲学**：能用 JNI 反射 + `addView` + `evaluateJavascript` 解决的，不要 inline hook（少留特征）。
**落地难度**：不适用（没有可移植的隐藏代码）。
**具体建议**：①保持我们现有 0x40 方案（这是窗口 flag，极难被应用检测）；②不要为了"伪装成 Zygisk"切换——我们已经同时装了 Magisk root + LSPosed，检测面不会因为换注入方式变小；③如果担心学习通检测 LSPosed，重点放在 hook 点最小化，而不是换框架。

---

## 三、最值得借鉴的 TOP3（按 ROI 排序）

| 排名 | 技术点 | ROI 理由 | 落地周期 |
|---|---|---|---|
| **1** | **音量键 root daemon + 文件轮询触发**（第 4 条） | 直接命中"避免打开独立 App"的痛点；C 源码独立可原样编译；旁路只读不吞键，零风险；不影响现有链路，纯增量 | 1-2 天 |
| **2** | **WebView DOM 读题 + 清洗正则**（第 3 条） | 比 a11y 全屏节点结构化得多；4 条清洗正则和题型判定可立刻在 PC 端用（无需注入 JS）；中期可评估 hook WebView 注入读题 JS | 正则 0.5 天 / JS 注入 2-4 天 |
| **3** | **CxHud 的免权限 DecorView 挂载 + 重挂判据**（第 1 条） | 438 行 Java 可直接移植；帮我们理解"同窗口抓拍语义"；用于状态提示（答案仍走 0x40 Activity） | 1 天 |

> 备注：`AnswerScripts` 的 TouchEvent/hidden input 回写技巧排第 4——只在决定"自动作答"时才需要；#GUARD 和对时排最后（前者无效于 Java 层切屏，后者是商业授权）。

---

## 四、对我们架构的具体改造建议（文件级）

| 改造项 | 具体文件/位置 | 动作 |
|---|---|---|
| 音量键触发 | 新增 `/data/adb/modules/cxair/bin/cxvolkeyd` + `service.sh`；我们的 App 里加一个 `TriggerFileObserver`（或复用现有 a11y 服务轮询） | 从仓库 `agent/src/cxvolkey.c` 移植，只改 `target=`/`trigger=` 配置；NDK clang 编译（只链 liblog）；先 `--dry-run` 验证按键 |
| a11y 题干清洗 | PC 答案服务端（HTTP 18888 的 handler） | 移植 `AI_JS_EXTRACT_FMT` 的 4 条 filter 正则 + 题型判定（`.multioption/.singleoption/.judgeoption` 语义） |
| 结构化输出 | a11y 服务 → PC 的 JSON 协议 | 增加 `question_type` / `qid` / `options[]` 字段（参考 `QuestionParser` 信封）；PC 端据此返回更精准答案 |
| HUD 状态提示 | 我们的 LSPosed 模块（新 `CxHud.java`） | 移植 438 行 Java；hook 学习通 Activity `onResume` 时 `CxHud.attach(decorView, "识别中…")`；**答案卡片不动，仍走 0x40 透明 Activity** |
| 自动作答（可选） | PC 端 + 我们的 LSPosed 模块 | 移植 `AI_JS_SINGLE_FMT` 等模板 + `plan()` 归一化 + hidden input 回写；需评估"操作检测"风险，作为 phase 2 |
| 调试通道 | 复用现有 adb reverse 18888 | 借鉴 `cache/cx-trigger` 的原子写 + mtime 过期机制做我们自己的触发（可选） |

**不建议改动的**：答案显示载体（已验证的 `setSkipScreenshot(0x40)` 独立 Activity 是最稳的）、a11y 作为主触发器（在无法注入 WebView JS 时仍是保底）、adb reverse USB 链路。

---

## 五、不建议借鉴的（及原因）

1. **整体切换到 Zygisk 注入架构**——我们已有 LSPosed + Zygisk Next，且 0x40 方案已验证；切换要重做 dex 装载/触发/显示全链路，收益不明。
2. **把答案卡片 addView 到学习通 DecorView**（除非实测 FLAG_SECURE）——学习通窗口没有 0x40 保护，抓拍会拍到答案；独立 Activity 才是安全的。
3. **#GUARD 当主反检测**——10 个 JS 回调 noop 摸不到 Java 层 exit-count/receiveExamLogs；只当线索用。
4. **对时/时效闸那套（12 源 + fail-closed + EXPIRY 日期）**——是作者的产品授权机制，跟考试答题无关；真要对时写个简单 NTP 即可。
5. **OCS 题库 + 三档 AI 投票（三省六部）**——依赖题库后端和额外 API key，我们 PC 端已有答案逻辑，接入收益低。
6. **hook 点加密/DexKit 动态定位**——在 LSPosed 版 `app/`，本仓库无源码；且我们 hook 点极少（就 `setSkipScreenshot`），用不上。

---

## 附：关键源码链接速查
- [README.md](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/README.md) / [agent/README.md](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/README.md)（HUD §2 / 音量键 §1 / 对时 §1.2b）
- [agent/core/README.md](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/README.md)（parser / 作答编排 / #AI2 归一化）
- [agent/webroot/README.md](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/webroot/README.md)（配置键 / 触发协议映射）
- [main.cpp](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/main.cpp)（注入 / mViews / 轮询 / HUD / 结果回执 / Zygisk 生命周期）
- [ai_pipeline.h](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/ai_pipeline.h)（读题 JS / 4 个作答模板 / #GUARD / 投票）
- [CxHud.java](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/src/cxagent/core/CxHud.java) / [QuestionParser.java](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/core/src/cxagent/core/QuestionParser.java)
- [cxvolkey.c](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/src/cxvolkey.c) / [time_gate.h](https://github.com/Dingtaiqi/Zygisk-fxxkchaoxing/blob/main/agent/zygisk/src/time_gate.h)
