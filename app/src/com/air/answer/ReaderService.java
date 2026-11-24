package com.air.mpprobe;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * ReaderService v2 —— 读 WebView 节点树 → PC /answer → 叠层显示。
 *
 * v1 的问题（doc 13 遗留项 5）：
 *   · 用 `resp.indexOf("\"answer\"")` 抓裸字符串，拿不到 source/type/screenHash
 *   · 叠层是独立 Activity，被后启动的应用盖掉，实际不可用
 *
 * v2：
 *   1. 真 JSON 解析，消费 {answer, source, type, question, screenHash, ms}
 *   2. 叠层搬进本服务，走 TYPE_ACCESSIBILITY_OVERLAY（2032）压在所有应用之上
 *   3. screenHash 去重，翻页才重渲染
 *   4. 读题跳过 invisible 节点，减少 display:none 的噪声
 *   5. 错误分型上色：网络错 / source=error / 空答案
 */
public class ReaderService extends AccessibilityService {
    private static final String TAG = "AnsReader";
    private static final int DEBOUNCE_MS = 250;
    private static final int MIN_TEXT_LEN = 6;
    private static final int MAX_ATTEMPTS = 6;
    private static final int RETRY_STEP_MS = 400;

    // 音量键双击开关
    private static final long DOUBLE_TAP_MS = 500;   // 两次短按间隔上限
    private static final long TAP_COOLDOWN_MS = 600; // 触发后静默，防连发
    private long lastVolUpDownAt = 0;
    private long lastVolDownDownAt = 0;
    private long lastToggleAt = 0;

    /**
     * 答题页专属界面元素。只出现在考试/作业答题页，
     * 登录页、首页、课程列表、消息页、个人中心都没有。
     * 用来把 OCR 兜底限制在真正的答题页上。
     */
    private static final java.util.regex.Pattern EXAM_CHROME = java.util.regex.Pattern.compile(
            "交卷|答题卡|上一题|下一题|剩余时间|倒计时|提交试卷|保存\\s*提交|共\\s*\\d+\\s*题");

    /**
     * 题干标记：行首题号（"5." "第5题"）或行内分值（"（5分）"）。
     * 带这两种标记的行一定是题干，哪怕字数不到 8 也收 —— 用长度门槛会把
     * "5.（5分）简述为什么…"（12 字）之外的短题干误杀。
     */
    private static final java.util.regex.Pattern STEM_MARK = java.util.regex.Pattern.compile(
            "^\\s*(?:第\\s*\\d{1,3}\\s*题|\\d{1,3}\\s*[.、．)）])|[(（]\\s*\\d+(?:\\.\\d+)?\\s*分\\s*[)）]");

    private final Handler h = new Handler(Looper.getMainLooper());
    private Runnable pending;
    private String lastScreenHash = "";
    private volatile boolean inFlight = false;
    /** 上一次打日志时的整屏文本，用来压掉滚动/倒计时造成的重复日志 */
    private String lastLoggedText = "";
    /** 扫描链代次：每次 scheduleScan 递增，旧链的下一跳发现代数变了就退出 */
    private int scanGen = 0;
    /** 请求在飞时被丢弃的扫描请求；请求结束后补跑，避免慢响应吞掉下一题 */
    private volatile boolean deferredScan = false;
    /** 周期性兜底扫描（图片题不产生 a11y 事件，只能靠轮询） */
    private boolean pollRunning = false;
    private Runnable pollTick;
    /** 轮询间隔：够短能跟上翻页，够长不烧电 */
    private static final long POLL_MS = 2500;
    /** 上一次做 OCR 时的 a11y 文本，用于同一屏去重（避免反复 hide/show 闪屏） */
    private String lastOcrA11yText = "";

    private AnswerOverlay overlay;
    private Bus.Listener busListener;

    @Override public void onServiceConnected() {
        super.onServiceConnected();
        Log.d(TAG, "connected");

        // 必须显式声明接收按键事件：a11y_config XML 里写 flagRequestFilterKeyEvents
        // 在部分 aapt2 版本上编不进去（实测 capabilities 仍为 1），代码里再补一刀。
        android.accessibilityservice.AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.flags |= android.accessibilityservice.AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS;
            setServiceInfo(info);
            Log.d(TAG, "key filter flags=" + info.flags);
        }

        ToggleStore.init(this);
        ConfigStore.init(this);
        overlay = new AnswerOverlay(this);
        busListener = new Bus.Listener() {
            public void onUpdate(Bus.Msg m) {
                // 浮层开关关着时只更新 Bus（配置页还能看），不画浮层
                if (overlay != null && ToggleStore.overlayOn() && ToggleStore.appOn()) overlay.render(m);
            }
            public void onStatus(String text, String kind) {
                // 开关切换（来自音量键/Xposed 广播）时同步浮层显隐
                if ("toggle".equals(kind) && overlay != null) {
                    if (ToggleStore.appOn() && ToggleStore.overlayOn()) overlay.show();
                    else overlay.hide();
                }
                if (overlay != null && ToggleStore.overlayOn() && ToggleStore.appOn()) overlay.status(text, kind);
            }
        };
        Bus.setListener(busListener);
        if (ToggleStore.appOn() && ToggleStore.overlayOn()) overlay.show();
        Bus.publishStatus("a11y 已连接 · Vol+×2 弹窗 / Vol-×2 总开关", "ready");
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null) return;
        // 总开关关着时，整条读题链路停摆
        if (!ToggleStore.appOn()) return;
        int t = e.getEventType();
        if (t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && t != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) return;
        scheduleScan();
        // 考试页启动周期兜底扫描：图片题换页不产生任何 a11y 文本变化事件，
        // 只靠事件驱动会彻底静默（实测从简答题翻到图片题，日志一条都没有）。
        if (!pollRunning && isExamPage(readAllWindows())) startPoll();
    }

    /**
     * 音量键双击开关（替代 root daemon 方案：a11y 直接收按键，零额外进程）。
     *   Vol+ 双击 → 切浮层显隐（读题/作答继续）
     *   Vol- 双击 → 切总开关（读题/浮层全停）
     * 单击不拦截，正常调音量；双击窗口 500ms，触发后静默 600ms。
     */
    @Override public boolean onKeyEvent(android.view.KeyEvent e) {
        if (e == null) return false;
        int code = e.getKeyCode();
        if (code != android.view.KeyEvent.KEYCODE_VOLUME_UP
                && code != android.view.KeyEvent.KEYCODE_VOLUME_DOWN) return false;
        // 只认按下，忽略抬起/长按重复
        if (e.getAction() != android.view.KeyEvent.ACTION_DOWN || e.getRepeatCount() > 0) return false;

        long now = System.currentTimeMillis();
        if (now - lastToggleAt < TAP_COOLDOWN_MS) return false;

        long[] last = code == android.view.KeyEvent.KEYCODE_VOLUME_UP
                ? new long[]{lastVolUpDownAt} : new long[]{lastVolDownDownAt};
        boolean isDouble = now - last[0] <= DOUBLE_TAP_MS;
        if (code == android.view.KeyEvent.KEYCODE_VOLUME_UP) lastVolUpDownAt = now;
        else lastVolDownDownAt = now;
        if (!isDouble) return false;

        lastToggleAt = now;
        if (code == android.view.KeyEvent.KEYCODE_VOLUME_UP) {
            boolean on = ToggleStore.toggleOverlay();
            if (overlay != null) {
                if (on && ToggleStore.appOn()) overlay.show(); else overlay.hide();
            }
            Bus.publishStatus("弹窗已" + (on ? "打开" : "关闭") + "（双击 Vol+ 切换）", "toggle");
            Log.d(TAG, "KEY toggle overlay=" + on);
        } else {
            boolean on = ToggleStore.toggleApp();
            if (overlay != null) {
                if (on && ToggleStore.overlayOn()) overlay.show(); else overlay.hide();
            }
            Bus.publishStatus(on ? "应用已开启" : "应用已暂停（双击 Vol- 恢复）", "toggle");
            Log.d(TAG, "KEY toggle app=" + on);
        }
        // 返回 false：不吞键，音量照常变化（避免"按键坏了"的错觉）
        return false;
    }

    private void scheduleScan() {
        if (pending != null) h.removeCallbacks(pending);
        // 作废正在跑的重试链（它内部的下一跳靠 scanGen 自杀）
        scanGen++;
        pending = new Runnable() { public void run() { pending = null; scan(); } };
        h.postDelayed(pending, DEBOUNCE_MS);
    }

    private void scan() {
        if (inFlight) {
            // 关键：不能静默丢帧。
            // 模型响应慢（实测 qoder 3.5~5s）时 inFlight 长时间为 true，
            // 用户在这期间翻到下一题，scheduleScan 排的那一跳到这里就被 return 掉，
            // 而请求结束后没有任何机制重扫 —— 下一题永远读不到。
            // 图片题尤其明显：翻页后 a11y 事件只来一次，丢了就彻底静默。
            // 所以挂一个补偿扫描，等请求结束后再跑一次。
            Log.d(TAG, "scan deferred: request in flight");
            deferredScan = true;
            return;
        }
        attempt(0);
    }

    /** 请求结束后调用：如果有被推迟的扫描，补跑一次 */
    private void flushDeferredScan() {
        if (!deferredScan) return;
        deferredScan = false;
        Log.d(TAG, "flush deferred scan");
        scheduleScan();
    }

    /**
     * 周期性兜底扫描。
     *
     * 为什么必须有：图片题的题干是张 <img>，翻页时 DOM 里**没有任何文本节点
     * 发生变化**，a11y 的 TYPE_WINDOW_CONTENT_CHANGED 根本不触发。
     * 实测：从第 5 题（简答）点「下一题」到第 6 题（图片题）后，
     * AnsReader 一条日志都没有 —— 扫描器压根没被唤醒，OCR 链路自然也没机会跑。
     * 学习通的真实图片题同样如此。
     *
     * 只在考试页轮询（靠 EXAM_CHROME 判据），非答题页不烧 CPU 也不截屏。
     */
    private void startPoll() {
        if (pollRunning) return;
        pollRunning = true;
        pollTick = new Runnable() { public void run() {
            if (!pollRunning) return;
            if (!ToggleStore.appOn()) { stopPoll(); return; }
            // 只在最近一次读到的是答题页时才继续轮询
            String t = readAllWindows();
            if (isExamPage(t)) {
                Log.d(TAG, "poll tick (exam page, chars=" + t.length() + ")");
                scan();
            } else {
                Log.d(TAG, "poll stop: not an exam page");
                stopPoll();
                return;
            }
            h.postDelayed(pollTick, POLL_MS);
        } };
        h.postDelayed(pollTick, POLL_MS);
    }

    private void stopPoll() {
        pollRunning = false;
        if (pollTick != null) { h.removeCallbacks(pollTick); pollTick = null; }
    }

    /**
     * 带判据的多次重试读题。
     *
     * 为什么必须重试：WebView 的虚拟节点树不是随窗口一起出现的。
     * `am start` 之后立刻读，只能拿到 Activity 的原生视图（标题栏、按钮），
     * 需要等 WebView 完成首帧布局 + 无障碍节点构建，内容才挂上去。
     * 判据用「有选项标记或题干特征」，而不是简单的长度阈值 —— 长度 6
     * 用标题栏就能满足，会导致读到空壳就去问模型。
     *
     * 为什么带 gen：scheduleScan 只能取消**还没跑**的 pending Runnable，
     * 已经跑起来的那条重试链（内部 h.postDelayed 排的下一跳）取消不掉。
     * 登录页的 windowContentChanged 一秒来好几次，于是多条链同时跑，
     * 日志里出现 attempt#3/#5/#1 乱序交错，也浪费 CPU。
     * 每开一条新链就 ++scanGen，旧链的下一跳发现代数变了直接退出。
     */
    private void attempt(final int n) {
        attempt(n, scanGen);
    }

    private void attempt(final int n, final int gen) {
        if (gen != scanGen) return;          // 这条链已被更新的扫描取代
        if (inFlight) { deferredScan = true; return; }
        String text = readAllWindows();
        boolean usable = looksLikeQuestion(text);
        // 图片题：页面上有选项和题型，但题干一个字都没有。
        // a11y 只能读到选项 —— 题干是张图，文字全在像素里。
        // 这种页面 looksLikeQuestion 返回 true（选项≥2），于是永远走不到
        // OCR 兜底，模型只能靠选项硬猜（实测第 6 题「IP 在哪一层」靠
        // A.传输层/B.网络层/C.数据链路层/D.物理层 猜出 B，答案对但纯属运气）。
        boolean imageStem = usable && isImageQuestion();

        // 只在内容变化时打日志：WebView 滚动/倒计时会每秒刷几十条，日志会淹掉证据
        if (!text.equals(lastLoggedText)) {
            lastLoggedText = text;
            Log.d(TAG, "attempt#" + n + " windows=" + windowCount()
                    + " chars=" + text.length() + " usable=" + usable
                    + (imageStem ? " imageStem=true" : ""));
        }

        if (!usable && n < MAX_ATTEMPTS) {
            h.postDelayed(new Runnable() { public void run() { attempt(n + 1, gen); } },
                    RETRY_STEP_MS);
            return;
        }
        if (!usable) {
            Log.d(TAG, "give up after " + n + " attempts, last="
                    + text.replace('\n', '|'));
            // 图片题兜底：a11y 读不到文字 → root screencap → PC OCR
            // 但必须先过页面闸门：登录页/首页/toast 也会走到这里，
            // 不过闸就会把整屏截图上送模型，烧额度还糊一屏废话。
            if (ToggleStore.appOn() && isExamPage(text)) {
                handleWithOcr(text);
            } else {
                Log.d(TAG, "OCR fallback skipped: not an exam page");
                Bus.publishStatus("未识别到题目（当前不是答题页）", "off");
            }
            return;
        }
        // 有选项但没题干 → 图片题，走 OCR 而不是让模型猜选项
        if (imageStem && ToggleStore.appOn()) {
            Log.d(TAG, "image question: options without stem, use OCR");
            handleWithOcr(text);
            return;
        }
        handleText(text);
    }

    /**
     * 当前屏是不是「有选项但题干是图片」。
     *
     * 判据：readStructured() 抽出的 stem 为空，但选项 ≥2 且有题型标签。
     * 为什么不能只看「stem 为空」：作业页/答题卡页也可能只有选项没题干，
     * 那种页面没有题型标签，不该截屏。三个条件同时成立才认定图片题。
     */
    private boolean isImageQuestion() {
        try {
            String s = readStructured();
            if (s == null || s.isEmpty()) return false;
            org.json.JSONObject j = new org.json.JSONObject(s);
            String stem = j.optString("stem", "").trim();
            org.json.JSONArray arr = j.optJSONArray("options");
            int opts = arr == null ? 0 : arr.length();
            String typeLabel = j.optString("typeLabel", "").trim();
            return stem.isEmpty() && opts >= 2 && !typeLabel.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 当前屏是不是答题页。
     *
     * 判据：出现考试页专属的界面元素（交卷/答题卡/上一题/下一题/剩余时间/共N题）。
     * 这些文案只在考试/作业答题页出现，登录页、首页、课程列表、消息页都没有。
     *
     * 为什么 OCR 兜底必须过这道闸：a11y 会把前台应用的任意页面都读进来。
     * 实测学习通登录页清洗后只剩「我已阅读并同意学习通《隐私政策》和《用户协议》」，
     * looksLikeQuestion 正确地判了 false，但 OCR 兜底没再校验，直接把 210KB
     * 截屏送进模型，模型回了一段"该内容并非课程题目"糊到叠层上 —— 白烧一次调用。
     * 同理「跳过1s」这类 toast 也会触发。
     */
    private static boolean isExamPage(String t) {
        if (t == null || t.isEmpty()) return false;
        return EXAM_CHROME.matcher(t).find();
    }

    /** 够不够像一道题：出现选项字母标记，或出现分值/空号/题号特征 */
    private static boolean looksLikeQuestion(String t) {
        if (t == null) return false;
        if (t.length() < 12) return false;
        // A. / A、 / A) / (A) 这类选项标记
        if (java.util.regex.Pattern.compile("(?m)^\\s*[\\(（]?[A-J][\\.、\\)）]\\s*\\S")
                .matcher(t).find()) return true;
        // 分值 "（2分）" / "2分"、填空 ____、题号 "第1题"
        if (java.util.regex.Pattern.compile("[(（]\\s*\\d+(\\.\\d+)?\\s*分\\s*[)）]")
                .matcher(t).find()) return true;
        if (t.contains("____") || t.contains("（ ）")) return true;
        return false;
    }

    private int windowCount() {
        try {
            int n = 0;
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w != null && w.getType() == android.view.accessibility
                        .AccessibilityWindowInfo.TYPE_APPLICATION) n++;
            }
            return n;
        } catch (Throwable t) { return -1; }
    }

    /**
     * 把叠层窗口自己的无障碍节点树读回来。
     *
     * 这是独立于 screencap 的证据通道：SKIP_SCREENSHOT 让像素级抓取看不到叠层，
     * uiautomator dump 又不含 TYPE_ACCESSIBILITY_OVERLAY 窗口，只有无障碍服务
     * 自己能同时看到「窗口存在」和「节点里的文字」。
     *
     * 同时验证一个关键约束：叠层必须是 NOT_FOCUSABLE 且不属于当前活动窗口，
     * 否则会干扰 ReaderService 读考试页。
     */
    private String dumpOwnOverlayWindow() {
        try {
            StringBuilder sb = new StringBuilder();
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w == null || w.getType() != 2032) continue; // TYPE_ACCESSIBILITY_OVERLAY
                android.graphics.Rect r = new android.graphics.Rect();
                w.getBoundsInScreen(r);
                sb.append("win{id=").append(w.getId())
                  .append(" layer=").append(w.getLayer())
                  .append(" active=").append(w.isActive())
                  .append(" focused=").append(w.isFocused())
                  .append(" bounds=").append(r.toShortString()).append('}');
                AccessibilityNodeInfo root = w.getRoot();
                if (root != null) {
                    StringBuilder t = new StringBuilder();
                    collectOverlayText(root, t, 0);
                    sb.append(" text=[").append(t.toString().replace('\n', '/')).append(']');
                } else {
                    sb.append(" text=<root null>");
                }
            }
            return sb.length() == 0 ? "no 2032 window" : sb.toString();
        } catch (Throwable t) {
            return "dump failed: " + t;
        }
    }

    private void collectOverlayText(AccessibilityNodeInfo n, StringBuilder sb, int d) {
        if (n == null || d > 20) return;
        CharSequence c = n.getText();
        if (c != null && c.length() > 0) {
            String s = c.toString().trim();
            if (!s.isEmpty()) sb.append(s).append('\n');
        }
        int cnt = Math.min(n.getChildCount(), 100);
        for (int i = 0; i < cnt; i++) collectOverlayText(n.getChild(i), sb, d + 1);
    }

    /** 合并所有应用窗口的文本，去重后按出现顺序拼接 */
    private String readAllWindows() {
        StringBuilder sb = new StringBuilder();
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();

        try {
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w == null) continue;
                if (w.getType() != android.view.accessibility.AccessibilityWindowInfo
                        .TYPE_APPLICATION) continue;
                AccessibilityNodeInfo r = w.getRoot();
                if (r == null) continue;
                walk(r, sb, seen, 0);
            }
        } catch (Throwable t) {
            Log.w(TAG, "getWindows failed", t);
        }

        // 兜底：活动窗口根节点
        if (sb.length() < MIN_TEXT_LEN) {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) walk(r, sb, seen, 0);
        }
        // 再兜底：焦点节点向上找根
        if (sb.length() < MIN_TEXT_LEN) {
            AccessibilityNodeInfo f = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (f == null) f = findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
            AccessibilityNodeInfo r = f;
            while (r != null && r.getParent() != null) r = r.getParent();
            if (r != null) walk(r, sb, seen, 0);
        }
        return sb.toString().trim();
    }

    /**
     * 图片题兜底：root 截屏 → base64 → POST /answer{question,image}。
     * 只截一次（防抖由 scheduleScan 保证），OCR 在 PC 端做。
     */
    private void handleWithOcr(final String a11yText) {
        if (inFlight) return;
        // 同一屏不重复截屏 OCR。
        // 轮询每 2.5s 一跳，若每次都 hide→screencap→show，叠层会不停闪，
        // 而且 hide/show 是 UI 线程异步的，交错执行会让叠层停在隐藏状态
        // （实测 OVERLAY[not-attached]）。图片题的选项本身在 a11y 里可读，
        // 所以「a11y 文本没变 + 已经答过」就足以判定是同一题，直接跳过。
        if (a11yText != null && a11yText.equals(lastOcrA11yText) && !lastScreenHash.isEmpty()) {
            Log.d(TAG, "OCR skip: same a11y text, already answered");
            // 跳过 OCR 不等于什么都不做：上一轮 hide 掉的叠层必须重新挂上，
            // 否则会一直停在隐藏状态（实测 OVERLAY[not-attached]）。
            if (overlay != null && ToggleStore.overlayOn() && ToggleStore.appOn()) overlay.show();
            return;
        }
        lastOcrA11yText = a11yText;
        inFlight = true;
        new Thread(new Runnable() { public void run() {
            try {
                // 截屏前必须先把叠层藏起来。
                // screencap 是像素级抓取，会把 TYPE_ACCESSIBILITY_OVERLAY 窗口
                // 一起拍进去 —— 上一题的答案卡片正好盖在题干上，OCR 读到的
                // 就是自己刚给出的答案，等于自问自答（实测：图片题读到的是
                // 上一道 UDP 简答题的 A/B/C/D 论述，真题干只露出半行）。
                // SKIP_SCREENSHOT 只影响 MediaProjection/系统截屏，不影响 root
                // screencap，所以这里必须显式 hide。
                // 必须用 latch 等 hide 真正跑完：hide() 只是 post 到 UI 线程，
                // 立刻 screencap 会拍到叠层残影（实测 950KB 那张就是残影）。
                final boolean wasShown = overlay != null && ToggleStore.overlayOn();
                if (wasShown) {
                    final java.util.concurrent.CountDownLatch done =
                            new java.util.concurrent.CountDownLatch(1);
                    h.post(new Runnable() { public void run() {
                        try { overlay.hide(); } finally { done.countDown(); }
                    } });
                    try { done.await(2, java.util.concurrent.TimeUnit.SECONDS); }
                    catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                    // 窗口移除到 SurfaceFlinger 真正合成完还有一点延迟
                    try { Thread.sleep(250); } catch (InterruptedException ignored) { }
                }
                String img;
                try {
                    img = captureScreenBase64();
                } finally {
                    // 无论截图成功与否都要把叠层放回去
                    if (wasShown) {
                        final java.util.concurrent.CountDownLatch back =
                                new java.util.concurrent.CountDownLatch(1);
                        h.post(new Runnable() { public void run() {
                            try {
                                if (ToggleStore.overlayOn() && ToggleStore.appOn()) overlay.show();
                            } finally { back.countDown(); }
                        } });
                        try { back.await(2, java.util.concurrent.TimeUnit.SECONDS); }
                        catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                    }
                }
                if (img == null || img.isEmpty()) {
                    Log.w(TAG, "OCR fallback: screencap failed");
                    Bus.publishStatus("图片题：截屏失败（需 root）", "error");
                    return;
                }
                Log.d(TAG, "OCR fallback: sending " + (img.length() / 1024) + "KB image");
                // 把区域抽取结果一起上送：服务端靠「有选项无题干」判定这是图片题，
                // 才能让 OCR 文本接管题干，而不是拿空壳 structured 覆盖掉 OCR。
                String struct = readStructured();
                Answer a = askPC(a11yText == null ? "" : a11yText, img,
                        struct == null ? "" : struct);
                if (a == null) return;
                // 服务端二次判定为非题目（图片里其实也不是题）：不糊叠层
                if ("none".equals(a.source)) {
                    Log.d(TAG, "OCR fallback: server says not a question, drop");
                    Bus.publishStatus("未识别到题目", "off");
                    return;
                }
                String dedupKey = a.stableKey.isEmpty() ? a.screenHash : a.stableKey;
                if (!dedupKey.isEmpty() && dedupKey.equals(lastScreenHash)) {
                    Log.d(TAG, "OCR fallback skip same question " + dedupKey);
                    return;
                }
                lastScreenHash = dedupKey;
                Log.d(TAG, "OCR answer src=" + a.source + " type=" + a.type + " => " + a.text);
                Bus.publishV2(a.stem, a.text, a.source, a.type, a.ms);
            } finally {
                inFlight = false;
                flushDeferredScan();   // 请求期间翻页了 → 补扫一次
            }
        } }).start();
    }

    /** root screencap → PNG → base64（约 0.3~1s） */
    private static String captureScreenBase64() {
        String pngPath = "/data/local/tmp/ansreader-ocr.png";
        try {
            Process p = Runtime.getRuntime().exec(new String[]{
                    "su", "-c", "screencap -p " + pngPath + " && chmod 666 " + pngPath});
            p.waitFor();
            java.io.File f = new java.io.File(pngPath);
            if (!f.exists() || f.length() <= 0) return null;
            byte[] b = new byte[(int) f.length()];
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int r = fis.read(b, off, b.length - off);
                    if (r < 0) break;
                    off += r;
                }
            } finally { fis.close(); }
            f.delete();
            return android.util.Base64.encodeToString(b, android.util.Base64.NO_WRAP);
        } catch (Throwable t) {
            Log.w(TAG, "captureScreenBase64 failed", t);
            return null;
        }
    }

    private void handleText(final String text) {
        final String q = text;
        final String structured = readStructured();
        Log.d(TAG, "READ " + text.length() + " chars:\n"
                + (text.length() > 1500 ? text.substring(0, 1500) + "…" : text));
        inFlight = true;
        new Thread(new Runnable() { public void run() {
            try {
                Answer a = askPC(q, null, structured);
                if (a == null) return;
                // 服务端判定为非题目（题干清洗后只剩页面装饰）：不糊叠层、不占去重位
                if ("none".equals(a.source)) {
                    Log.d(TAG, "server says not a question, drop (kept last=" + lastScreenHash + ")");
                    Bus.publishStatus("未识别到题目", "off");
                    return;
                }
                // 去重键优先用 stableKey（题干+选项哈希，滚动不变），
                // 没有时才退回整屏 screenHash（老版 PC 服务兼容）。
                String dedupKey = a.stableKey.isEmpty() ? a.screenHash : a.stableKey;
                if (!dedupKey.isEmpty() && dedupKey.equals(lastScreenHash)) {
                    Log.d(TAG, "skip same question " + dedupKey);
                    return;
                }
                lastScreenHash = dedupKey;
                Log.d(TAG, "answer src=" + a.source + " type=" + a.type
                        + " ms=" + a.ms + " => " + a.text);
                Bus.publishV2(a.stem, a.text, a.source, a.type, a.ms);

                // 自检：把叠层上真正渲染出来的东西打到日志。
                // SKIP_SCREENSHOT 之后 screencap / uiautomator 都看不到这个窗口，
                // 日志是唯一能证明「文字确实画上去了」的通道。
                h.postDelayed(new Runnable() { public void run() {
                    if (overlay != null) {
                        Log.i(TAG, "OVERLAY[" + overlay.geometry() + "] " + overlay.snapshot());
                        Log.i(TAG, "OVERLAY-WINDOW " + dumpOwnOverlayWindow());
                    }
                } }, 400);
            } finally {
                inFlight = false;
                flushDeferredScan();   // 请求期间翻页了 → 补扫一次
            }
        } }).start();
    }

    // ─────────────────────── 网络 ───────────────────────

    private static final class Answer {
        String text = "";
        String stem = "";
        String source = "unknown";
        String type = "";
        String screenHash = "";
        String stableKey = "";  // 题干+选项的稳定哈希，滚动/可见性变化不影响
        long ms = 0;
    }

    private Answer askPC(String question) {
        return askPC(question, null, "");
    }

    /** 带图片题 OCR 的上送：image 为 base64 PNG，可为 null */
    private Answer askPC(String question, String image) {
        return askPC(question, image, "");
    }

    /** 完整上送：question=整屏文本兜底，image=OCR图，structured=区域抽取JSON */
    private Answer askPC(String question, String image, String structured) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(ConfigStore.endpoint()).openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setDoOutput(true);
            conn.setConnectTimeout(3000);
            // OCR 可能耗时几秒，给足读超时
            conn.setReadTimeout(image == null ? 30000 : 45000);

            JSONObject body = new JSONObject();
            body.put("question", question);
            body.put("pkg", "com.air.mpprobe");
            if (image != null && !image.isEmpty()) body.put("image", image);
            if (structured != null && !structured.isEmpty()) {
                // 区域抽取结果：JSON 对象字符串，PC 端优先用它（不再猜题干/选项）
                try { body.put("structured", new JSONObject(structured)); }
                catch (Throwable ignored) { body.put("structured", structured); }
            }
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            java.io.InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) baos.write(buf, 0, n);
                is.close();
            }
            String resp = new String(baos.toByteArray(), StandardCharsets.UTF_8);
            if (code >= 400) {
                Answer a = new Answer();
                a.text = "PC HTTP " + code;
                a.source = "error";
                Log.w(TAG, "http " + code + ": " + resp);
                return a;
            }
            return parse(resp);
        } catch (Throwable t) {
            Answer a = new Answer();
            a.text = "PC 连接失败: " + t.getClass().getSimpleName();
            a.source = "error";
            Log.w(TAG, "askPC failed", t);
            return a;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static Answer parse(String resp) {
        Answer a = new Answer();
        try {
            JSONObject j = new JSONObject(resp);
            a.text = j.optString("answer", "");
            a.source = j.optString("source", "unknown");
            a.type = j.optString("type", "");
            a.screenHash = j.optString("screenHash", "");
            a.stableKey = j.optString("stableKey", "");
            a.ms = j.optLong("ms", 0);
            JSONObject qj = j.optJSONObject("question");
            if (qj != null) {
                a.stem = qj.optString("stem", "");
                if (a.type.isEmpty()) a.type = qj.optString("type", "");
            }
            if (a.text.isEmpty()) {
                a.text = "（空答案）";
                if ("unknown".equals(a.source)) a.source = "error";
            }
        } catch (Throwable t) {
            a.text = "响应解析失败";
            a.source = "error";
            Log.w(TAG, "parse failed: " + resp, t);
        }
        return a;
    }

    // ─────────────────────── 节点树 ───────────────────────

    private void walk(AccessibilityNodeInfo n, StringBuilder sb,
                      java.util.Set<String> seen, int depth) {
        if (n == null || depth > 40) return;
        if (!n.isVisibleToUser()) return;

        CharSequence t = n.getText();
        CharSequence d = n.getContentDescription();
        String s = t != null ? t.toString() : (d != null ? d.toString() : "");
        s = s.trim();
        if (!s.isEmpty() && seen.add(s)) sb.append(s).append('\n');

        int cnt = Math.min(n.getChildCount(), 300);
        for (int i = 0; i < cnt; i++) walk(n.getChild(i), sb, seen, depth + 1);
    }

    // ─────────────────── 区域抽取（题干/选项/题型按 a11y 层级分离）───────────────────

    /** 一个可见文本节点及其屏幕位置 */
    private static final class TextNode {
        final String text;
        final int top, bottom, left;
        /** 是否是可编辑输入框（EditText）。输入框的 text 是 hint，不是题干 */
        final boolean editable;
        TextNode(String text, int top, int bottom, int left, boolean editable) {
            this.text = text; this.top = top; this.bottom = bottom;
            this.left = left; this.editable = editable;
        }
    }

    /**
     * 读取带位置的文本节点，按 y 排序后分区域。
     * 学习通/考试页的 WebView 会把每个 div 映射成独立 TextView 并带精确 bounds，
     * 据此区分「题干 / 选项 / 题型 / UI 噪声」，不再靠整屏文本猜。
     * @return JSON 字符串 {stem, options:[...], typeLabel}；失败返回 ""
     */
    private String readStructured() {
        java.util.List<TextNode> nodes = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        try {
            for (android.view.accessibility.AccessibilityWindowInfo w : getWindows()) {
                if (w == null || w.getType() != android.view.accessibility.AccessibilityWindowInfo
                        .TYPE_APPLICATION) continue;
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null) collectNodes(r, nodes, seen, 0);
            }
        } catch (Throwable t) {
            Log.w(TAG, "readStructured getWindows failed", t);
        }
        if (nodes.isEmpty()) return "";
        java.util.Collections.sort(nodes, new java.util.Comparator<TextNode>() {
            public int compare(TextNode a, TextNode b) { return a.top - b.top; }
        });
        return groupNodes(nodes);
    }

    private void collectNodes(AccessibilityNodeInfo n, java.util.List<TextNode> out,
                              java.util.Set<String> seen, int depth) {
        if (n == null || depth > 40 || !n.isVisibleToUser()) return;
        CharSequence t = n.getText();
        String s = t != null ? t.toString().trim() : "";
        if (!s.isEmpty() && seen.add(s)) {
            android.graphics.Rect r = new android.graphics.Rect();
            n.getBoundsInScreen(r);
            // 标出输入框：简答题的 EditText 把 hint「在此输入你的答案」当 text 报上来，
            // 长度 9 字能过 stem 的长度门槛，反而把真正的题干挤掉（实测踩过）。
            out.add(new TextNode(s, r.top, r.bottom, r.left, n.isEditable()));
        }
        int cnt = Math.min(n.getChildCount(), 300);
        for (int i = 0; i < cnt; i++) collectNodes(n.getChild(i), out, seen, depth + 1);
    }

    /** 按 y 坐标 + 文本特征分成题干/选项/题型 */
    private String groupNodes(java.util.List<TextNode> nodes) {
        java.util.List<String> options = new java.util.ArrayList<>();
        String stem = "", typeLabel = "";
        int stemTop = -1, firstOptTop = -1;

        // 1. 题型标签：独立成行的「单选题/多选题/判断题/填空题/简答题」
        String[] TYPES = {"单选题", "多选题", "判断题", "填空题", "简答题", "名词解释", "论述题"};
        for (TextNode n : nodes) {
            for (String ty : TYPES) {
                if (n.text.equals(ty)) { typeLabel = ty; break; }
            }
            if (!typeLabel.isEmpty()) break;
        }

        // 2. 选项：匹配 A. / A、/ A) 开头的行，记录首选项 y
        java.util.regex.Pattern optRe = java.util.regex.Pattern.compile("^\\s*[A-J][.、)）]\\s*\\S.*");
        for (TextNode n : nodes) {
            if (optRe.matcher(n.text).matches()) {
                options.add(n.text);
                if (firstOptTop < 0) firstOptTop = n.top;
            }
        }

        // 3. 题干：在题型标签之后、第一个选项之前的较长文本
        //    剔除 UI 噪声（倒计时/工具栏/按钮/题号分值单独行）
        //
        //    选择规则分两档，不能只取"最靠下的长文本"：
        //    简答题的答题框占位文字「在此输入你的答案」比真题干更靠下、
        //    长度 9 也过了 8 字门槛，单靠 y 排序会把题干挤掉（实测踩过）。
        //    所以带题号/分值标记的行优先，标记行之间才比 y。
        String markedStem = ""; int markedTop = -1;
        for (TextNode n : nodes) {
            if (n.editable) continue;                                 // 输入框 hint 不是题干
            if (firstOptTop > 0 && n.top >= firstOptTop) continue;    // 选项区及以后
            if (isChromeText(n.text)) continue;
            if (isPlaceholder(n.text)) continue;                      // 「在此输入你的答案」类占位
            boolean marked = STEM_MARK.matcher(n.text).find();
            if (marked) {
                if (markedStem.isEmpty() || n.top > markedTop) {
                    markedStem = n.text; markedTop = n.top;
                }
                continue;
            }
            // 长度门槛：普通行要 ≥8 字（挡掉题号/分值/题型标签）
            if (n.text.length() < 8) continue;
            // 取最靠下的一条较长文本作为题干（题干通常在选项紧上方）
            if (stem.isEmpty() || n.top > stemTop) { stem = n.text; stemTop = n.top; }
        }
        if (!markedStem.isEmpty()) stem = markedStem;   // 带题号/分值的最可信

        if (stem.isEmpty() && options.isEmpty()) return "";
        try {
            JSONObject j = new JSONObject();
            j.put("stem", stem);
            org.json.JSONArray arr = new org.json.JSONArray();
            for (String o : options) arr.put(o);
            j.put("options", arr);
            j.put("typeLabel", typeLabel);
            Log.d(TAG, "STRUCT stem=" + stem + " opts=" + options.size() + " type=" + typeLabel);
            return j.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 输入框占位提示（placeholder / hint），不是题干。
     *
     * mock 与学习通的答题框在 WebView 里渲染成普通 TextView（isEditable()=false），
     * 所以不能只靠 editable 标志识别，必须按文案兜。
     * 这些文字恰好都 ≥8 字，能骗过长度门槛，且位置在真题干下方，
     * 「取最靠下的长文本」的规则会优先选中它们 —— 实测把简答题题干换成了
     * 「在此输入你的答案」，模型只好回"请提供具体题目"。
     */
    private static boolean isPlaceholder(String s) {
        if (s == null) return true;
        String t = s.trim();
        if (t.contains("在此输入") || t.contains("请输入")) return true;
        if (t.contains("点击输入") || t.contains("输入你的答案")) return true;
        if (t.contains("请输入答案") || t.contains("填写答案")) return true;
        if (t.equals("答案") || t.equals("作答区")) return true;
        return false;
    }

    /** UI 装饰文字（题型/工具栏/倒计时/按钮）——不作为题干 */
    private static boolean isChromeText(String s) {
        if (s == null) return true;
        String t = s.trim();
        if (t.contains("剩余时间") || t.contains("倒计时")) return true;
        if (t.contains("答题卡") || t.contains("上一题") || t.contains("下一题")) return true;
        if (t.contains("保存") && t.contains("提交")) return true;
        if (t.equals("Exam Mock") || t.equals("下一题 / NEXT")) return true;
        return false;
    }

    @Override public void onInterrupt() {
        Log.d(TAG, "interrupted");
    }

    @Override public void onDestroy() {
        Bus.removeListener(busListener);
        if (overlay != null) overlay.hide();
        super.onDestroy();
    }
}