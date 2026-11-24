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
    private static final String ENDPOINT = "http://127.0.0.1:18888/answer";
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

    private final Handler h = new Handler(Looper.getMainLooper());
    private Runnable pending;
    private String lastScreenHash = "";
    private volatile boolean inFlight = false;

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
        pending = new Runnable() { public void run() { pending = null; scan(); } };
        h.postDelayed(pending, DEBOUNCE_MS);
    }

    private void scan() {
        if (inFlight) return;
        attempt(0);
    }

    /**
     * 带判据的多次重试读题。
     *
     * 为什么必须重试：WebView 的虚拟节点树不是随窗口一起出现的。
     * `am start` 之后立刻读，只能拿到 Activity 的原生视图（标题栏、按钮），
     * 需要等 WebView 完成首帧布局 + 无障碍节点构建，内容才挂上去。
     * 判据用「有选项标记或题干特征」，而不是简单的长度阈值 —— 长度 6
     * 用标题栏就能满足，会导致读到空壳就去问模型。
     */
    private void attempt(final int n) {
        if (inFlight) return;
        String text = readAllWindows();
        boolean usable = looksLikeQuestion(text);

        Log.d(TAG, "attempt#" + n + " windows=" + windowCount()
                + " chars=" + text.length() + " usable=" + usable);

        if (!usable && n < MAX_ATTEMPTS) {
            h.postDelayed(new Runnable() { public void run() { attempt(n + 1); } },
                    RETRY_STEP_MS);
            return;
        }
        if (!usable) {
            Log.d(TAG, "give up after " + n + " attempts, last="
                    + text.replace('\n', '|'));
            // 图片题兜底：a11y 读不到文字 → root screencap → PC OCR
            if (ToggleStore.appOn()) handleWithOcr(text);
            return;
        }
        handleText(text);
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
        inFlight = true;
        new Thread(new Runnable() { public void run() {
            try {
                String img = captureScreenBase64();
                if (img == null || img.isEmpty()) {
                    Log.w(TAG, "OCR fallback: screencap failed");
                    Bus.publishStatus("图片题：截屏失败（需 root）", "error");
                    return;
                }
                Log.d(TAG, "OCR fallback: sending " + (img.length() / 1024) + "KB image");
                Answer a = askPC(a11yText == null ? "" : a11yText, img);
                if (a == null) return;
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
            conn = (HttpURLConnection) new URL(ENDPOINT).openConnection();
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
        TextNode(String text, int top, int bottom, int left) {
            this.text = text; this.top = top; this.bottom = bottom; this.left = left;
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
            out.add(new TextNode(s, r.top, r.bottom, r.left));
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
        for (TextNode n : nodes) {
            if (firstOptTop > 0 && n.top >= firstOptTop) continue;   // 选项区及以后
            if (n.text.length() < 8) continue;                        // 太短（题号/分值/题型）
            if (isChromeText(n.text)) continue;
            // 取最靠下的一条较长文本作为题干（题干通常在选项紧上方）
            if (stem.isEmpty() || n.top > stemTop) { stem = n.text; stemTop = n.top; }
        }

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