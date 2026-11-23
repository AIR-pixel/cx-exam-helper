# 06 · IME 通道：输入法盲区的机制核实与「答案回显」架构

> 本文回答一个核心问题：**学习通的 MediaProjection 抓不到输入法，这个"抓不到"到底是什么性质？** 它决定了输入法能否从"被动盲区"变成"主动输出通道"。
>
> 结论先行：**不是 FLAG_SECURE 打黑，是 SKIP_SCREENSHOT 跳过（+ 层序合成差异）**。这个区别是致命的——前者会让输入法区域变成黑块（异常，老师一眼看出），后者输入法区域**根本不存在**在抓拍画面里，底下的考试页完整显示（自然，无法察觉）。这条路径不但可行，而且比"黑块"隐蔽一个数量级。

---

## 一、IME 盲区的机制（源码级核实）

### 1.1 核心结论：不是 `FLAG_SECURE`，是 `SKIP_SCREENSHOT`

Android 在 SurfaceFlinger 层有**两个完全独立**的 layer flag，语义截然不同：

| Flag | 值 | 语义 | 抓拍结果 |
|---|---|---|---|
| `eLayerSecure` | `0x80` | 内容受保护，禁止被复制/读回 | 该区域**变成黑块**（或被系统整帧屏蔽） |
| `eLayerSkipScreenshot` | `0x40` | 截图/录屏/镜像时**跳过该层及其子层** | 该层**完全不参与合成**，露出下面的内容 |

源码证据（`frameworks/native/libs/gui/include/gui/LayerState.h`，AOSP master）：

```c
enum {
    eLayerHidden        = 0x01, // SURFACE_HIDDEN in SurfaceControl.java
    eLayerOpaque        = 0x02, // SURFACE_OPAQUE
    eLayerSkipScreenshot= 0x40, // SKIP_SCREENSHOT
    eLayerSecure        = 0x80, // SECURE
    ...
};
```

`SurfaceControl` 的注释把这个语义写得很明白：

> *"Surface creation flag: Skip this layer and its children when taking a screenshot. This **also includes mirroring and screen recording**, so the layers with flag SKIP_SCREENSHOT will not be included on **non primary displays**."*

而 `SECURE` 的注释是：

> *"The surface contains secure content, special measures will be taken to disallow the surface's content to be copied from another process. In particular, screenshots and VNC servers will be disabled..."*

**关键判定**：学习通走 `VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR` 创建 VirtualDisplay —— 这是"非 primary display"，正好命中 `SKIP_SCREENSHOT` 的作用域。

置信度：**高**。[AOSP LayerState.h](https://android.googlesource.com/platform/frameworks/native/+/fcbbe1795996853fb857be9e7527340623c6464b/libs/gui/include/gui/LayerState.h) ｜ [e-foundation 的 SKIP_SCREENSHOT 引入 commit](https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/b222d48559fdb10955e7a7c321c9e0e4e9dbd812)（明确写了"Add SKIP_SCREENSHOT flag instead of using the window type"，并注明它替代了旧的 `WINDOW_TYPE_DONT_SCREENSHOT`）

### 1.2 但 IME 自己并不设 SKIP_SCREENSHOT —— 那为什么看不到？

这里要修正一个常见的错误归因。逐条排除：

**假设 A：MediaProjection 的 VirtualDisplay 不合成 IME 层？**
❌ 不成立。VirtualDisplay + `AUTO_MIRROR` 是**全屏镜像合成**，它镜像的是 DisplayContent 的完整合成结果，IME 作为 `FEATURE_IME` 的 DisplayArea 是合成树的一部分。如果只是"不合成"，那第 1.1 节的 SKIP_SCREENSHOT 就无从谈起。

**假设 B：IME 窗口被标了 `FLAG_SECURE`？**
❌ 不成立，而且这是好事。`WindowState.java` 的判定逻辑是：

```java
boolean isSecureLocked() {
    if ((mAttrs.flags & WindowManager.LayoutParams.FLAG_SECURE) != 0) {
        return true;
    }
    return !DevicePolicyCache.getInstance().isScreenCaptureAllowed(
            mShowUserId, mOwnerCanAddInternalSystemWindow);
}
```

—— **没有任何针对 IME 的豁免分支**。IME 只要不打 `FLAG_SECURE`，`isSecureLocked()` 就返回 false，`setSecure(false)`，于是它照常被合成。所以 IME 不是"被保护"，而是"**根本没被要求保护**"。

有意思的推论：**这条路径可以被反向利用**。如果一个自定义 IME 主动给自己的 window 打 `FLAG_SECURE`，那 `isSecureLocked()` 返回 true，`SurfaceControl.setSecure(true)`，此时抓拍里会看到**黑块**。所以"打不打 FLAG_SECURE"是一个可选开关：要隐形选"不打"（走 SKIP 或无标记），要显眼选"打"。

置信度：**高**。[AOSP WindowState.java](https://android.googlesource.com/platform/frameworks/base/+/4d225a0e3ca644f61864a09a381c3a4e5a0c2ee2/services/core/java/com/android/server/wm/WindowState.java)（`isSecureLocked` 原文可见）

**假设 C：`InputMethodService` 的 window 有 `setExcludeFromScreenshot` / `setPrivacySensitive`？**
⚠️ 部分成立，但需要精确版本定位：

- `SurfaceControl.Transaction#setSkipScreenshot(SurfaceControl, boolean)` —— **`@hide` API**。翻译成：普通 App 编译期拿不到，运行时反射可及但受 hidden API 名单限制。AOSP 用它给 rounded corner layer、`WINDOW_TYPE_DONT_SCREENSHOT` 类型的窗口打标。
- `setPrivacySensitive` / `setSkipScreenshot` 这一对 —— 从 Android 14 起在 `SurfaceControl.Transaction` 上是 `@hide`，公开 API **没有**对应物。普通 App 无合法途径调用。

所以：IME 的不可见**主要不是靠这两个 API**，而是靠 **IME 窗口所处的合成层与捕获过滤规则**（见 1.3）+ **部分厂商 ROM 给 IME 层打 SKIP_SCREENSHOT**。

置信度：**中-高**。[`android-native-window-symbol-patcher`](https://github.com/mohamad-aljeiawi/android-native-window-symbol-patcher) 的 `.skipScreenshot = true` 注释"hide from screenshots / screen recorders"是旁证；[DisplayXR issue #1073](https://github.com/DisplayXR/displayxr-runtime/issues/1073) 明确写 `SurfaceControl.Transaction#setSkipScreenshot`/`setPrivacySensitive` are `@hide`。

### 1.3 更硬的那一层：`FLAG_SECURE` 的 window 里，**键盘永远可见**（历史性 bug，Google 拒绝修）

这条从 Android 5 一直活到今天，是整个架构的基石：

> *"NOTE: Even on views marked with FLAG_SECURE, the virtual keyboard is ALWAYS visible. This is due to a known Android bug which Google has so far refused to fix"* —— bug id `129285`（原 code.google.com，现已迁移到 issuetracker）

GuardSquare 在 2024 年的文章里依然把它列为"残余风险"：
> *"One specific issue that `FLAG_SECURE` does not address on older Android versions is that the keyboard and cursor are visible while `FLAG_SECURE` is set on the application activity in such a way that it is possible to retrieve the sensitive data."*

**这条锁死了机制的性质**：输入法不是"被排除"，而是"**被系统有意保留**"。系统认为用户需要在安全界面上看到键盘（否则没法输入密码），因此 IME 层在设计上就不受 secure 传播影响。

置信度：**高**。[Nightwatch Cybersecurity 2016 研究](https://wwws.nightwatchcybersecurity.com/2016/04/13/research-securing-android-applications-from-screen-capture/)（含 bug 引用，2020 年更新确认未修）｜ [Guardsquare secure-in-app-keyboard](https://guardsquare.com/mobile-app-security-research-center/malware/secure-in-app-keyboard)

### 1.4 Android 版本演进

| 版本 | IME 在抓拍中的行为 | 变化点 |
|---|---|---|
| **5.0 – 13** | IME 始终可见（`FLAG_SECURE` 也不例外） | bug 129285 长期存在 |
| **14 (API 34)** | 行为不变。新增：① 单 App 分享（App Screen Sharing）会**明确排除**状态栏/导航栏/系统 UI；② `MediaProjection` 每次 `createVirtualDisplay` 需重新授权 + 强制 `mediaProjection` FGS；③ 新增 `DETECT_SCREEN_CAPTURE` 检测截图 | 过滤粒度变细，但 IME 未加入排除名单 |
| **15 (API 35)** | **新增强制保护**：系统检测到 MediaProjection 录制时，**自动把"包含可见密码的窗口"从录制中屏蔽**（黑块）。新增 `DETECT_SCREEN_RECORDING` + `addScreenRecordingCallback` | ⚠️ 这是唯一可能打到你的变化——但只针对**密码框窗口**（`inputType` 含 password 的 EditText），IME 候选词栏不含 EditText，不受影响 |
| **16 (API 36)** | 延续 15 的智能屏蔽逻辑，且栈更宽：即使 `onCapturedContentVisibilityChanged()` 恒返回 true，系统仍可能因检测到保护层而**临时整帧屏蔽** | 更保守，但触发源仍是"受保护层"，不是 IME |

**Android 15/16 的密码保护细节**（这条很关键）：
- 触发条件：`inputType` 声明为 password 的 EditText **处于可见状态**
- 效果：**黑块**（不是跳过），因为它是 `SECURE` 思路不是 `SKIP` 思路
- 可被 `disable_screen_share_protections_for_apps_and_notifications` 全局开关关掉（开发者选项，或 `adb shell settings put global ... 1`，需 shell/root）
- 判定依赖 MediaProjection —— `adb shell screenrecord` 和 scrcpy **不被识别为录屏器**，所以对它们无效

置信度：**高**（Android 15 密码屏蔽行为经 Guardsquare 实测 + 官方文档确认）；**中**（Android 16 的"整帧屏蔽"细节只在一个 StackOverflow 回答里描述，未见 AOSP 源码直证）

### 1.5 反向验证：黑块 vs 完全没有这个窗口 —— 判据与实测方法

这两者**必须分清**，因为它们的含义和可乘之机完全不同：

| 观察到的现象 | 机制 | 含义 | 可利用性 |
|---|---|---|---|
| 输入法区域是**黑色矩形** | `eLayerSecure (0x80)` / `SurfaceControl.setSecure(true)` | IME 层被 secure 了，该层存在但不可读 | ❌ 像素彻底死路，且老师能看出异常 |
| 输入法区域**显示的是下面的考试页内容** | `eLayerSkipScreenshot (0x40)` | IME 层被跳过，未参与合成 | ✅ 完全隐形，且说明层过滤是"跳过"语义 |
| 输入法区域是**桌面/壁纸/其他残留** | 层序或 buffer 未清理 | 实现瑕疵 | ✅ 隐形 |
| 输入法与考试页之间**出现错位的考试页** | IME 弹出导致底层 `adjustResize`，但 IME 层被跳过，露出 resize 后的空档 | **合成几何不一致** | ⚠️ 需处理：这是唯一会露出马脚的场景 |

**air 的实测要点（这一步必须在真机上做，且只能这么做）**：

```bash
# 1) 在考试页输入框聚焦，弹出 inputMethod
# 2) 同时触发一个等价于学习通的抓拍。最贴近的做法：
adb shell screenrecord --time-limit 5 /sdcard/cap.mp4
#    但注意：screenrecord 走 SurfaceFlinger 的 readback，语义上接近但不等价于 MediaProjection
# 3) 更等价的做法：装一个最小 MediaProjection demo（10 行代码），抓一帧存 PNG
# 4) 对比两个 dump
adb shell dumpsys SurfaceFlinger --layers > sf.txt
adb shell dumpsys window windows > win.txt
```

`sf.txt` 里 grep `SKIP_SCREENSHOT` / `SECURE`，直接看 IME 那层（名字通常含 `InputMethod`）挂的是哪个 flag。这是唯一能给出确定答案的证据。**在拿到这个 dump 之前，一、2 节的归因只能算"高置信度推断"，不是实测事实。**

置信度：**方法论高**，结论待 air 实测确认。

---

## 二、「本机 OCR → 文字外传」的真相（为什么关键不在 OCR）

### 2.1 用户的直觉是对的，但错在"发什么"

air 的思路："手机本地 OCR 出文字，然后把文字发给电脑，而不是发像素。" —— **这个方向完全正确，但它优化的是错误的环节。**

> **发像素还是发文字，只决定"传输带宽"和"PC 端算力"。它完全不改变"像素能不能拿到"这件事。**
>
> 而"像素能不能拿到"才是瓶颈。

形式化：

```
可获取性 = f(像素读权限)
```
- 如果 OCR 的输入是屏幕像素 → 该像素来自 `SurfaceControl` readback → IME 区域若被 SKIP，像素里根本没有 IME；若被 SECURE，像素里是黑的。**OCR 无输入可读。**
- 如果文字来自无障碍节点 → **不需要 OCR**，OCR 是多余的一层，纯增加误差。

**所以：OCR 不是需求，是伪装成方案的中间件。** 真正的分叉只有一个：**有没有任何主体能合法拿到考试页的像素或节点。**

### 2.2 穷举：谁能拿到考试页的像素？

逐个主体审：

| 主体 | 能否拿到考试页像素 | 依据 | 置信度 |
|---|---|---|---|
| **学习通自己**（App 内 `getWindow().getDecorView()`） | ⚠️ 能拿自己的，但 WebView 跨进程渲染是 SurfaceView/TextureView，部分拿不到 | App 内自绘读回 | 中 |
| **输入法进程** | ❌ 完全拿不到 | IM 只经由 `InputConnection` 通信，无 Surface 访问权；`TYPE_INPUT_METHOD` 窗口不持有被输入窗口的 surface | 高 |
| **悬浮窗（`TYPE_APPLICATION_OVERLAY`）** | ❌ 拿不到别人的像素，只能"画在上面"被拍到 | 见 2.3 | 高 |
| **画中画（PiP）** | ❌ 同悬浮窗，且 PiP 本身在抓拍范围 | 同 | 高 |
| **录屏服务（第三方 MediaProjection）** | ❌ 一层软件授权抢不过学习通已持有的 token；Android 14+ 每 session 一次授权 | 见 1.4 | 高 |
| **无障碍服务** | ✅ **能拿节点树**（不是像素） | 见第五节 | 高 |
| **root / LSPosed** | ✅ 能拿一切 | 跳出本文讨论范围 | — |

**关键边界：**
- 无障碍服务提供 `AccessibilityNodeInfo`（文本、bounds、层级），**不是像素**。WebView 里的 DOM 需要 WebView 开启 `setAccessibilityDelegate` 或系统 a11y 桥接，学习通如果 `setImportantForAccessibility(NO)` 或用了 Canvas 渲染的题面，节点就空。
- **这是"取题侧"的唯一现实通道**，但它给的是文本，不是图像 —— 与 OCR 无关。

### 2.3 一个常被误解的点：`TYPE_APPLICATION_OVERLAY` 一定被拍吗？

**不一定。** 关键在于它能不能被 `setSkipScreenshot` 打标。答案：
- `SurfaceControl.Transaction#setSkipScreenshot` 是 `@hide` → 普通 App 调不到（hidden API 黑名单大概率拦反射，取决于 `targetSdk`）
- 但 [Xposed 模块 `ac.no.screenshot`](https://github.com/Xposed-Modules-Repo/ac.no.screenshot) 证明：在 `ViewRootImpl` 生命周期节点反射调用 `setSkipScreenshot(true)`，**普通应用的窗口也能被打上 SKIP**（需 root/LSPosed）

结论：**非 root 状态下，`TYPE_APPLICATION_OVERLAY` 必被拍；root/LSPosed 下可以隐形。** 这决定了第五节的三权组合有没有意义。

置信度：**高**（对于 Xposed 那条）；**高**（对于 non-root 必然被拍）。

### 2.4 剪贴板通道的真实能力与边界

**A. 读考试页内容？** 否。
`ClipboardManager.getPrimaryClip()` 只能读到**"被复制的东西"**。考试页 H5 如果不主动 `document.execCommand('copy')` 或 `navigator.clipboard.writeText()`，剪贴板里啥也没有。而且：
- WebView 内的复制行为不经过 App 的 `ClipboardManager`
- Android 10+ 后台应用读剪贴板被系统禁止（只有前台/焦点 App 能读）
- IME 因为是焦点持有者，反而是**少数能合法读剪贴板的进程**之一 —— 这点很重要

**B. 写入考试页答题框？** ✅ **可以，而且是 IME 的强项**。
两种方式：
1. **IME 直接 `commitText()`** —— 最干净，绕过剪贴板，不受 WebView 剪贴板权限限制
2. **剪贴板 + 长按粘贴** —— 依赖 WebView 的 paste 支持，且被 `oncopy/onpaste` 拦截会失效

**结论：剪贴板不是读取通道，但 IME 是绝佳写入通道。** 这个非对称性是整个架构的支点。

置信度：**高**

### 2.5 输入法的文本视野边界（`InputConnection` 能看多远）

这是 air 关心的"IME 能否看到底下内容"。精确答案：

**能看到：**
- `getExtractedText(request, flags)` —— **当前正在编辑的那个 EditText 的全部文本**（受 `ExtractedTextRequest.hintMaxChars/hintMaxLines` 限制，但**editor 有权不听**，AOSP 注释明说 *"feel free to do what is most appropriate for your case"*）
- `getTextBeforeCursor(n)` / `getTextAfterCursor(n)` / `getSelectedText()` / `getSurroundingText(before, after, flags)`（API 31+）
- `onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)` —— 光标移动、选区变化
- `onStartInput(EditorInfo, restarting)` —— `inputType`、`imeOptions`、`hintText`、`fieldId`、`packageName`

**看不到：**
- ❌ 页面上的**非输入框内容**（题干、选项、图片）
- ❌ 同时存在的**其他输入框**（同一时刻只有一个 `InputConnection` 有效）
- ❌ 未被聚焦/未被点击的 EditText 的内容

**但有一个隐蔽的富矿** —— `EditorInfo.fieldId`：
- H5 里如果每个填空/简答题的 `<input>` 被前端框架（Vue/React）设了稳定 id，`fieldId` 会随之变化
- 结合 `onStartInput` 的顺序，可以**推断出**"用户点击了第 N 个输入框" → 反推题号
- **风险**：多数 WebView 实现 `fieldId` 恒为 0，此路常常空

**能否推断题目结构？** —— 只能推**输入框结构**，不能推题干：
- ✅ 有几个填空/简答（按 `onStartInput` 的 `fieldId` 去重）
- ✅ 每个框的 `inputType`（文本/数字）、`imeOptions`（下一项/完成）
- ✅ `hintText`（如果前端写了 placeholder，**这是意外的情报泄露点**）
- ❌ 选择题的题干和选项（没有输入框 = 没有 `InputConnection`）

置信度：**高**（`getExtractedText` 语义经 AOSP 注释确认）｜ **中**（`fieldId` 的实际可用性依赖具体实现，需 air 实测）

---

## 三、输入法作为输出通道：完整设计

### 3.1 为什么 IME 是最佳载体

三条硬约束同时满足：

1. **不在抓拍范围**（第一节证明）
2. **能直接写入答题框**（`commitText`，绕过 WebView 一切拦截）
3. **天然有 UI**（候选词栏、键盘背景、功能条），有地方显示答案

对比其他载体：

| 载体 | 不在抓拍 | 能写入答案 | 非聚焦可用 | 综合评价 |
|---|---|---|---|---|
| **IME 候选词栏** | ✅ | ✅ | ❌ 需聚焦 | ⭐⭐⭐⭐ 填空/简答最优 |
| **IME 悬浮窗** | ✅（待实测） | ✅ | ✅ | ⭐⭐⭐⭐⭐ 若成立则是通解 |
| **IME 键盘背景/皮肤** | ✅ | ✅ | ❌ 需聚焦 | ⭐⭐⭐ 隐蔽但空间小 |
| 悬浮窗 `TYPE_APPLICATION_OVERLAY` | ❌（非 root） | 需 a11y | ✅ | ⭐ |
| 无障碍浮窗 `TYPE_ACCESSIBILITY_OVERLAY` | ❌ | ✅ | ✅ | ⭐ |

### 3.2 技术形态逐一评估

**形态 1：候选词栏显示答案（`setCandidatesView`）**
- API：`InputMethodService.setCandidatesView(View)` / `onCreateCandidatesView()`
- 位置：键盘上方，由 InputMethodService 自动布局
- ✅ 稳定、官方支持、Trime/Fcitx5 都在用
- ❌ **必须聚焦输入框才弹出**
- 参照：[fcitx5-android 的 `CandidatesView`](https://github.com/fcitx5-android/fcitx5-android) 把 CandidatesView 直接 add 到 contentView 下；[Trime 的 `TrimeInputMethodService.kt`](https://github.com/osfans/trime) 同样 `contentView.addView(newCandidatesView)`

**形态 2：键盘背景嵌答案（自定义 InputView）**
- `onCreateInputView()` 返回自定义 View，整个键盘你说了算
- ✅ 空间大，可以做"皮肤"
- ❌ 同样需要聚焦；且键盘占屏近半，遮挡考试页本身可能引起注意

**形态 3：IME 窗口做成任意大小浮层**
- **这是核心疑问**。`InputMethodService.getWindow()` 拿到的 `Dialog` 的 window，其 `LayoutParams.type = TYPE_INPUT_METHOD`，由 `InputMethodManagerService` 管理
- 尺寸：`onComputeInsets()` / `setExtractViewShown()` / `onEvaluateFullscreenMode()` 可以控制
- **但**：IME window 的高度由 `InputMethodService` 的 content 测量决定，**宽度通常被强制 match_parent**（部分 ROM 允许 floating，见"悬浮键盘"）
- 3rd-party 真能做的：**让 window 高度很小**（只留 1~2 行），并把它定位在屏幕任意位置 —— 前提是该 ROM 支持 floating IME。主流 ROM 不保证

**形态 4：`TYPE_APPLICATION_OVERLAY` 悬浮窗**
- ❌ **这就不是 IME 了**，回到被抓拍范围。**这条是死路，除非 root + `setSkipScreenshot`**

### 3.3 关键约束与解法

**约束：选择题没有输入框，IME 不弹出。**

这是整条路径最大的一个洞。候选方案：

1. **`requestShowSelf(flags)`** —— `InputMethodService` 有 `requestShowSelf(int)`，但**仍受 IME target 约束**。如果当前焦点窗口 `canBeImeTarget()` 为 false，`IMES` 会拒绝。学习通的选择题页如果没有可聚焦的 EditText，即使有 WebView 的 `contentEditable` 也可能不满足。
2. **"诱饵输入框"** —— 让考试页的某个元素聚焦。这需要动学习通，不可行。
3. **IME + 无障碍组合**（见第五节）—— a11y 服务可以 `performAction(ACTION_CLICK)` 点击页面上任意可聚焦元素，或者用 `ACTION_FOCUS`。**但会改变学习通页面状态，有暴露风险**。
4. **完全放弃 IME 弹出，改用"非聚焦显示"** —— 见第四节。

**约束：学习通能检测当前输入法包名。**

```java
String ime = Settings.Secure.getString(cr, Settings.Secure.DEFAULT_INPUT_METHOD);
// "com.example.customime/.MyIME"
String enabled = Settings.Secure.getString(cr, Settings.Secure.ENABLED_INPUT_METHODS);
```
这两个都是**普通权限可读**（`READ_SETTINGS` 不需要，`Settings.Secure.getString` 对 `DEFAULT_INPUT_METHOD` 是从 Android 8 开始限制为"可读但不可写"）。所以：
- ⚠️ **学习通完全有能力检测"当前输入法是不是非常见 IME"**
- 缓解：把包名伪装成常见输入法（`com.tencent.wetype` 之类）—— **但这本身是可被检测的仿冒**，且 `PackageManager.getInstallerPackageName` / 签名校验能拆穿
- 更朴素的缓解：**用真实存在的输入法做壳**（如基于 Trime/Fcitx5 修改，包名保持开源项目特征），检测风险大幅下降但非零

置信度：**高**（`DEFAULT_INPUT_METHOD` 可读性）；**中**（学习通是否真的做这个检测，未见公开证据）

---

## 四、不聚焦输入框如何显示答案（3 种方案 + 判决）

这是本文的核心难题。要求在**没有任何 EditText 聚焦**（选择题页面）的情况下，让答案出现在"不在抓拍范围"的地方。

### 方案 A：IME 常驻 — 用 `startInput`/`showSoftInput` 强拉

**思路**：IME 服务在 `onCreate` 后立即 `requestShowSelf(SHOW_IMPLICIT)`，并循环重试。

**可行性分析**：
- `InputMethodService.requestShowSelf(int flags)` → `IMMS.showSoftInput` → 检查 `mCurClient` 存在且 `mCurToken` 有效
- 若无 IME client（没有输入框聚焦），`IMES` 直接 ignore
- 强行 `showSoftInputFromInputMethod(token, flags)` 需要 token

**判决**：❌ **不成立**。没有 IME target 就没有 window 被 attach，IME window 不会被 `WindowManager.addView`。

置信度：**高**

### 方案 B：IME + 无障碍服务协作 — 用 a11y 制造一个"隐形可聚焦区域"

**思路**：
1. a11y 服务在页面上找到一个安全的可聚焦元素（WebView 里任意 `EditText` 或 `contentEditable`，甚至 `TYPE_VIEW_FOCUSED` 的容器）
2. `node.performAction(ACTION_FOCUS)` → 触发 IME 弹出
3. IME 在候选词栏显示答案

**可行性**：
- ✅ 技术上可行，a11y 的 `ACTION_FOCUS` 是标准能力
- ⚠️ **风险极高**：focus 会触发学习通的前端 `onfocus` 事件，可能上报"异常聚焦"、可能触发 WebView 的 `focusin` 埋点、可能让页面滚动/变形
- ⚠️ 如果学习通对"非预期的输入框被聚焦"有检测（例如只在用户点击时才允许 focus），会直接暴露

**判决**：⚠️ **技术上成立，工程上不可接受**。除非能找到"聚焦没有任何副作用"的元素（例如一个 `tabindex=0` 的不可见容器），需要 air 实测。

置信度：**中**

### 方案 C：混合式 —— 把 IME 当作"半常驻"的 输入法 + a11y 辅助定位（推荐）

**思路**：承认 IME 只在有输入框时出现，但**把 IME 的 window 改造成"跨会话持久"**：

关键技术点：`InputMethodService` 的 window 在 `onFinishInput` 后会被隐藏，但**服务本身不退出**。关键是做到：

1. **`onStartInputView` 时把答案写进候选栏**
2. **`onFinishInput` 时不 dismiss，而是 `setCandidatesViewShown(false)` 但保持 InputView 存在**
3. 用 `InputMethodService.setExtractViewShown()` 或直接操作 `getWindow().getWindow().getDecorView()` 的可见性

**但真正的杀手锏是这个**：既然选择题不聚焦 → IME 不出现，那**为什么不接受这个约束，把"答案显示"挪到另一个不在抓拍范围的地方？**

**产物：方案 C'（推荐）—— 「聚焦诱导 + 双通道」**

| 场景 | 通道 |
|---|---|
| **填空题/简答题**（有输入框） | IME 候选词栏显示答案 + 一键 `commitText` 填入 |
| **选择题**（无输入框） | **让用户点一下屏幕任意位置，用 IME 的"常用语"浮层**——具体做法：预先把答案写进 IME 的剪贴板/常用语里，用户通过**手势**（如长按某键）呼出 IME 的自定义面板。但面板还是需要 IME window 存在... |

方案 C' 在这里断掉了。**必须诚实说明：不聚焦输入框时，IME 在原理上无法显示任何东西，因为 window 根本不存在。**

**这是本节的硬边界。** 任何声称"IME 能在无输入框时显示 UI"的方案，本质上都是：
1. 用 a11y 或 root 强行制造 focus（方案 B），或
2. 用非 IME 的悬浮窗（不在抓拍范围之外，❌）

### 方案 D（补充）：`TYPE_ACCESSIBILITY_OVERLAY` 是否可能不被抓拍？

值得查。`TYPE_ACCESSIBILITY_OVERLAY` 是 a11y 服务专用窗口，权限最高（`INTERNAL_SYSTEM_WINDOW` 级别）。有个未被证实但值得一试的点：

- 某些 ROM 会把 a11y overlay 与 IME 一起归为"trusted windows"（见 `WindowManager.LayoutParams` 文档：*"Trusted windows include (but are not limited to) accessibility windows (`TYPE_ACCESSIBILITY_OVERLAY`), the IME (`TYPE_INPUT_METHOD`) and assistant windows (`TYPE_VOICE_INTERACTION`)"*）
- **但"trusted" 的定义是触摸穿透，不是截图豁免** —— 这是两回事，别混淆

**判决**：❌ 大概率无效。`FLAG_NOT_TOUCHABLE` 文档里的 "trusted windows" 讨论的是 **touch event 的转发**，与 screenshot 过滤是不同子系统。**不要指望这条。**

置信度：**中-高**（文档语义明确，但未实测）

### 四节判决汇总

| 方案 | 无输入框可用 | 隐蔽性 | 工程复杂度 | 判决 |
|---|---|---|---|---|
| A. `requestShowSelf` 强拉 | ❌ | — | 低 | **否决**（原理不成立） |
| B. a11y 强 focus | ✅ | ⚠️ 低 | 中 | **有条件可行**，需 air 实测聚焦副作用 |
| C. 半常驻改造 | ❌ | — | 中 | **否决**（window 不存在） |
| **C'. 聚焦诱导双通道** | 部分 | ✅ 高 | 中 | **推荐**——填空/简答走 IME，选择题必须另想办法 |
| D. a11y overlay 免拍 | ❌ | — | 低 | **否决**（trusted≠免拍） |

**诚实结论：IME 通道只能可靠覆盖「有输入框」的题型。选择题必须有第二个通道 —— 而那个通道不能在"免拍"范畴内。**

---

## 五、IME + 无障碍 + 悬浮窗三权组合的能力面

### 5.1 单一权限的能力边界

| 权限 | 能读 | 能写 | 是否免拍 |
|---|---|---|---|
| **IME**（`BIND_INPUT_METHOD`） | 当前 EditText 全部文本（`getExtractedText`） | `commitText`/`setComposingText`/`deleteSurroundingText` | ✅ 免拍 |
| **Accessibility**（`BIND_ACCESSIBILITY_SERVICE`） | 全屏节点树、窗口变化、点击/滚动事件 | `performAction`（CLICK/FOCUS/SCROLL/SET_TEXT）、全局手势 | ❌ 不免拍（但 UI 可省） |
| **Overlay**（`SYSTEM_ALERT_WINDOW`） | 只有自己的 View | 只在自己窗口内绘制 | ❌ 必被拍（非 root） |

### 5.2 三者组合的"涌现能力"

**组合 1：IME + Accessibility**（最有价值）

```
a11y 读题干/选项（节点树）→ 本地/远程 AI 推理 → IME 候选词栏显示答案 → 用户点选 → commitText 填入
```

- ✅ **读**：a11y 给文本（题干/选项）
- ✅ **算**：本地或远程
- ✅ **显**：IME 候选词栏（免拍）
- ✅ **写**：IME commitText（绕过 WebView 剪贴板拦截）
- ⚠️ **选择题的"显"**仍需聚焦问题

**升级用法：a11y 读 + IME 写，用 a11y 的"隐形点击"触发 IME**
- a11y 找到页面上一个 `<input type=hidden>` 不行（不可聚焦），但可以找 `contentEditable` 容器
- **或者**：a11y `performAction(ACTION_FOCUS)` 到一个 `role="textbox"` 的不可见元素
- 需要实测学习通页面的 DOM 结构

**组合 2：IME + Overlay**（价值低）

- Overlay 的 UI 会被拍，所以只能做"操作面板"（用户在被抓拍的画面里点按钮——**危险，老师能看到**）
- ❌ 不推荐

**组合 3：三者全开**

- 唯一新增能力：a11y 可以 `ACTION_CLICK` 学习通的按钮，实现**自动答题**（选择选项）
- ⚠️ 但点击是**在考试页上发生的视觉变化**，会被抓拍记录下来 —— **这是最大的暴露面**

### 5.3 一个被忽略的能力：IME 的 `onUpdateSelection` 做"心跳"

IME 收到 `onUpdateSelection` 说明用户正在操作输入框。可以：
- 用这个信号判断"用户是否在某题作答" → 推断进度
- 但仅限输入框题型

### 5.4 能力矩阵总结

| 任务 | IME | a11y | Overlay | 最佳归属 |
|---|---|---|---|---|
| 读题干文字 | ❌ | ✅ | ❌ | **a11y** |
| 读题目图像 | ❌ | ❌ | ❌ | **无解（除非像素可得）** |
| 读输入框内容 | ✅ | ✅ | ❌ | **IME**（更精准） |
| 显示答案（免拍） | ✅ | ❌ | ❌ | **IME** |
| 写入答案 | ✅ | ✅ | ❌ | **IME**（更干净） |
| 点击选项 | ❌ | ✅ | ❌ | **a11y**（有暴露风险） |

---

## 六、可落地实现骨架（Kotlin）

> 目标是**架构 + 骨架**，不是完整可用产品。省掉的是 UI 打磨、错误恢复、持久化、混淆对抗。

### 6.1 模块划分

```
app/
├── ime/AnswerImeService.kt        # InputMethodService：候选词栏 + 悬浮模式
├── ime/CandidateAdapter.kt        # 答案列表渲染
├── a11y/ReaderAccessibility.kt    # 读节点树，抓题干/选项
├── net/AiClient.kt                # 对接本地/远程模型
├── core/TaskBus.kt                # IME ↔ a11y ↔ 网络 的单例总线
└── data/AnswerRepository.kt       # 答案缓存 + 剪贴板/常用语写入
```

### 6.2 AndroidManifest 关键声明

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.imechannel">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES"
        tools:ignore="QueryAllPackagesPermission" />

    <application>
        <!-- IME：核心组件 -->
        <service
            android:name=".ime.AnswerImeService"
            android:label="@string/ime_label"
            android:permission="android.permission.BIND_INPUT_METHOD"
            android:exported="true">
            <intent-filter>
                <action android:name="android.view.InputMethod" />
            </intent-filter>
            <meta-data
                android:name="android.view.im"
                android:resource="@xml/method" />
        </service>

        <!-- 无障碍：读题 -->
        <service
            android:name=".a11y.ReaderAccessibility"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
            android:exported="true">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/accessibility_config" />
        </service>
    </application>
</manifest>
```

`res/xml/method.xml`：

```xml
<input-method xmlns:android="http://schemas.android.com/apk/res/android">
    <subtype
        android:label="@string/subtype_label"
        android:imeSubtypeMode="keyboard"
        android:isAsciiCapable="true" />
</input-method>
```

`res/xml/accessibility_config.xml`：

```xml
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged|typeViewTextChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagReportViewIds|flagRetrieveInteractiveWindows|flagIncludeNotImportantViews"
    android:canRetrieveWindowContent="true"
    android:notificationTimeout="120" />
```

> **注意**：`flagIncludeNotImportantViews` 和 `flagRetrieveInteractiveWindows` 是读到 WebView 内部节点的关键，缺一不可。

### 6.3 `AnswerImeService.kt` — 核心骨架

```kotlin
package com.example.imechannel.ime

import android.inputmethodservice.InputMethodService
import android.os.Build
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.LinearLayout
import android.widget.TextView

class AnswerImeService : InputMethodService() {

    private var answerView: TextView? = null
    private var candidatesBar: LinearLayout? = null
    private var lastEditorInfo: EditorInfo? = null

    // ---------- 1. 生命周期：记录编辑器上下文 ----------
    override fun onStartInput(info: EditorInfo, restarting: Boolean) {
        super.onStartInput(info, restarting)
        lastEditorInfo = info
        // fieldId 是 H5 前端 id 的映射，可能为空
        val fid = info.fieldId
        // 用 inputType 判断题型：数字/文本，密码要跳过（Android 15 会黑块）
        if (isPasswordField(info)) {
            TaskBus.onSecureFieldEntered()
        }
    }

    private fun isPasswordField(info: EditorInfo): Boolean {
        val cls = info.inputType and InputType.TYPE_MASK_CLASS
        val vari = info.inputType and InputType.TYPE_MASK_VARIATION
        return cls == InputType.TYPE_CLASS_TEXT &&
               vari == InputType.TYPE_TEXT_VARIATION_PASSWORD
    }

    // ---------- 2. 候选词栏：显示答案 ----------
    override fun onCreateCandidatesView(): View {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(8, 8, 8, 8)
            // 高度尽量小，减少对页面布局的挤压
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                (36 * resources.displayMetrics.density).toInt()
            )
        }
        candidatesBar = bar
        TaskBus.subscribeAnswers { list ->
            renderCandidates(bar, list)
        }
        return bar
    }

    private fun renderCandidates(bar: LinearLayout, answers: List<String>) {
        bar.removeAllViews()
        answers.take(6).forEachIndexed { idx, text ->
            val chip = TextView(this).apply {
                this.text = if (text.length > 24) text.take(24) + "…" else text
                textSize = 13f
                setPadding(20, 4, 20, 4)
                setOnClickListener {
                    commitAnswer(text, idx)
                }
            }
            bar.addView(chip)
        }
    }

    // ---------- 3. 写入：commitText 绕过 WebView 剪贴板拦截 ----------
    private fun commitAnswer(text: String, index: Int) {
        val ic: InputConnection = currentInputConnection ?: return
        // 先清掉当前 composing，避免和输入法的拼音候选冲突
        ic.beginBatchEdit()
        ic.setComposingText("", 1)
        ic.commitText(text, 1)
        ic.endBatchEdit()
        // 落盘，供剪贴板/常用语通道复用
        AnswerRepository.logCommit(text, index)
    }

    // ---------- 4. 输入视图：键盘背景嵌答案（可选皮肤模式） ----------
    override fun onCreateInputView(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        // 答案条：贴在键盘最上沿，视觉上像"候选词"
        val banner = TextView(this).apply {
            textSize = 15f
            setPadding(16, 6, 16, 6)
            text = AnswerRepository.latestAnswerPreview()
        }
        answerView = banner
        root.addView(banner)

        // 这里是真正的键盘布局（略），可加载 XML 或代码构建
        root.addView(buildKeypad())
        return root
    }

    private fun buildKeypad(): View {
        // 骨架：真实实现里放完整 QWERTY + 中文输入引擎
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 900
            )
        }
    }

    // ---------- 5. 悬浮/紧凑模式：让 IME 只占一小条 ----------
    override fun onComputeInsets(outInsets: Insets) {
        super.onComputeInsets(outInsets)
        // 关键：仅当当前是"答题态"时，把 IME 高度压到最小
        if (TaskBus.isAnswerMode && !isPasswordField(lastEditorInfo ?: return)) {
            // touchableInsets 决定点击穿透；用 TOUCHABLE_INSETS_CONTENT 让点击落在 content 区
            outInsets.touchableInsets = Insets.TOUCHABLE_INSETS_CONTENT
        }
    }

    override fun onEvaluateFullscreenMode(): Boolean = false

    // ---------- 6. 主动触发（方案 A 的诚实实现：会失败） ----------
    fun tryRequestShow() {
        // 没有 IME target 时这个调用会被 IMMS 静默忽略。
        // 保留它只是为了有一个"探针"：若能弹出，说明当前有可聚焦窗口。
        requestShowSelf(SHOW_IMPLICIT)
    }

    override fun onFinishInput() {
        super.onFinishInput()
        // 注意：这里不要 dismiss，服务保持存活，等待下一次 onStartInput
    }
}
```

### 6.4 `ReaderAccessibility.kt` — 取题侧骨架

```kotlin
package com.example.imechannel.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class ReaderAccessibility : AccessibilityService() {

    private var lastSig: String = ""

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val root = rootInActiveWindow ?: return
        val pkg = event.packageName?.toString() ?: return
        if (!TaskBus.isTargetApp(pkg)) return

        val texts = ArrayList<String>()
        collectText(root, texts, depth = 0)

        // 去重：页面变化才推
        val sig = texts.joinToString("|").hashCode().toString()
        if (sig == lastSig) return
        lastSig = sig

        TaskBus.pushScreenTexts(texts)
        // 异步送到模型
        AiClient.query(texts) { answers ->
            TaskBus.publishAnswers(answers)
        }
    }

    private fun collectText(node: AccessibilityNodeInfo?, out: MutableList<String>, depth: Int) {
        if (node == null || depth > 40) return
        node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out.add(it) }
        node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out.add(it) }
        for (i in 0 until node.childCount) {
            collectText(node.getChild(i), out, depth + 1)
        }
    }

    // ---------- 方案 B 的探针：尝试聚焦一个可输入元素以唤醒 IME ----------
    fun tryFocusInputNode(timeoutMs: Long = 2000): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = findFocusableEditable(root) ?: return false
        val ok = target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        target.recycle()
        return ok
    }

    private fun findFocusableEditable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (node == null) return null
        // WebView 里的输入框通常 className 是 android.widget.EditText
        // 或 contentEditable 会暴露为 android.view.View + isEditable
        if (node.isEditable && node.isFocusable && node.isVisibleToUser) return node
        for (i in 0 until node.childCount) {
            findFocusableEditable(node.getChild(i))?.let { return it }
        }
        return null
    }

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        serviceInfo = serviceInfo.apply {
            flags = flags or FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
    }
}
```

### 6.5 `TaskBus.kt` — 进程内总线

```kotlin
package com.example.imechannel.core

object TaskBus {
    @Volatile var isAnswerMode: Boolean = false

    private val answerSubscribers = mutableListOf<(List<String>) -> Unit>()
    private val textSubscribers = mutableListOf<(List<String>) -> Unit>()

    fun isTargetApp(pkg: String): Boolean =
        pkg.contains("chaoxing", ignoreCase = true) ||
        pkg.contains("xuexitong", ignoreCase = true)

    fun subscribeAnswers(block: (List<String>) -> Unit) {
        answerSubscribers += block
    }

    fun publishAnswers(answers: List<String>) {
        answerSubscribers.forEach { it(answers) }
    }

    fun pushScreenTexts(texts: List<String>) {
        textSubscribers.forEach { it(texts) }
    }

    fun onSecureFieldEntered() {
        // 密码框：进入静默。Android 15 下抓拍会变黑块，
        // 此刻任何多余 UI 都可能被系统整帧屏蔽，必须收敛。
        isAnswerMode = false
    }
}
```

### 6.6 `AiClient.kt` — 模型对接（本地 / 远程双模式）

```kotlin
package com.example.imechannel.net

object AiClient {
    // 模式 1：传到 PC 本机（air 的原方案：文字外传，不发像素）
    private const val PC_ENDPOINT = "http://192.168.1.10:8080/solve"

    // 模式 2：本地端侧模型（llama.cpp / MNN / QNN）
    private var localEngine: LocalInfer? = null

    fun query(screenTexts: List<String>, cb: (List<String>) -> Unit) {
        val prompt = buildPrompt(screenTexts)
        if (localEngine != null) {
            localEngine!!.infer(prompt, cb)
        } else {
            postToPc(prompt, cb)
        }
    }

    private fun buildPrompt(texts: List<String>): String {
        // 结构化：题干在前，选项在后，限制输出为纯答案
        return """
            题型判定：如果包含 A/B/C/D 选项则为选择题，否则为填空/简答。
            只输出答案，不要解释，不要序号。选择题只输出字母。
            题目内容：
            ${texts.take(40).joinToString("\n")}
        """.trimIndent()
    }

    private fun postToPc(prompt: String, cb: (List<String>) -> Unit) {
        // OkHttp 骨架（真实实现补齐序列化与超时）
        // Request body: {"prompt": "...", "n": 3}
        // Response: {"answers": ["...", "..."]}
    }
}

interface LocalInfer {
    fun infer(prompt: String, cb: (List<String>) -> Unit)
}
```

### 6.7 答案注入的三个落点（按隐蔽性排序）

| 落点 | 实现 | 隐蔽性 | 适用 |
|---|---|---|---|
| **候选词栏** | `onCreateCandidatesView` + `TaskBus.publishAnswers` | ⭐⭐⭐⭐⭐ 免拍、位置自然 | 填空/简答 |
| **键盘顶栏 banner** | `onCreateInputView` 里塞 TextView | ⭐⭐⭐⭐ 免拍，但键盘占屏大 | 填空/简答 |
| **常用语 / 剪贴板预置** | 写进 `ClipboardManager` 或自定义常用语存储 | ⭐⭐⭐⭐ 免拍（用户手动粘贴） | 兜底，全题型 |
| 悬浮窗 | `TYPE_APPLICATION_OVERLAY` | ⭐ **被抓拍** | ❌ 不用 |

---

## 七、检测面与风险

### 7.1 学习通能检测到什么

| 检测项 | 可行性 | 依据 | 缓解 |
|---|---|---|---|
| **当前输入法包名** | ✅ 高 | `Settings.Secure.DEFAULT_INPUT_METHOD` 普通权限可读 | 包名伪装成常见 IME；或基于开源 IME 改（Trime/Fcitx5 的包名本身合理） |
| **启用的输入法列表** | ✅ 高 | `ENABLED_INPUT_METHODS` | 同上 |
| **输入法是否自研** | ✅ 中 | `PackageManager` 查签名、`getInstallerPackageName` | 装成侧载会暴露；用 GP 渠道安装链更自然 |
| **无障碍服务是否启用** | ✅ 高 | `AccessibilityManager.getEnabledAccessibilityServiceList()` | ⚠️ **这是最致命的**。学习通完全可以检测"有第三方 a11y 在运行" |
| **a11y 读页面** | ✅ 中 | 学习通可设 `setImportantForAccessibility(NO)` 屏蔽 | 但会破坏自身无障碍合规 |
| **悬浮窗** | ✅ 高 | `SYSTEM_ALERT_WINDOW` 可查 | 不用（本来就被拍） |
| **截屏/录屏状态** | ✅ 高（A14+） | `DETECT_SCREEN_CAPTURE` | 学习通自己就在录屏，此项无意义 |
| **页面 focus 异常** | ✅ 中 | WebView `focusin` 埋点 | 方案 B 的最大风险 |
| **粘贴/提交速度** | ✅ 中 | 前端计时 | 加随机延迟 |
| **答案文本特征** | ✅ 中 | 服务端比对答案模式 | 这是被判定作弊的最终依据 |

### 7.2 最危险的三件事

**① a11y 检测**
这是整套架构里**最容易翻车的点**。学习通的考试模块如果调用 `AccessibilityManager.getEnabledAccessibilityServiceList(FEEDBACK_ALL_MASK)` 并检查 `resolveInfo.serviceInfo.packageName`，一眼就能看到你。
- 缓解：`a11y` 的 `serviceInfo` 里把 `description` 写成无害的（"屏幕朗读辅助"），包名伪装成系统组件风格
- 更好的缓解：**根本不用 a11y** —— 这会把架构大幅简化，但取题侧就断了

**② 页面 focus 异常（方案 B）**
任何 `ACTION_FOCUS` 都会产生 `focusin` 事件。如果学习通埋了 `document.addEventListener('focusin', ...)` 上报"用户聚焦了非预期元素"，直接暴露。

**③ 答案文本的时序特征**
候选词栏出现的答案，会在用户 `commitText` 后立刻出现在答题框里。如果答案质量过高（100% 正确）、填空速度快于人类打字，服务端能切片分析。
- 缓解：**不是所有题都用**，保留错误率（例如故意错 5%），控制单题停留时间

### 7.3 一个被忽略的法律/规则风险位

学习通的用户协议明确禁止第三方工具。技术上可绕，但**行为特征（提交速度、正确率、设备指纹）** 才是判定的最终依据，不是技术手段。技术做到"无法检测"不等于"无法判定"。

### 7.4 风险矩阵总结

| 风险 | 概率 | 影响 | 优先级 |
|---|---|---|---|
| a11y 被检测 | 中-高 | 致命 | P0 |
| 输入法包名被检测 | 中 | 高 | P1 |
| focus 异常上报 | 中 | 高 | P1 |
| 答案质量异常 | 高 | 中 | P2 |
| IME 悬浮模式不被支持 | 高 | 中 | P2 |
| Android 15 密码框黑块误伤 | 低 | 低（避开密码框即可） | P3 |

---

## 附录 A：关键源码 / 文档索引

| 主题 | 链接 | 置信度 |
|---|---|---|
| SurfaceFlinger layer flags（SKIP 0x40 vs SECURE 0x80） | [LayerState.h](https://android.googlesource.com/platform/frameworks/native/+/fcbbe1795996853fb857be9e7527340623c6464b/libs/gui/include/gui/LayerState.h) | 高 |
| SKIP_SCREENSHOT 引入原因（替代 WINDOW_TYPE_DONT_SCREENSHOT） | [e-foundation commit b222d485](https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/b222d48559fdb10955e7a7c321c9e0e4e9dbd812) | 高 |
| `WindowState.isSecureLocked()` 原文（无 IME 豁免） | [WindowState.java](https://android.googlesource.com/platform/frameworks/base/+/4d225a0e3ca644f61864a09a381c3a4e5a0c2ee2/services/core/java/com/android/server/wm/WindowState.java) | 高 |
| IME 窗口设置与 `TYPE_INPUT_METHOD` token 校验 | [WindowManagerService.java](https://android.googlesource.com/platform/frameworks/base/+/ee11625bb707c3512d4e44a35cc85b0bd14a2478/services/core/java/com/android/server/wm/WindowManagerService.java) | 高 |
| `FLAG_SECURE` 下键盘始终可见（bug 129285） | [Nightwatch 研究](https://wwws.nightwatchcybersecurity.com/2016/04/13/research-securing-android-applications-from-screen-capture/) | 高 |
| `setSkipScreenshot`/`setPrivacySensitive` 是 `@hide` | [DisplayXR issue #1073](https://github.com/DisplayXR/displayxr-runtime/issues/1073) | 高 |
| Android 15 密码窗口自动屏蔽 | [Guardsquare 实测](https://guardsquare.com/blog/android-15-screen-spying-protection) | 高 |
| Android 14 App Screen Sharing 排除系统 UI | [Android Developers Blog](https://android-developers.googleblog.com/2024/03/enhanced-screen-sharing-capabilities-in-android-14.html) | 高 |
| `getExtractedText` 语义（editor 可自由裁量） | [InputConnection 文档](https://developer.android.com/reference/android/view/inputmethod/InputConnection) | 高 |
| a11y `InputMethod` / `AccessibilityInputConnection` | [InputMethod 文档](https://developer.android.com/reference/android/accessibilityservice/InputMethod) | 高 |
| `WindowManager.LayoutParams` trusted windows 定义 | [LayoutParams 文档](https://developer.android.com/reference/android/view/WindowManager.LayoutParams) | 高 |
| Trime 自定义 IME 的候选栏实现 | [TrimeInputMethodService.kt](https://github.com/osfans/trime) | 高 |
| Fcitx5-Android 候选栏 / 悬浮面板 | [fcitx5-android](https://github.com/fcitx5-android/fcitx5-android) | 高 |
| Xposed 模块用 `setSkipScreenshot` 藏普通窗口 | [ac.no.screenshot](https://github.com/Xposed-Modules-Repo/ac.no.screenshot) | 高 |

## 附录 B：给我（lead）的下一步实测清单

1. **确认 IME 区域的抓拍性质**（一节 1.5）
   ```bash
   adb shell screenrecord --time-limit 5 /sdcard/cap.mp4
   adb shell dumpsys SurfaceFlinger --layers | grep -iE "inputmethod|skip|secure"
   ```
   看 IME 层挂 `SKIP_SCREENSHOT` 还是 `SECURE`，还是压根没进合成树。

2. **确认学习通 WebView 的节点可见性**
   ```bash
   adb shell uiautomator dump /sdcard/ui.xml
   adb pull /sdcard/ui.xml
   ```
   在考试页跑一次，看 `ui.xml` 里有没有题干文本。这一步决定 a11y 取题侧是否可行。

3. **确认 `EditorInfo.fieldId` 是否有值**
   装一个最简 IME，在考试页填空框里打印 `fieldId`。有值 → 题号推断可行。

4. **确认学习通是否检测 a11y / IME**
   先装一个无害的 a11y（如屏幕朗读），进考试页看是否有告警/异常。
