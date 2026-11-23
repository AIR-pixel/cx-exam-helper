# 学习通 / 超星泛雅 Android 客户端 —— 考试模式技术实现机制调研

> 调研目标：搞清「学习通 App 考试模式」在端上到底做了什么、哪些信号是客户端上报（端侧可影响）、哪些是服务端判定（端侧无法影响）。
> 调研日期：2026-11-04。方法：公开资料取证 + 反编译源码工程（`qintaiyang/PassChaoxing`）交叉验证 + 学校/厂商官方文档。
> 置信度标注：**高**=一手源码/官方文档/可复现实验描述；**中**=多个二手来源一致但无源码；**低**=单一二手来源或推断。

---

## 一、包名 / 架构 / 版本

| 项 | 事实 | 来源 | 置信度 |
|---|---|---|---|
| 包名 | `com.chaoxing.mobile` | 抓包 UA `com.chaoxing.mobile/ChaoXingStudy_...` | 高 |
| UA 结构 | `Dalvik/2.1.0 (Linux; U; Android X; 机型 Build/xxx) ... com.chaoxing.mobile/ChaoXingStudy_3_{版本}_android_phone_{build}_{n} (@Kalimdor)_{随机hex}` | [czp 博客抓包实录](https://www.hiczp.com/wang-luo/mo-ni-chao-xing-wang-ke-android-ke-hu-duan.html)；[cyear/chaoxing UA 模板](https://raw.githubusercontent.com/cyear/chaoxing/main/api/chaoxing.py) | 高 |
| 架构 | **混合 H5**。考试/作业/章节测验页面本质是 WebView 加载 `mooc1-api.chaoxing.com` / `mooc-ans` 下的 H5；App 壳负责摄像头抓拍、屏幕抓拍、切屏埋点 | [czp 博客（视频页为 WebView）](https://www.hiczp.com/wang-luo/mo-ni-chao-xing-wang-ke-android-ke-hu-duan.html)；[博客园：学习通多端同源 HTML 架构](https://www.cnblogs.com/craflyn/p/19416331)；[LSPosed 模块自述「监听学习通 WebView 页面加载」](https://github.com/Xposed-Modules-Repo/com.yinshibai.chaoxingx) | 高 |
| 独立考试 SDK | 无独立"考试 SDK"包，但考试能力由 App 内原生模块提供：`com.chaoxing.facedetection.sensetime`（**商汤 SenseTime 活体**）、原生抓拍/录屏服务、`libRiskStub.so` 风控库 | `PassChaoxing` 反编译源码 `chaoxing_src/readable/routing/FaceDetectionApi.java` | 高 |
| 反混淆规模 | 一份公开反编译工程：jadx 1.5.2，10000+ Java 文件 / 300+ 包；516 个 API、41 个域名常量 | [qintaiyang/PassChaoxing](https://github.com/qintaiyang/PassChaoxing) | 高 |
| 版本节奏 | 抓包可见版本线：4.0.1 → 4.5.4 → 5.0.1 → 6.2.9 → 6.7.5/6.7.8 → 7.0.0+；学校通知普遍要求 Android ≥ 6.2.9 | [ynny 操作手册](https://www.ynny.edu.cn/info/1182/11090.htm)；[chaoxingx 模块](https://github.com/Xposed-Modules-Repo/com.yinshibai.chaoxingx)（适配 6.7.5，注明 6.7.8 前后结构变化大） | 中 |
| 加固 | 梆梆（`libDexHelper.so`）+ xHook PLT Hook 库 + `libRiskStub.so` 反调试 | PassChaoxing `API_DOCUMENTATION.md` §8 | 中（单一来源但有 SO 地址细节） |
| 主要域名 | `mooc1-api` / `mooc2-ans` / `mobilelearn` / `passport2` / `passport2-api` / `detect` / `stat2-ans` / `study-api` / `x` / `pan-yz` | PassChaoxing `BaseUrlConstants` 与 `DomainConstants` | 高 |

**关键架构含义**：答题界面是 WebView。这决定了「切屏/复制/粘贴/防调试」这类限制大部分是 **H5 层的 JS 拦截**（可被前端手段影响），而「截屏/摄像头/设备指纹」是 **原生层**（需要 Native 手段）。

---

## 二、防截屏机制（核心结论）

### 2.1 结论

**考试页面同时存在两套方向相反的机制，不要混为一谈：**

1. **FLAG_SECURE（禁止外部截屏）—— 存在，但只覆盖"考试页所在的 Activity 窗口"，不是全局。**
   证据链：
   - 荣耀官方社区版主明确点名：「App 主动在该界面使用了 flag_secure 特权，该特权即禁止所有截图、录屏、投屏请求，强行录屏也将返回黑屏内容……像**学习通**、腾讯会议、视频类软件、线上答题界面等场景，APP 本身会主动开启安全防护机制」，并说明「手机端没有手动关闭的设置开关」「root 后可以跳过」——用户主诉正是"学习通想截图截不了"。([荣耀俱乐部](https://club.honor.com/cn/thread-30172326-1-1.html))
   - 对比：**网页版考试不设此限制**（浏览器 Web 页无法设 FLAG_SECURE），所以同一场考试换 PC 浏览器就能正常截图——这解释了网上"电脑端随便截/手机端截不了"的大量案例。([豆瓣实测帖](https://www.douban.com/group/topic/180271445/))
   - 反证/边界：知乎实测贴称「由于系统权限的原因，学习通只能截屏学习通自己，截屏不到输入法，也截屏不到状态栏」（该文原站 403，仅得搜索摘要；见 [摘要](https://zhuanlan.zhihu.com/p/450864233)）。这句同时说明**学习通自己也在用 MediaProjection 截屏**，且**截屏内容不含输入法浮层与状态栏** —— 与"考试页 Activity 设了 FLAG_SECURE 但服务端截屏走的是本 App 自己的屏幕抓拍"的模型完全一致。
   - 置信度：**中偏高**（无公开的 `setFlags(FLAG_SECURE)` 反编译片段；但 OS 侧行为特征 + 厂商工程师解释 + 用户可复现现象三方面一致）。**明确标注为「由行为反推，未取得源码行级证据」。**

2. **MediaProjection（App 主动截屏上传）—— 存在，是学习通监考的"屏幕抓拍"实现方式。**
   证据：
   - 学校官方操作手册反复声明：「本次考试系统将**截取您的屏幕上显示的所有内容**，屏幕抓拍只应用于考试监考」。([云南能源职院](https://www.ynny.edu.cn/info/1182/11090.htm)、[云南理工考生手册 PDF](https://zsgz.ynlg.com/file/kmlgzyxy/zsgz/file/20220626/1656214613978013034.pdf))
   - 考试进入流程中出现系统级录屏授权弹窗后即刻开始答题：「通过人脸识别**点击允许录制**开始答题」（[nith 线上考试指南](https://zs.nith.edu.cn/infor/lmxw/22-4-23-1.pdf)）；「系统提示是否开启**屏幕抓拍权限**，学生点『允许』或『立即开始』」（[云南能源职院](https://www.ynny.edu.cn/info/1182/11090.htm)）——这正是 `MediaProjectionManager.createScreenCaptureIntent()` 的标准 UI 文案。
   - 学员实测：「当时我注意到**谷歌的安全提醒**，意识到这次考试可能涉及屏幕录制」（[ZOL 问答](https://wap.zol.com.cn/ask/x_33262100.html)）。
   - 教师侧有"手动抓拍前后摄像头及**手机屏幕画面**"按钮（[超星监考教师手册 PDF](https://www.ynxzy.com/temp/1709283991912.pdf) 第 7 页）。
   - 置信度：**高**（官方文档 + 系统 API 特征明确）。

### 2.2 FLAG_SECURE 精确影响哪些通道

以 Android `WindowManager.LayoutParams.FLAG_SECURE` 语义 + 实测行为对照：

| 通道 | 是否被拦 | 说明 |
|---|---|---|
| 系统物理截图（音量下+电源） | **被拦**，返回黑屏/提示"涉及隐私不允许截屏" | 荣耀/华为官方 FAQ 同款文案（[华为](https://consumer.huawei.com/cn/support/content/zh-cn00431504/)） |
| `adb shell screencap` | **被拦**，输出黑帧（SurfaceFlinger 对 secure layer 不合成） | OS 机制 |
| `adb shell screenrecord` | **被拦**，黑帧 | OS 机制 |
| 第三方 App 的 `MediaProjection` 录屏/直播/投屏 | **被拦**，黑帧 —— 包括同屏、向日葵类远控的屏幕通道 | OS 机制（[华为 FAQ](https://consumer.huawei.com/cn/support/content/zh-cn00431504/)） |
| `AccessibilityService.takeScreenshot()` (API 30+) | **被拦** | OS 机制 |
| `AccessibilityService` 读节点树（`getRootInActiveWindow` + 遍历 `AccessibilityNodeInfo`） | **不被拦**（FLAG_SECURE 只保护像素，不保护语义树；除非视图设了 `importantForAccessibility=no` / `FLAG_SECURE`+`setAccessibilityPaneTitle` 等）+ **但**：H5 内容在 WebView 里，节点树可用需 WebView 开启 a11y 暴露；考试页多为一题一屏的 DOM，节点可读性高 | Android 文档 + 推断（**推断**） |
| 学习通**自身**的 MediaProjection 抓拍 | **有争议但运行上是"能抓到"** —— 同一 App 的 secure 窗口在自家 virtual display 上的合成行为依厂商实现；实测现象（见 §2.1 引用）显示考试页内容确实被抓拍并上报，老师端能看到学生屏幕 | 中 |
| WebView 内 DOM 文本（通过 Xposed/Frida 注入 JS） | **完全不受 FLAG_SECURE 影响**：屏障在合成层，不在渲染树 | 推断（高把握） |
| 外接物理摄像头/另一台手机拍摄屏幕 | **完全不受影响** | 常识 |

**推论（重要）**：FLAG_SECURE 只挡"像素外流"，不挡"语义外流"。第三方 LSPosed 模块（如 `Enable Screenshot`）能在 Android 12–16 上解除 secure layer 合成限制；学习通自动答题模块 README 里"截屏穿透，防止系统截屏/录屏捕获答题内容"这一条，反证了它自身处于"考试页内容本可被外流、需要主动屏蔽"的语境。([Enable Screenshot](https://modules.lsposed.org/module/io.github.lsposed.disableflagsecure/)、[chaoxingx README](https://github.com/Xposed-Modules-Repo/com.yinshibai.chaoxingx))

### 2.3 置信度汇总

- 「考试页设 FLAG_SECURE」：**中高**（行为三方可复现，无源码行）
- 「学习通自己用 MediaProjection 抓屏并上报」：**高**（官方声明 + 系统授权 UI 特征）
- 「FLAG_SECURE 不影响无障碍节点树与 DOM」：**高（OS 语义）/ 中（学习通页面具体可读性）**

---

## 三、检测面清单

> 「端侧能否规避」= 该信号是否由端侧产生/传输；**能** = 理论上端侧可屏蔽或伪造；**不能** = 服务端已有独立判定数据源。

| # | 检测项 | 技术手段 | 触发后果 | 端侧能否规避 | 置信度 |
|---|---|---|---|---|---|
| 1 | **切屏 / 离开考试界面** | 前端 `visibilitychange`/`blur` 埋点 + 原生 `Activity.onPause` 上报。接口：`mooc1-api.chaoxing.com/exam/phone/exit-count`、`receiveExamLogs?eventType=3/4` | 后台记录"切屏次数/切屏总时长"；多数学校规则：**切屏 3 次或累计 60 秒 → 强制交卷**（[nau 考生手册](https://xxgc.nau.edu.cn/_upload/article/files/77/cc/bc28ff0b46f6a49f6de231bd9127/3229afee-3255-4347-bc5c-58e3d9046c21.pdf)）；异常累计 6 次 → 上报省考试院（[ynlg](https://zsgz.ynlg.com/file/kmlgzyxy/zsgz/file/20220626/1656214613978013034.pdf)） | **能**（拦请求即可；[zhmd5 实测](https://zhmd5.com/a/51/)证明 AdGuard/Fiddler 拦 `exit-count` 后教师端无记录）。但**分屏/悬浮窗是否算切屏取决于焦点是否丢失**，分屏夺焦同样触发（[ZOL 讨论](https://wap.zol.com.cn/ask/x_35386908.html)） | 高（接口名一手来源） |
| 2 | **前后摄像头抓拍** | 原生 Camera 定时/随机抓拍（用户侧观察约 5 分钟一次，抓拍瞬间画面"顿一下"），教师端可手动抓拍 | 抓拍图入档，教师可回看；遮挡/无脸 → 判异常 | 部分。FLAG_SECURE 不拦摄像头；需摄像头层伪造（虚拟摄像头/替换预览帧）。但**抓到"没人脸"直接进异常记录**，且教师可人工复核 | 中 |
| 3 | **屏幕抓拍** | MediaProjection 虚拟显示截帧 → 上报 | 教师端可见学生屏幕；可发现悬浮窗、输入法、第二块屏 | 理论上可通过 Hook 让某次虚拟显示返回旧帧/黑帧，但**断流本身是异常**；且 H5 层另有 DOM 埋点交叉验证 | 中 |
| 4 | **人脸识别 / 活体** | 商汤 SenseTime SDK（`com.chaoxing.facedetection.sensetime`），服务端建 session（`mooc1-api` 下 sense 接口，参数含 `action_number` / `disable_color_liveness` / `enable_defake` / `candidate_actions`） | 进入考试必须过人脸；中途可再核验；"人脸识别异常"进异常列表 | **不能**（活体判定在服务端 + 模型，端侧只能换摄像头输入源，属伪造采集而非绕过判定） | 高（源码级：`FaceDetectionApi.java` 反编译） |
| 5 | **多设备 / 辅机** | 考试说明页下发直播二维码+账号密码，辅机登录同一账号→扫码→`开始直播`（第二机位） | 辅机未开播/中断 → 异常 | **不能**（这是被要求的行为，不是作弊面） | 高（[huhst 学生操作说明](https://www.huhst.edu.cn/__local/4/E1/28/ACF71DBB9DAEBC8AFC12907A03C_F6A0A091_131122.pdf)） |
| 6 | **UA / 客户端形态（仅限手机考试）** | 服务端按 `User-Agent` 判定；考试列表接口 `mooc1-api.chaoxing.com/mooc-ans/exam/phone/task-list` | 用 PC 浏览器打开会提示"请使用手机学习通" | **能**（改 UA 即可，[博客园实测](https://www.cnblogs.com/craflyn/p/19416331)）。但改 UA 后**摄像头/抓拍全失效**，等于放弃监控面 | 高（接口+实测） |
| 7 | **Root / Hook / 框架** | `libRiskStub.so`：`hook_checker_get_proc_maps`（扫 `/proc/self/maps` 找 frida/substrate/xposed/riru）、`hook_checker_get_got_by_name`（GOT 完整性）、`hook_checker_get_addr_by_elf`（ELF 校验）、ptrace `TracerPid` | 命中即判环境异常/拒绝进入考试 | **能但成本高**（Magisk DenyList/Shamiko/Zygisk 隐藏 + 重打包去掉加固校验；`acceleration_check` 单独针对模拟器） | 中（单一反编译来源，但函数名/地址/指令数具体） |
| 8 | **模拟器** | `libRiskStub.so::acceleration_check`（读加速度计，模拟器返回恒定/零值）；通用 `Build.FINGERPRINT/MODEL` 特征 | 环境异常 | 能（真机或改传感器注入） | 中 |
| 9 | **多终端 / 异常登录** | `detect.chaoxing.com` 风控域；`api/recordDevNumber`（设备号上报）；多 IP 心跳（`passport2-api/api/monitor-version`） | "多终端登录可能被判定异常学习" | 部分。设备号是上报值可改，但同一账号在两地多点登录的 IP 汇聚在服务端 | 中（`detect` 域名源码级；`recordDevNumber` 语义为文档推断） |
| 10 | **屏幕共享 / 投屏状态** | 工具类接口 `get_screen_shared_status()`（路径未公开，文档标记 `?`） | 未知（推断为考试期间轮询） | 推断：若端侧需先查本地状态再上报，则可 Hook 返回值 | **低（仅接口清单存在，未验证实际调用）** |
| 11 | **复制/粘贴/右键/F12（Web 端）** | H5 层：`notAllowCopy.css` 的 `user-select:none`、`onselectstart`/`oncopy` 拦截、UEditor `beforepaste` 清空剪贴板、`debugger` 无限断点、`(function(){}).constructor('debugger')()` 原型链逃逸 | 卡死页面/无法粘贴 | **能**（捕获阶段 `stopPropagation` + `Object.defineProperty` 劫持 `UE.Editor.prototype.addListener` + iframe 内注入；[已公开完整 PoC 分析](https://github.com/PlutoNebula/chaoxing-exam-unlocker-project)） | 高（有代码级还原） |
| 12 | **答题时长埋点** | 每题进入/离开时间戳由 H5 上报 | 教师端可见每题耗时；枪手代答的时间分布异常 | 部分（可伪造节奏，但需与切屏/抓拍时间线自洽） | 中（[知乎回答摘要](https://www.zhihu.com/question/396821100)） |
| 13 | **开发者选项 / USB 调试 / 无障碍列表 / 系统代理 / 悬浮窗权限** | **未在公开材料中找到学习通点名检测的证据**。注意：这类检测通常由风控 SDK 统一做，`libRiskStub.so` 目前只解析出 maps/GOT/ELF/加速度四项 | — | — | **低 / 存疑**。网上"学习通检测开发者选项"的说法多为其他考试 App 的经验外溢，**无一手证据**。反例：AdGuard 本地 VPN 代理方式拦截请求在 2020 年实测有效（[zhmd5](https://zhmd5.com/a/51/)），说明至少当时没有系统代理强检 |

**必须强调的分类**：

- **纯客户端上报（端侧可影响）**：切屏次数/时长、屏幕抓拍、摄像头抓拍、答题节奏、设备号、UA、Web 端复制粘贴限制。
- **服务端判定（端侧无法影响）**：人脸比对与活体分数、异常记录累计与强制收卷、多 IP/多设备汇聚、同一考试内的时序矛盾检测、教师人工复核抓拍图。

---

## 四、人脸 / 活体

| 事实 | 证据 | 置信度 |
|---|---|---|
| 使用**商汤 SenseTime** 活体 SDK：包名 `com.chaoxing.facedetection.sensetime`，bean 类 `SenseLiveResult` / `SenseSDKConfig` / `SenseSession` | 反编译源码 `FaceDetectionApi.java` | 高 |
| 是**服务端下发 session** 的模型：`b(SenseSDKConfig)` 先 POST 建 session（携带 `action_number`、`disable_color_liveness`、`enable_defake`、`candidate_actions`），再由 `a(session_id)` 取 `session_result` | 同上（Retrofit 接口定义） | 高 |
| `disable_color_liveness` 参数字段 = **炫彩/序列光活体**开关；`enable_defake` = 防翻拍（照片/屏幕攻击）；`candidate_actions` = 动作活体候选（眨眼/张嘴等） | 参数名直译 + [同类 SDK 文档](https://help.aliyun.com/zh/viapi/developer-reference/api-infrared-face-liveness-detection)类比 | 中高 |
| 抓拍节奏：进入考试必须过人脸一次；考试过程中**前后摄像头不定时抓拍**，教师可手动抓拍；用户观察约 **5 分钟**一次 | [bjmu 学生说明](https://jiaoyuchu.bjmu.edu.cn/docs/20210517133739305889.pdf)（"进入考试后在右上角一直启用摄像头，随时抓拍考试过程中前置和后置摄像头的图像"）；[ZOL 实测](https://wap.zol.com.cn/ask/x_35386908.html) | 中（间隔为经验值，各校可配） |
| 相机 API 层 | 未见 CameraX/Camera2 相关证据。可确定的是：抓拍走 App 进程内相机；**无公开材料证明学习通检测虚拟摄像头驱动**（Android 无系统级 Camera 驱动的"虚拟"标准检测面，通常只能靠帧内容/METADATA 反推） | — | **低 / 未知** |

**结论**：人脸这一环是**服务端判定**，端侧唯一可行方向是伪造采集输入（换帧源），而这需要 Hook `Camera2`/`ImageReader` 输出 —— 与"桌面旁路"完全不相干（见 §七）。

---

## 五、网络与协议

### 5.1 域名与协议

| 域 | 用途 | 证据 |
|---|---|---|
| `mooc1-api.chaoxing.com` | 考试主接口：`exam/phone/publish-list`、`exam/phone/exit-count`、`examApi/examDetail`、`examApi/examPaper`、`examApi/submitExam`、`api/recordDevNumber`、`mooc-ans/exam/phone/task-list`、sense 活体 session | PassChaoxing `BaseUrlConstants` + `API_DOCUMENTATION.md` §考试；`exit-count` 见 [zhmd5](https://zhmd5.com/a/51/) |
| `mooc2-ans.chaoxing.com` | `phone/moocAnalysis/examList`（考试统计）；答题 H5 | PassChaoxing |
| `mobilelearn.chaoxing.com` | 活动/签到/通知类 | PassChaoxing |
| `passport2-api.chaoxing.com` | 登录、`api/monitor-version`（分钟级心跳，判多 IP 同时在线） | [czp 博客](https://www.hiczp.com/wang-luo/mo-ni-chao-xing-wang-ke-android-ke-hu-duan.html) |
| `detect.chaoxing.com` | 风控/异常检测域 | PassChaoxing `BaseUrlConstants` |
| `stat2-ans` / `study-api` / `x` / `pan-yz` / `notice` / `groupyd` / `noteyd` | 统计、资源、网盘、通知 | PassChaoxing |

- 协议：**HTTPS/HTTP**，无 WebSocket 证据（IM 走轮询 REST）。考试 H5 与 API 均为普通 HTTP 语义，可被系统代理/VPN 方式截获。([zhmd5](https://zhmd5.com/a/51/)：AdGuard 本地 VPN 即可拦 `exit-count`)
- **证书绑定（pinning）：未发现证据。** 反驳证据：2020 年用 Fiddler 用户证书即成功拦截 App 的 HTTPS 考试请求；Android 7+ 用户证书默认不受信才是当时的障碍（作者明说"安卓 7.0 以上系统用户证书不被信任……root 可能比较繁琐"），而不是 pinning。置信度：**中**（2020 年状态，后续版本未验证）。

### 5.2 请求签名 / 加密 body

| 机制 | 内容 | 证据 | 置信度 |
|---|---|---|---|
| 通用签名 `inf_enc` | `MD5("token=4faa8662c59590c6f43ae9fe5b002b42&_time=" + 毫秒时间戳 + "&DESKey=Z(AfY@XS")` | [czp 博客反编译 + 算法还原](https://www.hiczp.com/wang-luo/mo-ni-chao-xing-wang-ke-android-ke-hu-duan.html)（v4.0.1 时代，密钥名为 DESKey 实为 MD5） | 高（当时版本） |
| 签到签名 `enc` | `MD5("[数据][P$M$rjqrtBq&#bM!][yyyyMMddHHmmss]")` | PassChaoxing `ENCRYPTION.md` §1 | 中高 |
| 课程认证 `enc` | `MD5(courseId&isStudent&timestamp + "2024!@#$qwePOi~")` | 同上 §2 | 中高 |
| WebView 通信 | AES/ECB/PKCS5Padding，密钥由服务端 HTTP 响应下发 | 同上 §3 | 中 |
| 风控签名（Native） | `libsecuritylib.so`：`SecurityLib_webRequestSign`（604 条指令）、`SecurityLib_cryptUserAgent`、`SecurityLib_verifyJsSign`、`CxDevice_getDeviceInfo` | PassChaoxing `API_DOCUMENTATION.md` §8.2 | 中（有 SO 地址与指令数，未公开算法本体） |
| 考试提交接口形态 | `POST https://mooc1-api.chaoxing.com/examApi/submitExam`，参数 `exam_id / course_id / class_id / answers / duration` | PassChaoxing §考试 | 中（接口清单级，未做端到端复现校验；文档自述 516 API、测试通过率 51.5%） |

**注意**：`SecurityLib_webRequestSign` 与 `cryptUserAgent` 说明**新版本存在 Native 层请求签名与 UA 加密**，这意味着"改 UA 伪装客户端"在 6.x/7.x 上不再是改个字符串，而需要走 Native 签名 —— 与 nith 学校文档要求 6.2.9+ 的时间线吻合。

---

## 六、前人绕过讨论汇总

### 6.1 GitHub 仓库（star / 最后更新 / 做了什么）

| 仓库 | ★ | 最后 push | 内容 |
|---|---|---|---|
| [Samueli924/chaoxing](https://github.com/Samueli924/chaoxing) | 3779 | 2026-09-28 | 全自动任务点（协议发包，非考试） |
| [cxOrz/chaoxing-signin](https://github.com/cxOrz/chaoxing-signin) | 1796 | 2024-10-14 | 签到协议复现 |
| [aquamarine5/ChaoxingSignFaker](https://github.com/aquamarine5/ChaoxingSignFaker) | 948 | 2026-11-04 | 伪造签到（含**伪造人脸识别**） |
| [eric-gitta-moore/chaoxing-sign-app](https://github.com/eric-gitta-moore/chaoxing-sign-app) | 576 | 2026-09-11 | 第三方客户端、批量签到 |
| [notnotype/xxt](https://github.com/notnotype/xxt) | 286 | 2026-07-14 | 题库爬虫 |
| **Xposed-Modules-Repo/com.yinshibai.chaoxingx** | 151 | 2026-10-29 | **LSPosed 模块：WebView 题目捕获 + AI 自动答题 + 悬浮窗 + 截屏穿透；适配学习通 6.7.5** |
| [aglorice/new_xxt](https://github.com/aglorice/new_xxt) | 145 | 2024-02-27 | 协议层作业批量完成 |
| [bclswl0827/Fuck-ChaoXing](https://github.com/bclswl0827/Fuck-ChaoXing) | 55 | 2022-05-13 | **绕过人脸认证**（油猴）、字体加密 OCR、**反调试绕过（bypass-anti-debug）** |
| **PlutoNebula/chaoxing-exam-unlocker-project** | 8 | 2026-04-22 | **Web 端考试限制解除**（F12 反逃逸 Hook、复制/粘贴/iframe 内核劫持、死锁救援），V6.4，最新且最完整 |
| **qintaiyang/PassChaoxing** | 14 | 2026-04-29 | **手机端完整逆向**：516 API、20+ 加密算法、5 个 SO 反编译、jadx 全量源码 |
| [VarunS2002/Xposed-Disable-FLAG_SECURE](https://github.com/VarunS2002/Xposed-Disable-FLAG_SECURE) / [LSPosed/DisableFlagSecure](https://github.com/LSPosed/DisableFlagSecure) | 811 / — | 2025-03 / 2026-04 | **通用** FLAG_SECURE 解除（Android 12–16，含 A14 截图检测、A15 录屏检测） |

### 6.2 已公开的绕过手段（按层）

1. **请求层**：AdGuard/Fiddler 拦 `exit-count` 与 `receiveExamLogs?eventType=3/4` → 切屏不上报。**实测有效（2020）**，后续版本风险未知。([zhmd5](https://zhmd5.com/a/51/))
2. **Web 层（PC）**：UA 伪装成手机 + 直接访问 `mooc-ans/exam/phone/task-list?courseId=&classId=&cpi=`，绕过"仅限手机"限制；代价是完全失去摄像头/抓拍监控面。([博客园](https://www.cnblogs.com/craflyn/p/19416331))
3. **Web 层（防调试/防粘贴）**：原型链 `Function.prototype.constructor` 劫持 + 捕获阶段 `stopPropagation` + UEditor `addListener` 拦截 + iframe 内 `paste` 接管。([unlocker V6.4](https://github.com/PlutoNebula/chaoxing-exam-unlocker-project))
4. **原生层（FLAG_SECURE）**：LSPosed `Enable Screenshot` v5.0.1（Android 12–16，支持 HyperOS/ColorOS/OneUI；顺带关闭 A14+ 的截图检测与 A15+ 的录屏检测）。官方明确"仅支持官方 LSPosed"。([LSPosed 模块仓库](https://modules.lsposed.org/module/io.github.lsposed.disableflagsecure/))
5. **原生层（Root 隐藏）**：Magisk DenyList/Shamiko/Zygisk + 针对 `libRiskStub.so` 的 maps/GOT/ELF 检查做对抗。**未见公开的、验证通过的学习通专用方案**（`libRiskStub` 的解析本身来自 PassChaoxing，社区尚未看到针对性模块）。置信度：**低（未验证）**。
6. **虚拟机/克隆**：网上有大量"光速/VMOS/红手指"经验帖，但 `acceleration_check` 的传感器检测正是针对这一层；**无可靠成功案例**。置信度：低。
7. **第二块屏 / 悬浮窗 / 分屏**：2020 年经验帖称"华为智慧分屏小窗不被发现"（[ZOL](https://wap.zol.com.cn/ask/x_35386908.html)）；但同帖与后续大量帖都说"分屏会丢焦点 = 算切屏"，且**屏幕抓拍能直接拍到悬浮窗**。这与《优考试》厂商文章所述行业现状一致：手机上防的不是切屏，是**叠在答题页上的悬浮窗**。([中华网](https://m.tech.china.com/articles/20260929/202609291962988.html)) 置信度：中低。
8. **无障碍读屏**：理论上可读 WebView 语义树；但没有任何公开实测。**推断**：能读文字，读到的是"题目文本"，对"不在手机上看答案"的旁路无意义（题目本来就在你眼前）。
9. **PC 端 vs App 端**：电脑端**没有摄像头抓拍**，只有切屏检测（2020 年甚至检测不到最小化，[豆瓣实测](https://www.douban.com/group/topic/180271445/)）；但学校可以强制"仅限手机客户端答题"，且 `cryptUserAgent` 说明新版本已能在 Native 层校验客户端形态。
10. **"手机放电脑前当监控、电脑搜题"**：这是最流行的民间方案（同上豆瓣帖），但恰恰说明**屏幕抓拍 + 后置摄像头拍到显示器**是它的唯一破点。

---

## 七、一句话结论：桌面旁路方案能否天然绕开这些检测？

**结论：能绕开"截屏类、防调试类、读屏类"全部机制，但绕不开"行为与画面类"机制，且不改变任何服务端判定。**

拆开说：

| 机制 | 桌面旁路（答案显示在 PC/第二屏，手机只用来答题） | 理由 |
|---|---|---|
| FLAG_SECURE / 防截屏 | ✅ **天然无关** | 你根本不需要对考试页截图。屏障是像素外流，你不外流 |
| Web 端防复制/防调试（F12、UEditor） | ✅ **天然无关** | 若走 App 答题，这些 H5 限制甚至不生效在你身上 |
| Root/Hook 检测（libRiskStub） | ✅ **天然无关** | 方案不需要 root、不需要 Xposed、不需要 Frida |
| 无障碍读屏 | ✅ 无关 | 不需要 |
| **后置摄像头抓拍** | ⚠️ **是唯一真实风险** | 手机考试要求"右上角一直启用摄像头，前后摄像头不定时抓拍"；电脑屏幕若进入后置视野即被拍到。规避靠**物理摆位与角度**，不靠技术 |
| **前置摄像头抓拍 + 人脸** | ⚠️ 需保持人脸在框内 | 眼睛/头部姿态异常见于人工复核；已有帖子称抓拍帧分辨率有限、可"说话"（[ZOL](https://wap.zol.com.cn/ask/x_35386908.html)），但**这是风险不是保证** |
| **屏幕抓拍（MediaProjection）** | ✅ **天然无关** | 手机上只有答题页，屏上没有答案 |
| **切屏次数/时长** | ✅ **天然无关（前提是不切屏）** | 只要答题期间不离开考试页，`exit-count` 永远是 0；这正是桌面旁路相对"切屏搜题"的核心优势 |
| **答题节奏埋点** | ⚠️ 部分暴露 | 每页停留时长会异常短/规律（尤其对照题），教师可看 |
| **服务端判定（人脸比对、多 IP、设备汇聚、异常累计）** | ❌ **完全无法影响** | 这些不取决于你怎么看答案 |

**一句话**：桌面旁路在"检测面"上是**近乎正交**的——它不触发任何一个"客户端环境检测"，也不会产生"截屏/录屏/读屏"痕迹，唯一的暴露面是**摄像头画面与行为时序**，这两项都不是靠技术手段解决而是靠物理布置与节奏控制。真正的风险不在端上，在 **教师人工复核抓拍图 + 服务端时序一致性**。

---

### 附：本次调研未解决 / 需要进一步验证的问题

1. `setFlags(FLAG_SECURE)` 在反编译源码中的具体类（`PassChaoxing` 未收录考试 Activity）。
2. `get_screen_shared_status()` 的实际调用时机与路径（文档标记为 `?`）。
3. 新版是否有**系统代理检测**、**无障碍服务列表检测**——目前无一手证据，网上说法疑为经验外溢。
4. `libRiskStub.so` 是否包含 root 路径探测（已解析的 4 个函数里没有，但可能在他处）。
5. 2024 年后是否引入 TLS pinning（`webRequestSign` 存在说明有 Native 签名，但 pinning 未验证）。

> 本文档仅为机制与协议层面的技术分析，不含任何可执行攻击代码。
