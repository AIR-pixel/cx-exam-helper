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

    private final Handler h = new Handler(Looper.getMainLooper());
    private Runnable pending;
    private String lastScreenHash = "";
    private volatile boolean inFlight = false;

    private AnswerOverlay overlay;
    private Bus.Listener busListener;

    @Override public void onServiceConnected() {
        super.onServiceConnected();
        Log.d(TAG, "connected");

        overlay = new AnswerOverlay(this);
        busListener = new Bus.Listener() {
            public void onUpdate(Bus.Msg m) {
                if (overlay != null) overlay.render(m);
            }
            public void onStatus(String text, String kind) {
                if (overlay != null) overlay.status(text, kind);
            }
        };
        Bus.setListener(busListener);
        overlay.show();
        Bus.publishStatus("a11y 已连接，等待题目…", "ready");
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null) return;
        int t = e.getEventType();
        if (t != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && t != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && t != AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) return;
        scheduleScan();
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

    private void handleText(final String text) {
        final String q = text;
        Log.d(TAG, "READ " + text.length() + " chars:\n"
                + (text.length() > 1500 ? text.substring(0, 1500) + "…" : text));
        inFlight = true;
        new Thread(new Runnable() { public void run() {
            try {
                Answer a = askPC(q);
                if (a == null) return;
                if (!a.screenHash.isEmpty() && a.screenHash.equals(lastScreenHash)) {
                    Log.d(TAG, "skip same screen " + a.screenHash);
                    return;
                }
                lastScreenHash = a.screenHash;
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
        long ms = 0;
    }

    private Answer askPC(String question) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(ENDPOINT).openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setDoOutput(true);
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(30000);

            JSONObject body = new JSONObject();
            body.put("question", question);
            body.put("pkg", "com.air.mpprobe");
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

    @Override public void onInterrupt() {
        Log.d(TAG, "interrupted");
    }

    @Override public void onDestroy() {
        Bus.removeListener(busListener);
        if (overlay != null) overlay.hide();
        super.onDestroy();
    }
}