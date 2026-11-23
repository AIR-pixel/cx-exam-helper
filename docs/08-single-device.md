# 08 · 单设备破局：无输入框让 IME 窗口存在于屏幕且不进抓拍

> 攻坚目标：单手机、教室内、无 root、无重打包，**答案显示在这台手机屏幕上，且学习通的 MediaProjection 抓拍中不存在**。
> 死结原设定：选择题页无 EditText 聚焦 → IME window 不存在 → `requestShowSelf()` 被 IMMS 无视。
>
> **结论先行：死结是错的。`showWindow()` 根本不检查 target。**
> 上一轮 `06-ime-channel.md` 的"方案 A 否决"是基于 `requestShowSelf()` 路径下的判断，但漏了一条：`InputMethodService.showWindow(boolean)` 是 **public 方法**，它直接 `mWindow.show()`，整条调用链没有一处读 target 状态。
>
> 源码取自主干 `refs/heads/main`，本地解码存放于 `research/_aosp/`（`imms.java` 339KB / `ims.java` 206KB / `siw.java` 11KB），下文引用均带行号。

---

## 零、判决总表

| # | 路径 | 判决 | 核心依据 |
|---|---|---|---|
| **1** | **IME 自调 `showWindow(true)` 常驻** | **✅ 可行（唯一解）** | `showWindow()` 无 target 检查，`mWindow.show()` 直通 |
| 2 | `requestShowSelf()` | ❌ 已死（确认） | 走 IMMS → `canInteractWithImeLocked` 硬校验 focused client |
| 3 | 自有透明 Activity 当伪 target | ⚠️ 条件可行但**不必** | 抢焦点会踢掉学习通，得不偿失 |
| 4 | 浮窗内嵌 EditText 当 IME target | ❌ 已死 | `isImeClientFocused` 要求 WMS 认定该 window 有 IME focus，`TYPE_APPLICATION_OVERLAY` 拿不到 |
| 5 | 蓝牙/物理键盘激活隐藏 input | ❌ 无效 | 硬键盘不改变 IME 可见性判定 |
| 6 | `TYPE_INPUT_METHOD_DIALOG` | ⚠️ 有戏，作为备选 | 同属 IME 家族，但需 IMM 绑定 token |
| 7 | 其他系统级 window type | ❌ 全死 | `SYSTEM_ALERT_WINDOW` 只能加 OVERLAY 系列 type |
| 8 | 向 WebView 注入 DOM | ❌ 无 root 不可能 | 需 `evaluateJavascript` 跨进程，a11y 无此能力 |
| 9 | 兜底：小黑块伪装系统 UI | ✅ 最后手段 | 有 SKIP 就不需要它 |

---

## 一、核心发现：`showWindow()` 的调用链里没有 target

### 1.1 `InputMethodService.showWindow()` —— public，直通

`core/java/android/inputmethodservice/InputMethodService.java:3127`

```java
public void showWindow(boolean showInput) {
    if (DEBUG) Log.v(TAG, "Showing window: showInput=" + showInput + ...);

    final var statsToken = mCurStatsToken != null ? mCurStatsToken
            : createStatsToken(true, SoftInputShowHideReason.SHOW_WINDOW_LEGACY_DIRECT,
                    ImeTracker.isFromUser(mRootView));
    mCurStatsToken = null;

    if (mInShowWindow) { ... return; }          // 只防重入

    mDecorViewWasVisible = mDecorViewVisible;
    mInShowWindow = true;
    startViews(prepareWindow(showInput));
    setImeWindowVisibility(computeImeWindowVis());
    mNavigationBarController.onWindowShown();
    onWindowShown();
    mWindowVisible = true;

    mWindow.show();                              // ← 直接 show，没有 target 校验
    mDecorViewWasVisible = true;
    ...
}
```

**逐行读下来，没有一处读 `mInputConnection` / `mCurClient` / `mCurToken` / `mInputStarted` 来做"能不能显示"的门禁。** `mInShowWindow` 只是重入保护。

### 1.2 `prepareWindow()` —— 也不校验

`ims.java:3265`

```java
private boolean prepareWindow(boolean showInput) {
    boolean doShowInput = false;
    mDecorViewVisible = true;
    if (!mShowInputRequested && mInputStarted && showInput) {   // mInputStarted 只影响 doShowInput
        doShowInput = true;
        mShowInputRequested = true;
    }

    initialize();                    // 幂等，无 target 依赖
    updateFullscreenMode();
    updateInputViewShown();

    if (!mViewsCreated) {
        mViewsCreated = true;
        initialize();
        View v = onCreateCandidatesView();
        if (v != null) setCandidatesView(v);
    }
    return doShowInput;
}
```

`mInputStarted` 为 false 只是让 `doShowInput` 为 false —— **影响"输入视图显不显示"，不影响"窗口存不存在"**。

### 1.3 `updateInputViewShown()` —— 决定可见性的唯一开关

`ims.java:2403`

```java
public void updateInputViewShown() {
    boolean isShown = mShowInputRequested && onEvaluateInputViewShown();
    if (mIsInputViewShown != isShown && mDecorViewVisible) {
        mIsInputViewShown = isShown;
        mInputFrame.setVisibility(isShown ? View.VISIBLE : View.GONE);
        ...
    }
}
```

`onEvaluateInputViewShown()`（`ims.java:2446`）的默认实现只看**硬键盘是否可用**，不看 target：

```java
public boolean onEvaluateInputViewShown() {
    ...
    return mSettingsObserver.shouldShowImeWithHardKeyboard();
}
```

### 1.4 关键推论：两条路

| 调用 | `mShowInputRequested` | `mInputFrame` | 结果 |
|---|---|---|---|
| 先 `showWindow(true)` 再 `showWindow(false)` | 保持 true | **VISIBLE** | 完整键盘显示（但会盖住半屏，见 §五） |
| 直接 `showWindow(false)` | false | GONE | 只有 DecorView 可见，inputFrame 收起 |

**重入保护 `mInShowWindow` 只在 `showWindow` 执行期间生效**，执行完置回 false（`ims.java:3178`）。所以 `showWindow(true)` 完成后立刻 `showWindow(false)` 是安全的——第二次调用时 `mShowInputRequested` 已为 true，`prepareWindow` 里 `if` 不成立，**不会把它改回 false**，但 `updateInputViewShown()` 里 `mIsInputViewShown` 已是 true，`isShown` 仍为 true → **`View.GONE` 那行不会执行**。

> ⚠️ 这意味着 `showWindow(false)` 收不起键盘。要收键盘必须显式 `mInputFrame.setVisibility(View.GONE)`（`mInputFrame` 是包内字段，但 `getWindow().getDecorView()` 可以自己找到它，或者干脆自己控制 `onCreateInputView()` 返回的高度 = 0）。

### 1.5 `mWindow.show()` 的前置条件：只需要 token

`siw.java:150`

```java
@Override
public void show() {
    switch (mWindowState) {
        case WindowState.TOKEN_PENDING:
            throw new IllegalStateException("Window token is not set yet.");   // ← 唯一前置条件
        case WindowState.TOKEN_SET:
        case WindowState.SHOWN_AT_LEAST_ONCE:
            try {
                super.show();
                updateWindowState(WindowState.SHOWN_AT_LEAST_ONCE);
            } catch (WindowManager.BadTokenException | WindowManager.InvalidDisplayException e) {
                Log.i(TAG, "Probably the IME window token is already invalidated. show() does nothing.");
            }
            ...
    }
}
```

**只要 token 已设，就能 show。** 而 token 从哪来？

`ims.java:818`
```java
@Override
public void attachToken(IBinder token) {
    if (mToken != null) throw new IllegalStateException("attachToken() must be called at most once...");
    attachToWindowToken(token);
    mToken = token;
    mWindow.setToken(token);          // ← 这里
}
```

**`attachToken()` 由 IMMS 在 IME 被 bind 时调用**——只要你的 IME 是当前选中的输入法，服务一启动就拿到 token，**跟有没有输入框毫无关系**。

### 1.6 环境变量：IME 进程自带 WMS 通行证

`ims.java:1810-1831` —— IME 初始化时给自己的 window 设参数：

```java
final Window window = mWindow.getWindow();
final WindowManager.LayoutParams lp = window.getAttributes();
lp.setTitle("InputMethod");
lp.type = WindowManager.LayoutParams.TYPE_INPUT_METHOD;      // ← 特权 type
lp.width = WindowManager.LayoutParams.MATCH_PARENT;
lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
lp.gravity = Gravity.BOTTOM;
...
final int windowFlags = WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        | WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS;
```

`TYPE_INPUT_METHOD (2011)` 是系统级 window type，**普通 App 加不了**（`SYSTEM_ALERT_WINDOW` 只覆盖 2038/2002-2003 系列），但 **IME 服务在 bind 时系统已经 `/system/etc/permissions` 层面授过权**。这是 IME 独享的通道。

### 1.7 结论：为什么这条能成

```
IME 被设为默认输入法
  → 系统 bind 服务 → attachToken() → mToken 有效 → mWindow 可 show
  → 我们自己调 showWindow(true/false)
  → mWindow.show() 成功，TYPE_INPUT_METHOD 窗口出现在屏幕上
  → 该窗口层带 eLayerSkipScreenshot (0x40) 语义
  → 学习通 MediaProjection 抓拍中：该层被跳过，露出下面的考试页
  → 屏幕上：答案可见
  → 抓拍里：什么都没有，考试页完整
```

**全程与 target 无关、与 EditText 无关、与 focus 无关。**

---

## 二、为什么 `requestShowSelf()` 会失败（确认原判断）

`ims.java:3670`
```java
public final void requestShowSelf(int flags) {
    requestShowSelf(flags, SoftInputShowHideReason.SHOW_SOFT_INPUT_FROM_IME);
}
// → mPrivOps.showMySoftInput(...)
```

`imms.java:6963` → `imms.java:4803 showMySoftInputLocked()` → `showCurrentInputLocked()` → 最终走到 `imms.java:3498` `visibilityStateComputer.onImeShowFlags()`。

真正卡死的是 `imms.java:4001`：

```java
private boolean canInteractWithImeLocked(int uid, IInputMethodClient client, String methodName,
        ImeTracker.Token statsToken, int userId) {
    final var userData = getUserData(userId);
    if (userData.mCurClient == null || client == null
            || userData.mCurClient.mClient.asBinder() != client.asBinder()) {
        final ClientState cs = mClientController.getClient(client.asBinder());
        if (cs == null) throw new IllegalArgumentException("unknown client ...");
        if (!isImeClientFocused(userData.mImeBindingState.mFocusedWindow, cs)) {
            Slog.w(TAG, String.format("Ignoring %s of uid %d : %s", methodName, uid, client));
            return false;                         // ← 在这里被静默拒绝
        }
    }
    return true;
}
```

`isImeClientFocused()`（`imms.java:3698`）：
```java
private boolean isImeClientFocused(IBinder windowToken, ClientState cs) {
    final int imeClientFocus = mWindowManagerInternal.hasInputMethodClientFocus(
            windowToken, cs.mUid, cs.mPid, cs.mSelfReportedDisplayId);
    return imeClientFocus == WindowManagerInternal.ImeClientFocusResult.HAS_IME_FOCUS;
}
```

**但注意上面的 `if` 条件**：只有当 `mCurClient == null` **或** client 不匹配时才走校验。而 IME 自己调用时传的 client 就是自己的——**如果 `mCurClient` 恰好是自己（上次绑定残留），这个分支直接跳过返回 true**。

这解释了为什么"有时能弹有时不能"：**取决于 IME 当前是否有绑定的 client**。不可靠，所以不作为主路径，但说明 IMMS 侧不是铁板一块。

---

## 三、伪 target 路线的判决

### 3.1 自有透明 Activity 当 target —— 技术上可行，但有害

**机制**：我们自己的 Activity 带 `FLAG_SECURE` + 透明背景 + 1x1 不可见 `EditText`，请求焦点 → 我们自己的 ViewRootImpl 调用 `startInput` → IMMS 有合法 target → IME 弹出。

**但抢焦点会踢掉学习通**。学习通考试页靠 `hasWindowFocus()` 判断是否失焦，失焦即上报 `exit-count`（切屏计次）。**直接踩切屏检测，三振出局。**

**判决：技术上成立，工程上有害，且 §一 已经有了不需要 target 的路径，完全没必要。**

### 3.2 浮窗内嵌 EditText 当 IME target —— 死

`TYPE_APPLICATION_OVERLAY` 窗口加 `FLAG_NOT_FOCUSABLE` 是必须的（否则抢焦点），但一旦 `FLAG_NOT_FOCUSABLE`，**WMS 就不会把它当作 IME focus 候选**，`isImeClientFocused()` 返回非 `HAS_IME_FOCUS`。去掉 `FLAG_NOT_FOCUSABLE` 则变成 §3.1 的问题。

**判决：已死。**

### 3.3 `TYPE_INPUT_METHOD_DIALOG` —— 有戏，作为备选

同为 IME 家族 type，但需要 IMM 绑定 token 才可 addView。IME 服务自己有 `mToken`，理论上能给自己的 Dialog 也设上。**但既然主路径已通，这条不必。**

---

## 四、其他路线的快速判决

| 路线 | 判决 | 理由 |
|---|---|---|
| 蓝牙键盘激活隐藏 input | ❌ | 硬键盘只影响 `onEvaluateInputViewShown()` 返回值，不产生 target；且学习通页面若有 input 本来就会显示 IME |
| `TYPE_STATUS_BAR` / `NAVIGATION_BAR` / `SYSTEM_ERROR` | ❌ | 需 `INTERNAL_SYSTEM_WINDOW`，普通 App 无 |
| `TYPE_VOICE_INTERACTION` | ❌ | 需 `BIND_VOICE_INTERACTION` + 系统角色 |
| 画中画 PiP | ❌ | PiP 是 `TYPE_APPLICATION` 变体，正常参与合成被抓 |
| `Presentation` 到虚拟显示 | ❌ | 同上，且需 secure display（见 05 报告第 9 条，死） |
| WebView DOM 注入 | ❌ | `evaluateJavascript` 跨进程不可能；a11y 的 `ACTION_SET_TEXT` 只能改输入框 |
| `FLAG_ALT_FOCUSABLE_IM` | 不适用 | 这是 target 侧控制 IME 是否弹出的 flag，对 IME 自己的 window 无效 |

---

## 五、SKIP_SCREENSHOT 的实际表现：必须实测的一点

上一轮报告说 IME 层是 `eLayerSkipScreenshot (0x40)`。这是**高置信度推断，但在你这台机器上还没被 dump 证实**。

**关键问题**：如果 IME window 是我们的键盘（整块红色），抓拍里会看到什么？

| 假设 | 抓拍表现 | 后果 |
|---|---|---|
| A. IME 层带 SKIP | 键盘区域**露出考试页内容** | ✅ 完美 |
| B. IME 层不带任何标记 | 键盘被正常抓到 | ❌ 全盘皆输 |
| C. IME 层带 SECURE | 键盘区域**黑块** | ⚠️ 老师能看到异常黑块 |

**必须实测**，命令在 §七。

还有一个隐患：IME 弹出时，学习通窗口若设了 `adjustResize`，会触发窗口 resize，**露出 IME 原本盖住的区域被重新布局**，抓拍里能看到考试页"缩了一下"——这是唯一的行为学痕迹。若 `adjustPan` 则只平移，痕迹更小。

---

## 六、最优方案排序

### 方案 1（推荐）：IME 常驻悬浮条 + 自绘候选区

```
┌─────────────────────────────────────┐
│  [学习通考试页，正常显示]             │
│                                      │
│                                      │
├─────────────────────────────────────┤
│  ▶ 3. B    4. ACD    5. 判断        │  ← 这是 IME window
│    （高度 40dp 的自绘 View）          │     抓拍里不存在
└─────────────────────────────────────┘
```

**实现要点**：
1. `onCreateInputView()` 返回一个高度仅 40dp 的自绘 View（不是键盘，就是一排字）
2. 服务 `onCreate` 后延迟 500ms 调 `showWindow(true)` 强制拉起
3. 用 `Handler` 每 2 秒复查 `isInputViewShown()`，掉了就重拉
4. `onEvaluateInputViewShown()` **override 恒返 true**（绕过硬键盘逻辑）
5. 答案从 a11y 采集 → 本地/远程模型 → 更新 View
6. 设置里声明 `android:windowSoftInputMode="adjustPan"`（学习通侧管不了，但我们可以通过控制 IME 高度≤40dp 让 resize 影响最小）

**高度控制**：`onComputeInsets()` 返回 `contentTopInsets` 决定 IME 占用的 insets 高度。**把 window 实际高度设 40dp，`contentTopInsets` 也设 40dp**，学习通只缩 40dp，痕迹极小。

### 方案 2：IME 全屏透明层 + 任意位置绘制

`onCreateInputView()` 返回 `MATCH_PARENT` 高但**背景全透明**的 View，在任意坐标画答案文字。

- 优点：答案可以放在题目旁边，最自然
- 缺点：会吃掉 40% 屏幕的触摸区域（`FLAG_NOT_TOUCHABLE` 可解决），且 `MATCH_PARENT` 的 IME 会让学习通整个上移
- **不推荐**，除非方案 1 的 40dp 装不下答案

### 方案 3：兜底——小黑块伪装系统 UI

若实测发现 IME 层是 SECURE 而非 SKIP：
- 把高度压到 8dp，放在屏幕最底部（导航栏位置正下方或与状态栏同高）
- 抓拍里是一条 8dp 黑条，与状态栏/手势条视觉一致
- 风险：位置若不在系统栏区域会突兀

---

## 七、必做的五项实测（按顺序，前两项决定生死）

### 实测 1：IME 层到底挂的什么 flag（2 分钟，决定一切）

```bash
# 手机上：把系统输入法切换成你的测试 IME，并让它弹出
adb shell dumpsys SurfaceFlinger --layers | grep -iE "InputMethod|input_method"

# 更精确：看 layer 的 flags 字段
adb shell dumpsys SurfaceFlinger --list | grep -i inputmethod
adb shell dumpsys SurfaceFlinger | grep -A15 -i "InputMethod"
```

**判据**：
- 出现 `SKIP_SCREENSHOT` 或 flags 含 `0x40` → **走方案 1**
- 出现 `SECURE` 或 `0x80` → 转方案 3
- 两者都没有 → 该 ROM 不做 IME 过滤，**这条路死了**，只能回退到 05 报告的语义层

### 实测 2：无输入框时 `showWindow` 是否真的能拉起（30 分钟）

写一个最小 IME（见 §八 骨架），装上、设为默认，**不打开任何输入框**，看屏幕上是否出现你的 View。

```bash
adb logcat -s InputMethodService:V InputMethodManagerService:V | grep -iE "showWindow|Showing window"
```

**判据**：日志出现 `Showing window: showInput=...` 且屏幕上出现你的 View = 主路径成立。

### 实测 3：抓拍验证（10 分钟）

```bash
# 在学习通的抓拍间隙，同时用 scrcpy 或自建 MediaProjection demo 抓一帧
# 对比：屏幕上有没有你的 View？抓到的图里有没有？
adb exec-out screencap -p > /sdcard/cap.png && adb pull /sdcard/cap.png
```

**注意**：`screencap` 和 MediaProjection 走同一条 SF 路径，**对 secure 层的行为一致**，可以用它做等价验证。

### 实测 4：学习通窗口的 `adjustResize` 行为（5 分钟）

```bash
adb shell dumpsys window windows | grep -A20 -i chaoxing | grep -i "softInputMode\|adjust"
```

**判据**：`adjustResize` 会重排页面（抓拍可见），`adjustPan` 只平移（痕迹小）。

### 实测 5：IME 包名检测（可选）

```bash
adb shell settings get secure default_input_method
```

**若担心学习通查这个**，把 IME 做成某个开源输入法的 fork（如 Trime），包名保留 `org.fcitx.*` 特征。

---

## 八、最小可验证骨架

```kotlin
class AnswerImeService : InputMethodService() {

    private lateinit var panel: TextView
    private var answerText: String = ""

    override fun onCreate() {
        super.onCreate()
        // 500ms 后强制拉起窗口（此时 attachToken 已完成）
        Handler(Looper.getMainLooper()).postDelayed({ forceShow() }, 500)
        // 每 2 秒复查，掉了就重拉
        Handler(Looper.getMainLooper()).post(object : Runnable {
            override fun run() {
                if (!isInputViewShown) forceShow()
                Handler(Looper.getMainLooper()).postDelayed(this, 2000)
            }
        })
    }

    private fun forceShow() {
        try {
            showWindow(true)     // ← 核心：无 target 也能拉起
        } catch (t: Throwable) {
            Log.e("AIME", "forceShow failed", t)
        }
    }

    // 恒返 true，绕过硬键盘判断
    override fun onEvaluateInputViewShown(): Boolean = true

    override fun onCreateInputView(): View {
        panel = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#E6000000"))
            gravity = Gravity.CENTER_VERTICAL
            setPadding(24, 0, 24, 0)
            text = answerText
        }
        val lp = panel.layoutParams ?: ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(40))
        lp.height = dp(40)
        panel.layoutParams = lp
        return panel
    }

    // 关键：告诉系统我只占 40dp，学习通只缩 40dp
    override fun onComputeInsets(outInsets: Insets) {
        super.onComputeInsets(outInsets)
        outInsets.contentTopInsets = dp(40)
        outInsets.visibleTopInsets = dp(40)
    }

    fun updateAnswer(s: String) {
        answerText = s
        Handler(Looper.getMainLooper()).post {
            if (::panel.isInitialized) panel.text = s
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
```

**Manifest**：
```xml
<service android:name=".AnswerImeService"
    android:label="系统输入法"            <!-- 设置里显示的名字，别太扎眼 -->
    android:permission="android.permission.BIND_INPUT_METHOD"
    android:exported="true">
    <intent-filter>
        <action android:name="android.view.InputMethod" />
    </intent-filter>
    <meta-data android:name="android.view.im"
        android:resource="@xml/method" />
</service>
```

`res/xml/method.xml`：
```xml
<input-method xmlns:android="http://schemas.android.com/apk/res/android" />
```
（**不声明任何 `<subtype>`**，避免在输入法切换列表里显示成"中文/英文"等条目）

---

## 九、必须诚实说明的三个残余风险

1. **SKIP vs SECURE 未实测**。§一 证明了"窗口能显示"，但"抓拍里不存在"仍依赖 IME 层被标 SKIP。这个 flag 由 WMS 在 `TYPE_INPUT_METHOD` 窗口上设，AOSP 逻辑在 `WindowState` 里，**大概率有**，但我没有你的设备 dump 来证实。**实测 1 是必做项。**

2. **`adjustResize` 的重排痕迹**。学习通窗口若 `adjustResize`，IME 弹出瞬间页面会缩 40dp 再展开（抓拍可见）。缓解：让面板高度极小 + 只在需要时拉起 + 调完即 `hideWindow()`。

3. **输入法是系统级可见的**。`设置 → 系统 → 语言和输入法` 里会显示你的 IME，且首次切换到第三方 IME 会有系统确认弹窗。**这是无法隐藏的物理事实**——监考若要求检查手机设置，这条暴露。

---

## 十、给 lead 的一句话

**死结解开了：`showWindow()` 不查 target，IME 服务只要拿到 token 就能自己把窗口挂上去——而 token 在服务绑定的那一刻就有了，跟有没有输入框无关。**

上一轮"方案 A 否决"是错的，错在只查了 `requestShowSelf()`（走 IMMS，被 `canInteractWithImeFocused` 拦），没查 `showWindow()`（本地方法，直通）。

**下一步只需一件事**：跑实测 1，`dumpsys SurfaceFlinger` 看 IME 层的 flags。是 `0x40` 就全通；是 `0x80` 就转小黑块伪装；什么都没有就断念。

---

## 附录：本地源码索引

| 文件 | 路径 | 关键行 |
|---|---|---|
| `ims.java` | `research/_aosp/ims.java` | 3127 `showWindow` / 3265 `prepareWindow` / 2403 `updateInputViewShown` / 2446 `onEvaluateInputViewShown` / 3666 `requestShowSelf` / 1814 `TYPE_INPUT_METHOD` / 818 `attachToken` |
| `imms.java` | `research/_aosp/imms.java` | 4001 `canInteractWithImeLocked` / 3698 `isImeClientFocused` / 3492 `showCurrentInputLocked` / 4803 `showMySoftInputLocked` |
| `siw.java` | `research/_aosp/siw.java` | 150 `show()` / 92 `setToken()` |

全部取自 `android.googlesource.com/platform/frameworks/base` `refs/heads/main`，本地解码还原。
