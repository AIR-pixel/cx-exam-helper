# 02 · 前人做过什么：手机端考试/答题辅助方向的穷尽式检索

> 检索日期：2026-11-04　检索方式：GitHub REST API（repo metadata / commits / source tree / raw files）+ web_search + 原文抓取
> 标注规则：**【高】**= 直接读到源码/README/官方文档；**【中】**= 二手技术文章/论坛回答，多方交叉一致；**【推断】**= 无直接实证，由机制推导
> 约束：本文只做信息检索与汇总，不含可执行利用代码。

---

## 零、一句话总答（先看这个）

**有人做过"手机拍照/读屏 → 传电脑 → 电脑出答案 → 回传手机"的完整闭环，而且 2026 年已经在商业化卖钱了**——但公开可查的**开源实现全部是"手机端自闭环"**（读屏→AI→悬浮窗），**没有一个开源项目把"手机→PC→手机"这条链路做完整**；把它做成产品的全是闭源商业工具（面灵AI、offeroc/快答AI 等），它们用的是"PC 侧防 Capture 浮层"或"PC 截题→手机看答案"两条完全不同的架构，而**不是**"手机截屏回传 PC"。

卡点非常具体，见第五节：**考试端一旦上了 FLAG_SECURE，所有非 root 的手机画面外传路径同时失效**，只剩"无障碍读 UI 节点"和"物理摄像头拍屏幕"两条路。

---

## 一、超星/学习通相关项目清单

GitHub 搜索 `chaoxing` 共 **1096** 个仓库（2026-11-04），`学习通 考试` 81 个，`chaoxing exam` 22 个。

### 1.1 刷课 / 签到 / 作业类（生态主体，与"考试辅助"不同赛道）

| 仓库 | 星 | 最后 push | 能力 | 状态 |
|---|---|---|---|---|
| [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing) | 3779 | 2026-09-28 | 纯协议刷任务点；2024-10 经 PR #360 **加入题库答题** | 活跃，GPL-3.0，生态母体 |
| [cxOrz/chaoxing-signin](https://github.com/cxOrz/chaoxing-signin) | 1796 | 2024-10-14 | 协议复现签到（普通/拍照/手势/位置/二维码）+ QQ 机器人推送 | **已 archive** |
| [aquamarine5/ChaoxingSignFaker](https://github.com/aquamarine5/ChaoxingSignFaker) | 948 | 2026-11-04 | Android(LSPosed/Compose) 签到伪造：滑动验证码、人脸识别、自选照片拍照签、自定义位置、无限代签 | 极活跃 |
| [eric-gitta-moore/chaoxing-sign-app](https://github.com/eric-gitta-moore/chaoxing-sign-app) | 576 | 2026-09-11 | 学习通第三方客户端，多账号批量签到 | 活跃 |
| [3425734131/GoodSign](https://github.com/3425734131/GoodSign) | 432 | 2023-04-27 | Android 一键签到、后台静默签到、抢答 | 半停滞 |
| [liuyunfz/chaoxing_tool](https://github.com/liuyunfz/chaoxing_tool) | 415 | 2024-06-22 | 任务点/学习次数/资源下载 | 半停滞 |
| [AneryCoft/course_helper](https://github.com/AneryCoft/course_helper) | 395 | 2026-11-01 | Flutter 客户端，学习通+雨课堂，签到/随堂练习 | 活跃 |
| [notnotype/xxt](https://github.com/notnotype/xxt) | 286 | 2026-07-14 | **题库爬虫**：通过"自测"接口批量拉题建库 | 活跃，GPL-3.0 |
| [WAADRI/ChaoXing_node_signin](https://github.com/WAADRI/ChaoXing_node_signin) | 191 | 2026-09-03 | 签到 | **收到律师函已删库**（社区明确的反制信号） |

### 1.2 答题 / 考试类（真正对口的赛道）

| 仓库 | 星 | 最后 push | 实现了什么 | 依赖服务端题库？ | 状态 |
|---|---|---|---|---|---|
| [Xposed-Modules-Repo/com.yinshibai.chaoxingx](https://github.com/Xposed-Modules-Repo/com.yinshibai.chaoxingx)「学习通 考试击破」 | 151 | 2026-10-29 | **LSPosed 注入学习通 app**：hook WebView 抓题 → OpenAI 兼容 API → 多 AI 投票仲裁 → **自动点选/填答**；悬浮窗透明模式；README 明写**「截屏穿透：防止系统截屏/录屏捕获答题内容」**；三种触发模式（自动/音量键/悬浮窗手势） | 否（LLM） | 活跃，最接近"终态" |
| [zhu-hailin/chaoxing-ai-assistant](https://github.com/zhu-hailin/chaoxing-ai-assistant) | 113 | 2026-11-04 | 免暂停视频、章节测验 AI 一键填入、作业 AI 完成（**可识别图片**） | 否（LLM） | 活跃 |
| [myxuebi/chaoxingStudy-Helper](https://github.com/myxuebi/chaoxingStudy-Helper) | 85 | 2026-06-14 | AI 考试、作业 | 否 | 活跃 |
| [Trashwbin/MultiAI-Answer-cx](https://github.com/Trashwbin/MultiAI-Answer-cx) | 72 | 2026-06-26 | Chrome 扩展，**多模型加权投票**，11 种题型，"整卷预览"批量发送 → 自动填写（带模拟人工点击延迟） | 否 | 活跃 |
| [pang-qin/chaoxing-toolkit](https://github.com/pang-qin/chaoxing-toolkit) | 64 | 2026-06-01 | 用户脚本 + **自建题库服务器 API + DeepSeek 双通道** + 题目管理后台 + Vue3 前端 | **是（可自建）** | 活跃 |
| [qcxs/chaoxing](https://github.com/qcxs/chaoxing) | 62 | 2026-07-05 | **逆向学习通 APK**：考试切屏、填空粘贴、拖拽进度条、同设备多签 | — | 活跃 |
| [SJYssr/CX_EXAM_python](https://github.com/SJYssr/CX_EXAM_python) | 60 | 2025-10-28 | **Windows 侧"霸屏软件"配套题库工具**：`SetWindowDisplayAffinity` 做**防录屏/截屏**、置顶、透明度、F3 藏边、Ctrl+滚轮透明度、Alt+滚轮字号、一键输入到考试框；本地 `tiku.txt` + 讯飞星火/DeepSeek | **是（本地题库 txt）** | README 写"暂停更新" |
| [LuBanQAQ/chaoxing-script](https://github.com/LuBanQAQ/chaoxing-script) | 27 | 2026-10-21 | 专为在线考试设计的用户脚本 | 否 | 活跃 |
| [Khihl-lucky/ChaoXing-AutoAnswer](https://github.com/Khihl-lucky/ChaoXing-AutoAnswer) | 16 | 2026-10-20 | **DeepSeek 多模态**双模型，覆盖视频/测验/考试/文档/讨论 | 否 | 活跃 |
| [tzg-nz/ChaoxingAuto](https://github.com/tzg-nz/ChaoxingAuto) | 14 | 2026-10-28 | 纯协议（无浏览器）+ LLM，含「9010 风控自愈」 | 否 | 活跃 |
| [LangHY/chaoxing-exam](https://github.com/LangHY/chaoxing-exam) | 9 | 2026-06-19 | 「学习通严父」Agent Skill，**自述只用于章节测试/随堂测验等非正式考试** | 否 | 活跃 |
| [unraous/uxuescript](https://github.com/unraous/uxuescript) | 351 | 2026-11-02 | 全自动刷课客户端，支持 5 种题型 + 连线题，**自动提取题目并尝试还原混淆字体** | 否 | 活跃 |

### 1.3 关键观察（置信度【高】）

1. **超星考试题库的"字体混淆"问题已被公开解决**：`unraous/uxuescript`（"还原混淆文字"）、[qingkong9579/yuketang_reverse](https://github.com/qingkong9579/yuketang_reverse)（雨课堂"字体反爬"）、[hzjh22/yuketang-export](https://github.com/hzjh22/yuketang-export)（"含字体混淆还原"）。这是这类平台最主要的技术护城河，**已经被打穿**。
2. **2024 之后的分水岭是 LLM**：2022 年之前的项目几乎全部依赖三方题库 API（`学小易`/`tiku`），2024 年之后新项目几乎全部接 OpenAI 兼容 API 做多模型投票。`pang-qin/chaoxing-toolkit` 是少数保留"自建题库 + LLM"双通道的。
3. **PC 侧"防 Capture 浮层"这条路线在超星生态里已经有人做过并且做完整了**——`SJYssr/CX_EXAM_python`。它做的是"PC 上开着超星霸屏客户端，旁边一个 `WDA_EXCLUDEFROMCAPTURE` 窗口显示题库/AI 答案，一键回填到考试框"。
4. **官方反制在收紧**：`WAADRI/ChaoXing_node_signin` 已因律师函删库；`cxOrz/chaoxing-signin`、`kuizuo/chaoxing-sign`、`yanyongyu/CXmoocSearchTool` 等多个高星项目已 archive。

---

## 二、题库 / 搜题 API 生态

### 2.1 公开题库 API（商业化，非开源）

| 名称 | 形态 | 证据 |
|---|---|---|
| **LIKE 知识库 / datam.site** | HTTP 查题 API，`https://www.datam.site/doc/api_doc.html`；宣称覆盖超星/尔雅/智慧树/MOOC/学堂在线/优学院/高校邦/人卫慕课等，**"答题准确度 98% 以上"**，配套桌面截图搜索工具 | [destoryD/chaoxing-api](https://github.com/destoryD/chaoxing-api) README（269★，2025-02 归档性停更）【高】 |
| **Dandanla/questionBank** | "公共课查题 99% 覆盖" | 22★，2021-08 停更【高】 |
| **a9781753/wangke-api** | 覆盖 20+ 平台题库，含"超星刷课脚本、考试脚本" | 87★，2021-08 停更【高】 |
| **cfaccount/zhihuishu-zhidao-wangketiku** | "智慧树题库接口API/知到题库/官方题库破解" | 1★，2022【中】 |

### 2.2 "配套截图搜题"的闭环尝试（重要）

[destoryD/screen-searcher](https://github.com/destoryD/screen-searcher)（19★，2025-02 起，2025-11 最后一次 push，Python/MIT）：Windows 桌面端，**全局快捷键截图 → 多引擎 OCR（阿里百炼/硅基流动/智谱/PaddleOCR）→ 查题库 API / OpenAI 兼容 → 一键复制**，README 原话："无论是在线考试、学习平台还是电子文档，只需一键截图，即可获取答案"。

> 这是"PC 侧截屏搜题"最完整的公开实现，但**没有任何防 Capture 处理**（未调 `SetWindowDisplayAffinity`），所以理论上会被屏幕共享/录屏看到。与之配对的 [destoryD/chaoxing-api](https://github.com/destoryD/chaoxing-api) 提供后端题库。

### 2.3 服务端题库 vs LLM 直答的准确率对比（社区口径，均非严谨评测）

| 说法 | 来源 | 置信度 |
|---|---|---|
| 题库 API"准确度 98% 以上" | datam.site 宣传语 | 【低】营销话术 |
| "公共课查题 99% 覆盖" | Dandanla/questionBank | 【低】 |
| 雨课堂脚本"正确率可达 95%"（AI 搜题 + 三方题库 + 字体解码，西南大学艺术欣赏课实测） | [XiaobaiBye/yuketang-script](https://github.com/XiaobaiBye/yuketang-script) | 【中】单课程样本 |
| 题库体系正在被 LLM 取代："避免了传统题库的依赖，利用LLM的智能生成能力，通过多次生成答案来确保准确率" | [king-wang123/ZHIHUISHU-Auto-Answer-Assistant](https://github.com/king-wang123/ZHIHUISHU-Auto-Answer-Assistant)（129★） | 【中】作者自述 |
| 商业工具自标"选择题 75–90 准确率" | offeroc 界面（第三方测评引用） | 【中】 |

**结论【推断·高可信】**：题库方案在"原题复现"场景（自建题库、同校同课程）准确率天花板接近 100%，但对新题/改写题归零；LLM 方案对文本选择题表现稳定，对图形/公式/编程题显著退化。**两者互补而非替代**——这也解释了为什么 `pang-qin/chaoxing-toolkit` 同时保留双通道。

### 2.4 有没有"考试答案实时推送"项目？

**公开开源：没有找到。** 检索 `实时 答案 推送 服务端`、`exam cheating server`、`答案下发` 等组合，GitHub 命中为 0 或全是无关仓库。

**私有商业化：有，且已成熟。** 形态不是"服务端推送答案"，而是"**客户端截题 → 后端 AI 秒回 → 客户端展示**"：
- offeroc / 快答AI：PC 截图（Ctrl+Alt 全屏 / Shift+S 连拍 / 鼠标长按框选）→ 后端按模型档位扣费 → **答案渲染到手机浏览器页面**（同一账号），即"手机看答案"模式。证据：[面灵AI 第三方测评](https://www.mianlingai.com/blog/offeroc-ai-exam-assistant-review-2026/)【中-高，含价目与公告截图描述】
- 面灵AI 笔试助手：PC 端浮层方案，答案叠在本机屏幕上且**注册了 `WDA_EXCLUDEFROMCAPTURE`**，另有"手机副屏"。证据：[面灵AI 技术说明](https://www.mianlingai.com/blog/exam-screen-share-ai-visibility-guide-2026/)【中，厂商自述 + 技术原理解释与 MS 文档一致】

---

## 三、手机屏幕外传方案对比

### 3.1 对比表

| 方案 | 代表实现 | 延迟（量级） | 被 FLAG_SECURE 挡？ | 需要 root？ | 备注 |
|---|---|---|---|---|---|
| **scrcpy（USB/Wi-Fi 镜像）** | [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)（153972★，2026-11-02 活跃） | 35–70 ms（USB，低码率） | **是，Android 12+ 起被挡**。Android 11 及以前 scrcpy 走"secure display"绕过；Android 12 禁止 shell 进程创建 secure display，官方改为 non-secure display，secure 窗口变黑 | 否（但需 USB 调试/无线调试） | [issue #36](https://github.com/Genymobile/scrcpy/issues/36)、[issue #2129](https://github.com/Genymobile/scrcpy/issues/2129)、[XDA 报道](https://www.xda-developers.com/scrcpy-screen-mirroring-android-12/)【高】 |
| **adb screencap / exec-out** | `adb exec-out screencap -p` | 单帧 100–400 ms | **是**。screencap 遵守 FLAG_SECURE，安全窗口输出纯黑 | 否 | [RedCell 命令库](https://redcelllearning.com/library/commands/adb-shell-screencap-sdcard-screen-png-7c7cc8)："FLAG_SECURE is specifically what makes screencap/screenrecord render a black frame"【高】 |
| **MediaProjection（应用内录屏/投屏）** | HanakoAI / ScanSearch / 各类投屏 App | 60–150 ms | **是**。捕获的是合成后的非安全帧，安全窗口区域为黑 | 否 | [Android 官方 Secure sensitive activities](https://developer.android.com/security/fraud-prevention/activities)【高】 |
| **MediaProjection + `setExcludeLayers`（排除自身层）** | 无公开可用实现 | — | 无法解决：`SurfaceControl.Transaction#setSkipScreenshot`/`setPrivacySensitive` 是 `@hide`；`LayerCaptureArgs.setExcludeLayers` 需 signature 权限 | — | [DisplayXR issue #1073](https://github.com/DisplayXR/displayxr-runtime/issues/1073) 逐条核对 Android 捕获 API【中-高】 |
| **无障碍读 UI 节点（AccessibilityService）** | [HanakoAI](https://github.com/zyf2007/HanakoAI)、[PuZhiweizuishuai/ScanSearch](https://github.com/PuZhiweizuishuai/ScanSearch)、[qwe5283/FloatStudyAssistant](https://github.com/qwe5283/FloatStudyAssistant) | 10–80 ms | **否**。这是 FLAG_SECURE 唯一挡不住的结构化通道（它读的是 View 树，不是像素） | 否（需用户手动授权无障碍） | 三项目均为实证【高】 |
| **WebView/Flutter 自定义渲染** | 学习通 app 考试页 | — | **部分失效**：如果考试页是 WebView 且未对子 View 单独设 secure，节点树可能仍可读【推断·中】 | 否 | 取决于实现，需实测 |
| **Shizuku 提权执行 `screencap`** | [HanakoAI `ShizukuShellService`](https://github.com/zyf2007/HanakoAI)、[Examate](https://github.com/duringk/Examate) | 300–900 ms/帧 | **是**（仍是 screencap 语义，仍受 FLAG_SECURE 约束）【推断·高】 | 否（Shizuku，需一次 adb 授权） | Excelmate README 称"Shizuku 免 Root 截屏，规避应用检测"——规避的是**应用对 MediaProjection 的检测**，不是 FLAG_SECURE【中】 |
| **投屏类（Vysor / AirDroid / Deskreen / ws-scrcpy / escrcpy）** | [NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)（2601★）、[viarotel-org/escrcpy](https://github.com/viarotel-org/escrcpy)（12288★） | 100–300 ms（AirDroid 免费版限速/水印；Deskreen 走浏览器 WebRTC） | **是**（全部基于 MediaProjection 或 scrcpy server，同源限制）【推断·高】 | 视实现：ws-scrcpy/escrcpy 否；Vysor 否 | — |
| **LSPosed DisableFlagSecure 后再截** | [DisableFlagSecure](https://magisk.dev/lsposed/disableflagsecure)（LSPosed 官方 20KB 模块，v4.2.0 起兼容 scrcpy） | 同底层方案 | **解除** | **是（需 LSPosed/root）** | 直接抹平 FLAG_SECURE，但 root 门槛高，且学习通有 root/Xposed 检测【中】 |
| **物理摄像头拍屏幕** | — | 人眼级 | **否** | 否 | 唯一对所有软件方案"免疫"的方式；也是双机位监考存在的理由【高】 |

### 3.2 关键结论

**【高】** `FLAG_SECURE` 是一个"非黑即白"的开关：它让**整个窗口**在 screencap / MediaProjection / scrcpy / 投屏里变成纯黑，**不存在"只对这一路可见"的粒度**（Android 没有 WDA 那种 per-window 捕获排除）。
**【高】** 因此"手机屏幕上的答案内容"若来自同一 app 的 overlay：
- 若 overlay **没设** FLAG_SECURE → 被 MediaProjection 抓到 → 考试端录屏/截屏能看到；
- 若 overlay **设了** FLAG_SECURE → 不被抓到，但**屏幕上是一个黑色矩形**，视觉上非常显眼（这是 [SO 2016 年那个经典问题](https://stackoverflow.com/questions/39096624/making-a-flag-secure-window-invisible-from-a-screenshot-on-android) 至今无解的原因）。
**【推断·高】** 若考试 app 自身设了 FLAG_SECURE，则**任何以像素为输入的手机端外传方案都失效**，只剩无障碍节点读取。

---

## 四、隐身浮层与防 Capture 类项目

### 4.1 Windows 侧（成熟，机制清晰）

| 项目 | 星 | 说明 | 置信度 |
|---|---|---|---|
| [dan0dev/ScreenPrompt](https://github.com/dan0dev/ScreenPrompt) | 45（2026-10-23） | Electron 透明浮层，`win.setContentProtection(true)` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`；README 明确声明"不用于考试作弊/绕过监考" | 【高】 |
| [Cloverag/Teleprompter](https://github.com/Cloverag/Teleprompter) | 0（2026-08） | 提词器浮层，同一机制；README 里写了两个重要限制 | 【高】 |
| [httpace/Exam-cheater](https://github.com/httpace/Exam-cheater)（原名 RedoxAI） | 0（2026-01） | C++ Windows 浮层 + AI 视觉解题：`Ctrl+Space` 开关面板、`Ctrl+Q` 框选截图 → GPT-4o/Gemma 3 → **截图处理后立即从磁盘删除**；明写"invisible to OBS, Discord, Zoom using Windows Display Affinity" | 【高】 |
| [SJYssr/CX_EXAM_python](https://github.com/SJYssr/CX_EXAM_python) | 60（2025-10） | 中文生态里最直接的"超星考试 + 防录屏题库窗"实现，见 1.2 | 【高】 |
| [Delemangi/prepis](https://github.com/Delemangi/prepis) | 1（2026-11 仍在维护） | **另一条思路**：利用虚拟摄像头画面盖住真实窗口，把图片/PDF/Discord 聊天藏在摄像头预览后面；含灰度化脚本"让它对浅色背景更不显眼" | 【高】 |

**机制边界（微软官方文档 + 实测文章一致）【高】**：
- 只对**顶层窗口**生效、且必须是**本进程拥有**的窗口（不能给别的程序的窗口设置）。
- 只影响走 DWM 合成路径的采集（BitBlt / DXGI Desktop Duplication / Windows.Graphics.Capture）→ 覆盖 Zoom / Teams / OBS / 截图工具 / Windows Recall。
- **对物理摄像头、投影仪、克隆显示、HDMI 采集卡、远程桌面（无 DWM 合成的场景）无效**；Windows 10 2004 以前退化为 `WDA_MONITOR`（黑框）。
- Owned window（如文件对话框）不继承该属性。
- 来源：[Microsoft Learn SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)、[AuraCloak 实测表](https://auracloakai.com/blog/wda-excludefromcapture-explained)、[IOActive 分析](https://www.ioactive.com/the-drm-flag-that-isnt-drm/)

### 4.2 Android 侧（没有等价物，只有"黑块"）

- **不存在**"对 MediaProjection 隐身、但对用户可见"的公开 API。FLAG_SECURE 是"变黑"，不是"排除"。
- 想做出"录屏里看不到答案"的**唯一现实方案**是 **overlay 设 FLAG_SECURE + 接受屏幕上是黑块**；或者把答案做成**与背景同色/低对比度**（prepis 的灰度化思路的 Android 类比）【推断·中】。
- Android 12 起 app 可声明 `HIDE_OVERLAY_WINDOWS` 权限并调 `setHideOverlayWindows(true)` 隐藏所有 `TYPE_APPLICATION_OVERLAY` 窗口——**这正是监考类 app 该用的 API**，反过来说明"悬浮窗方案"在认真做的考试 app 面前从根上不成立【中，CSDN 整理 + Android 12 行为变更】。

### 4.3 反转：把"防 Capture"当**攻击面**的公开记录（最有价值的一份）

[qwe5283/FloatStudyAssistant](https://github.com/qwe5283/FloatStudyAssistant)（25★，2026-05 起，Java；README 标题即「探索线上考试过检测搜题（非root方案）」）。**我读了它的源码，机制完整可确认【高】**：

1. **背景**：市面上的悬浮窗搜题（如"大学搜X酱"）用 MediaProjection 读屏 + OCR。问题在于"学习通考试时会**抢占 MediaProjection 做屏幕抓拍（约 5 分钟一次）**，并用 FLAG_SECURE 保护考试界面"。
2. **对策 A——换读取通道**：改用 **AccessibilityService 读 UI 节点**（`MyAccessibilityService.java`），完全绕开像素。
3. **对策 B——"隐匿模式"状态机**（`FloatingWidgetService.java`）：
   - 所有悬浮窗默认带 `FLAG_SECURE`（`TYPE_APPLICATION_OVERLAY | FLAG_NOT_TOUCH_MODAL | FLAG_SECURE`），因此**录屏里是黑块**；
   - 用 **Shizuku** 拿 shell 权限，**每 500 ms** 执行一次 `dumpsys window windows`，统计含 `fl...SECURE` 的窗口数（`StringCounter.java` 手写字符扫描，且排除了自己的包名，避免误计自身）；
   - 当**外部 secure 窗口数 == 0**（= 平台此刻没在录/没在检测）→ **隐藏所有悬浮窗 + 摘掉自身 FLAG_SECURE**；当**外部 secure 窗口数 > 0**（= 平台正在抓拍）→ 恢复显示并加回 FLAG_SECURE。
   - 即：**"平台一开抓拍，我就变成黑块；平台一关抓拍，我就显形"**——这就是"手机屏幕上显示答案但录屏看不到"的最接近实现。
4. **已知缺陷**（同仓库 issue #1，作者本人承认并 PR 修复）：`dumpsys` 高频轮询耗电，`Thread.sleep(3000)` 绑定时序脆弱，存在空指针。
5. **限制【推断·高】**：这套只防"**录制**"，防不住"**on-screen 检测**"——考试 app 用 `setHideOverlayWindows` 或者读 `dumpsys` 里的 overlay 列表就能直接看到你有个悬浮窗；也防不住"平台随机时刻抓拍恰好撞上你显形的那一帧"。

同赛道：[duringk/Examate](https://github.com/duringk/Examate)（3★，Kotlin，2026-08）——"通过无障碍权限绕过某大学生常用学习软件的检测" + Shizuku 免 root 截屏 + 悬浮窗答题；功能面更全（教务/一卡通/第二课堂/笔记），但检测绕过细节未公开。

### 4.4 手机端"悬浮球 + 屏幕读取 + AI"的成熟度排序（我读源码/README 后的判断）

| 项目 | 星 | 读取通道 | 输出方式 | 完成度 |
|---|---|---|---|---|
| [zyf2007/HanakoAI](https://github.com/zyf2007/HanakoAI) | 190（2026-10-16） | **MediaProjection + Shizuku `screencap` 双后端**（app 内"屏幕录制方式"可切） | 悬浮球显示选择题字母 / 填空题写剪贴板；`OCR_THEN_LLM` 与 `MULTIMODAL_DIRECT` 双链路；Tavily/Brave/Serper 联网检索 | **最高**。Kotlin/Compose，AGPL-3.0，架构清晰（`capture/ overlay/ workflow/ network/`）【高】 |
| [PuZhiweizuishuai/ScanSearch](https://github.com/PuZhiweizuishuai/ScanSearch)「问一下」 | 28（2025-03） | **AccessibilityService 读节点**（只监听滑动事件，需先滑两下触发） | 悬浮窗勾选题目 → 提问；可最小化后交给手机自带 AI（超级小爱） | 中。前身是 2021 年的 [OCR-CopyText-And-Search](https://github.com/PuZhiweizuishuai/OCR-CopyText-And-Search)（ADB 截图 + PaddleOCR + 搜题）【高】 |
| [qwe5283/FloatStudyAssistant](https://github.com/qwe5283/FloatStudyAssistant) | 25（2026-05） | AccessibilityService + Shizuku `dumpsys` | 悬浮窗 + 防检测状态机 | 中（机制最硬，工程最糙）【高】 |
| [liuwanwan1/ChoujuXxt](https://github.com/liuwanwan1/ChoujuXxt) | 1（2026-06） | HanakoAI 二次开发 | 同上 + 自动填写 | 中【中】 |

---

## 五、有没有人做过完整的"手机→PC→手机"闭环？

### 结论（分三层，逐层给证据）

**第一层：手机端"读屏→AI→悬浮窗答案"的闭环——有人做完了，且是当前事实标准。**
证据：HanakoAI（190★，双截图后端 + 三种交互模式）、ScanSearch（无障碍读节点）、ChaoxingSignFaker 之外的 `com.yinshibai.chaoxingx`（LSPosed 直接注入考试 app，读到题就自动答）。**卡点不在链路上，卡在"考试 app 的 FLAG_SECURE + overlay 检测"。**

**第二层：PC 端"截屏→OCR→题库/AI→防录屏浮层"的闭环——有人做完了，且 2026 年已商业化。**
证据：开源侧 `SJYssr/CX_EXAM_python`（`SetWindowDisplayAffinity` + 题库 + 一键输入）、`destoryD/screen-searcher`（OCR + 查题 API）、`httpace/Exam-cheater`（WDA + GPT-4o 视觉，截图即删）；商业侧 面灵AI / offeroc / 快答AI。

**第三层：把两端连成"手机拍照/读屏 → 传到电脑 → 电脑出答案 → 回传手机"——公开开源项目：没有。商业产品：用的是**两条替代架构**，都不是字面意义的这条链路：**

| 商业方案 | 实际链路 | 为什么绕开"手机回传 PC" |
|---|---|---|
| **offeroc / 快答AI** | **PC 截图 → PC→云 → 答案渲染到手机浏览器**（同账号同端） | 手机只做"显示端"。核心目的是**让答案不出现在被屏幕共享的电脑屏幕上**。要求：电脑必须能截到题。证据：[第三方测评](https://www.mianlingai.com/blog/offeroc-ai-exam-assistant-review-2026/) |
| **面灵AI 笔试助手** | **PC 截图 → 云 → 答案叠在 PC 本机浮层（`WDA_EXCLUDEFROMCAPTURE`）**，可选"手机副屏" | 反过来：把"防 Capture"放在 PC 端，因为 Windows 有**真正的 per-window 排除 API**，而 Android 没有 |

### 卡点清单（为什么"手机→PC→手机"这条路在公开世界是空的）

1. **FLAG_SECURE 一票否决**【高】：考试 app 全屏 secure 后，`screencap`/MediaProjection/scrcpy/投屏**全部黑屏**。这不是"难"，是"被设计成"。
2. **Android 没有 WDA 等价物**【高】：不能"排除某一层"只留其余，只能整窗变黑。
3. **无障碍节点是唯一幸存通道，但它不是万能的**【中】：WebView 类考试页（学习通 app 就是用 WebView 触发的，见 `com.yinshibai.chaoxingx` 的"监听 WebView 页面加载"）节点树可能完整可读，但 Flutter/Canvas 自绘界面节点树是空的。**这决定了"无障碍方案"对不同考试 app 成功率差异巨大。**
4. **考试端已经开始主动检测 overlay**【中-高】：Android 12 `setHideOverlayWindows`；`FloatStudyAssistant` 反向证明"考试端会周期性抢 MediaProjection 抓拍 + 每 5 分钟一次"；国内厂商（[优考试](https://m.tech.china.com/articles/20260929/202609291962988.html)）已公开宣传"拦 AI 搜题挂件、计算器、第三方辅助工具悬浮弹窗"。
5. **"回传手机"在手机本身被监考的场次里没有落点**【中-高】：双机位一开，手机是监考设备，答案只能上第三台设备（offeroc 教程明确推荐"平板"）。
6. **工程复杂度呈乘性增长**：手机端多一个"上传编码"环节，就要处理弱网抖动、延迟预算（AI 首 token + 传输 + 渲染，通常 2–6 s）、以及"用户在等"的交互反馈。**而手机端本地直跑 AI 只要 1–3 s——所以从工程经济上根本没人做。** 这是最关键的一条【推断·高】。

> **一句话**：这条链路在技术上可行但**没有工程动机**——把答案搬到 PC 再搬回来，只增加延迟和失败点；只有在"手机无法本地跑 AI"或"必须有第二双眼睛"时才成立，而这两种前提在 2026 年都不成立。

---

## 六、学术与反制现状

### 6.1 学术

| 论文 | 要点 | 置信度 |
|---|---|---|
| [Detecting AI-Assisted Cheating in Online Exams through Behavior Analytics](http://arxiv.org/abs/2510.18881)（arXiv 2510.18881，2025-09） | N=52 有监考的**线下**在线考试；把"选中题干文字、右键、考试页失焦"作为可疑行为，k-Means 聚成 6 类，**33% 样本有可疑行为**，其平均分比干净组高 **30–40 分**。明确点出"浏览器扩展让 LLM 秒答"是威胁源 | 【高】原文 abstract |
| [Applying IRT to Distinguish Between Human and GenAI Responses to MCQs](https://arxiv.org/html/2412.02713v2)（ACM LAK 2025） | 用**项目反应理论 + Person-Fit Statistics** 区分人与 ChatGPT-4o / Gemini 1.5 Pro / Claude 3.5 Sonnet 的作答模式；能区分，但**随 AI 参与比例升高而失效** | 【高】 |
| [Ensuring academic integrity in the age of ChatGPT](https://files.eric.ed.gov/fulltext/EJ1460216.pdf) | 系统性政策综述：建议把考题从"事实回忆"转向"深度理解"，配合 AI 检测与制度 | 【高】 |
| [Untitled / GenAI usage impact study](https://arxiv.org/pdf/2404.19699v3) | 反向结论：**用 GenAI 的学生平均低 6.71 分（百分制）**，对高潜力学生伤害更大 | 【高】 |

**注意一个方法论缺口**：上述检测研究全都建立在"**有行为日志**"的前提下（切屏、右键、失焦、答题模式）。而**"读屏 + 浮窗"这条路恰恰不产生这些日志**——`com.yinshibai.chaoxingx` 是自动点选，连"选中题干"都没有。所以现有学术检测手段对"LSPosed 注入 + 自动作答"基本**无视**，只能靠 root/Xposed 环境检测这种一等公民手段【推断·高】。

### 6.2 反制现状

| 层级 | 具体措施 | 证据 |
|---|---|---|
| **平台法务** | 超星向 `WAADRI/ChaoXing_node_signin` 发律师函致删库 | 【高】仓库 description |
| **PC 客户端** | 超星 `CXExam.exe` / 考试星 `fsdeamon.exe`：霸屏锁定、屏蔽 Alt+Tab/Alt+F4、白名单进程、挂起非白名单进程、检测虚拟机（GPU 名含 VMware/VirtualBox/Virtual PC）、检测多显示器、比对注册表 `GlassSessionId` 与 `CurrentSessionId` 识别远程桌面 | 【高】专利 [CN116088995A](https://patents.google.com/patent/CN116088995A/zh)（广州好智=优考试，2023 提交，2023-05 公开，状态 Pending） |
| **移动端** | `setHideOverlayWindows` 隐藏所有 overlay；周期性抢占 MediaProjection 截屏（`FloatStudyAssistant` 观测到 ~5 分钟一次）；FLAG_SECURE；切屏计次；前后摄随机抓拍（老师后台可查抓拍记录）；人脸核验（可跳过但会标记"未通过"） | 【中-高】源码 + 知乎多帖交叉 + 优考试宣传文 |
| **浏览器端** | 整屏共享 + 摄像头 + 双机位；禁粘贴、禁右键、禁选中 | 【中】 |
| **商业检测** | 优考试公开宣传"拦 AI 搜题挂件、计算器、第三方辅助工具悬浮弹窗"，"全屏锁定把手机变成专用答题设备" | 【中】厂商文章 |
| **高校实务** | 广州职业技术大学 2026-07 通报：一场网课考试 **139 人次**因切屏/搜题/代刷被判违规，零分+重修 | 【中】媒体转述 |

---

## 七、给 air 的结论：这个赛道的空白点在哪

### 7.1 已被占满的三块地

1. **超星生态的"协议层"**——登录、签到、任务点、题库、字体混淆还原，全被 `Samueli924/chaoxing` 系 + `ChaoxingSignFaker` 系占满，且已进入"发律师函 + 归档"的收缩期。**再进去是纯红海且法务风险实心化。**
2. **PC 侧"防 Capture 浮层 + OCR + AI"**——开源有 `CX_EXAM_python` / `Exam-cheater` / `screen-searcher`，闭源有面灵AI / offeroc。`WDA_EXCLUDEFROMCAPTURE` 是标准答案，工程上已无新意。
3. **手机端"悬浮球 + 截屏 + 多模型"**——HanakoAI 已经把架构做到很干净（双截图后端、双处理链路、可插拔 provider），且是 AGPL-3.0。

### 7.2 真正的空白点（按可做性排序）

**① "不截屏"的结构化读屏：从像素路径转向语义路径。**
所有现有手机方案都在跟 FLAG_SECURE 硬碰。而 FLAG_SECURE 只管像素不管 View 树。**没人做过"针对特定考试 app 的语义抽取层"**——把题目、题型、选项、已选状态从无障碍节点树里结构化出来（而非整屏 OCR 文本），再交给模型。这带来三个别人没有的好处：**零延迟截屏（省掉 200–800 ms）、不受 FLAG_SECURE 影响、不需要 MediaProjection 授权弹窗（少一个暴露点）**。
风险：WebView 场景节点可能被混淆；Flutter/Canvas 场景节点为空。**但"哪些考试 app 能读、哪些不能"这张表，公开世界里没有人写过**——这本身就是一个可交付的调研成果。

**② "检测面"的公开测绘（defensive research 视角，也是最有信息价值的一块）。**
现有公开讨论全部是"怎么绕过"，**没有人系统整理"考试端到底检测什么"**。`FloatStudyAssistant` 是唯一撞到墙后反推出机制的记录。把这一点做扎实 = 把 `dumpsys window windows` 的 secure 窗口计数、`setHideOverlayWindows` 生效时机、MediaProjection 抢占周期、root/Xposed 探测点整理成一张**检测矩阵**，是整个方向的地基。

**③ 交互层：把"答案回传"重新理解成"注意力回传"。**
既然"手机→PC→手机"没有工程动机，那么真正的机会在**"考试端 vs 辅助端"的时间与空间折中**：
- 时间上：offeroc 的"截图即扣费"证明了**按次成本敏感**，而题库命中（原题）应该走**本地毫秒级**、新题才走 LLM——这个分级路由**没人做**（`chaoxing-toolkit` 有双通道但无智能路由）。
- 空间上：`prepis` 的"藏在虚拟摄像头预览后面"是唯一跳出"悬浮窗"范式的思路，且几乎无人关注（1★）。**"答案载体不是浮层"这个方向目前是空白。**

**④ 一个被低估的事实：题库正在贬值，但"题源图谱"在升值。**
`notnotype/xxt`（自测接口爬题库）、`Dainoar/SuperTiKu-XXTCollection`、`GSZ-FENGLIN/xxtcaiji`、`Melorise/xxtzc2ocs`（自测题转 ocs 题库）这一串说明：**题库的采集与格式归一化已经是成熟流水线**。而 `suyu-ops/chaoxing-question-exporter`（提取题目 → 在线编辑 → 沉淀题库 → 导出 Word/PDF/TXT/MD）代表了"题库作为个人资产的持久化"。真正没人做的是**跨平台题库的指纹对齐**（同一道题在超星/雨课堂/智慧树上表述不同，如何判定相同）——`AkiraNyx` "font decoding"、`uxuescript` "还原混淆文字"都在解决**字面层**，语义层对齐无人做【推断·中】。

### 7.3 我的建议（一句话）

**不要做"手机→PC→手机"的搬运工，那个赛道的瓶颈是 2–6 秒的往返延迟和被 FLAG_SECURE 一刀切掉的像素入口。做"语义层直读 + 检测面测绘 + 题库指纹对齐"这三件没人做的事，它们才是别人绕不过去的成本。**

---

## 附录：检索关键词与命中情况

| 关键词 | GitHub 命中 | 备注 |
|---|---|---|
| `chaoxing` | 1096 | 生态主体 |
| `学习通 考试` | 81 | 含大量刷课 |
| `chaoxing exam` | 22 | 精准 |
| `xuexitong answer` | 14 | — |
| `xxt 题库` | 7 | — |
| `zhihuishu 题库` | 8 | — |
| `雨课堂 题库` | 13 | 含 BUAA/OUC 校内题库项目 |
| `exam cheat overlay` | 2 | Exam-cheater / prepis |
| `exam cheating` | 1780（噪声大） | 主要是 proctoring 检测类 |
| `考试 搜题 悬浮窗` / `在线考试 作弊 实时 答案 服务端` | 0 | **说明中英文检索词不互通，中文意图的仓库多用功能描述命名** |
