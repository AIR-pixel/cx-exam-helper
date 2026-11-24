package com.air.mpprobe;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.method.ScrollingMovementMethod;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * AnswerOverlay —— 真正能压在别人界面上的叠层。
 *
 * 为什么不用 Activity：普通 Activity 叠层会被之后启动的前台应用（学习通）盖掉，
 * 这是 doc 13 里没解决的问题。
 *
 * 为什么不用 TYPE_APPLICATION_OVERLAY：HyperOS 上 FloatService 的 buffer 永远停在
 * READY_TO_SHOW，加了 SYSTEM_ALERT_WINDOW 也不显示（已实测，代码留档在 FloatService）。
 *
 * 用 TYPE_ACCESSIBILITY_OVERLAY：无障碍服务自己 addView 的窗口，由
 * WindowManagerService 直接置顶，不经过应用悬浮窗权限通道，也不受 MIUI 悬浮窗开关影响。
 *
 * SKIP_SCREENSHOT 不受影响：LSPosed 模块 hook 的是本进程 ViewRootImpl.setView，
 * a11y overlay 的 View 一样走 ViewRootImpl，照样被打上 setSkipScreenshot。
 */
public final class AnswerOverlay {

    private static final int TYPE_A11Y_OVERLAY = 2032; // TYPE_ACCESSIBILITY_OVERLAY

    // 字号统一调小：meta/status 11→10，答案主体 19→15
    private static final float META_SP = 10f;
    private static final float ANSWER_SP = 15f;
    // 黑字描边半径（px）：背板近透明后靠它保证可读
    private static final float OUTLINE_R = 2.5f;
    // 窗口高度上限：短答案自动包内容（WRAP），超长答案封顶后内部自动滚动
    private static final int MAX_ANSWER_HEIGHT = 480;

    // 自动滚动参数：浮层 NOT_TOUCHABLE，用户拖不了，超长答案只能自己滚
    private static final int SCROLL_TICK_MS = 16;      // ~60fps
    private static final int SCROLL_STEP_PX = 6;       // 每帧滚 6px ≈ 4.3 行/秒
    private static final int PAUSE_AT_END_MS = 1800;   // 滚到底停一会
    private static final int PAUSE_AT_TOP_MS = 2500;   // 回顶停一会再滚

    private final Context ctx;
    private final WindowManager wm;
    private final Handler h = new Handler(Looper.getMainLooper());

    private LinearLayout card;
    private TextView metaView;
    private TextView answerView;
    private TextView statusView;

    private boolean attached = false;
    private String curType = "";
    private Runnable autoScroll;

    public AnswerOverlay(Context ctx) {
        this.ctx = ctx;
        this.wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
    }

    // ─────────────────────── 挂载 ───────────────────────

    public void show() {
        // 配置页在前台时不显示：叠层层级高于普通 Activity，会盖住自己的 UI。
        if (Bus.suppressOverlay()) return;
        h.post(new Runnable() { public void run() {
            showInner();
            // 重新挂载后把当前答案填回去（hide→show 之间 Bus 里的值可能已经更新）
            Bus.Msg cur = Bus.last();
            if (cur != null && attached) render(cur);
        } });
    }

    private void showInner() {
        if (attached) return;
        try {
            card = new LinearLayout(ctx);
            card.setOrientation(LinearLayout.VERTICAL);
            int padH = dp(12), padV = dp(8);
            card.setPadding(padH, padV, padH, padV);
            paintCard();

            metaView = new TextView(ctx);
            metaView.setText("答案助手 · 等待题目");
            metaView.setTextColor(Color.parseColor("#CCFFFFFF"));
            metaView.setTextSize(TypedValue.COMPLEX_UNIT_SP, META_SP);
            metaView.setSingleLine(true);
            metaView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);

            answerView = new TextView(ctx);
            answerView.setText("等待读题…");
            answerView.setTextColor(Color.WHITE);
            answerView.setTextSize(TypedValue.COMPLEX_UNIT_SP, ANSWER_SP);
            answerView.setLineSpacing(dp(2), 1f);
            // 不再硬限行数：长简答要能整段显示出来。
            // 上界由窗口高度兜（见 relayout），超出才出现滚动。
            answerView.setMovementMethod(new ScrollingMovementMethod());
            answerView.setVerticalScrollBarEnabled(true);
            // 描边：背板压到近乎透明后，靠这层黑晕在任何背景上都读得清。
            answerView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);
            // 长答案封顶：超出 MAX_ANSWER_HEIGHT 后内部滚动，不撑爆全屏
            answerView.setMaxHeight(dp(MAX_ANSWER_HEIGHT));

            statusView = new TextView(ctx);
            statusView.setText("a11y 已连接");
            statusView.setTextColor(Color.parseColor("#99FFFFFF"));
            statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, META_SP);
            statusView.setSingleLine(true);
            statusView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);

            card.addView(metaView);
            card.addView(answerView, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT));
            card.addView(statusView);

            WindowManager.LayoutParams lp = buildParams(cardWidth(),
                    WindowManager.LayoutParams.WRAP_CONTENT);
            wm.addView(card, lp);
            attached = true;
            // 这里不主动回填 Bus.last()：render() 在未挂载时会调 showInner()，
            // 若 showInner 再回填就会递归。回填统一由调用方（Bus listener /
            // render 自身）负责，showInner 只负责把 View 树搭起来。
        } catch (Throwable t) {
            android.util.Log.e("AnswerOverlay", "addView failed: " + t, t);
        }
    }

    public void hide() {
        h.post(new Runnable() { public void run() {
            if (!attached) return;
            if (autoScroll != null) { h.removeCallbacks(autoScroll); autoScroll = null; }
            try { wm.removeView(card); } catch (Throwable ignored) {}
            attached = false;
            card = null;
        } });
    }

    private WindowManager.LayoutParams buildParams(int w, int hgt) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                w, hgt,
                TYPE_A11Y_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        lp.y = 200;
        // 窗口整体不透明度：背板已近透明，这里保持满不透明度保证文字清晰
        lp.alpha = 1.0f;
        // 明确不抢焦点、不拦截触摸：学习通照常可点
        lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL;
        return lp;
    }

    // ─────────────────────── 渲染 ───────────────────────

    public void render(final Bus.Msg m) {
        h.post(new Runnable() { public void run() {
            // 未挂载时先挂上再渲染。
            // 图片题 OCR 必须先把叠层 hide 掉才能截到干净像素，hide 之后
            // 答案才回来 —— 此时 attached 还是 false，早年的 `return` 会把
            // 答案整个丢掉，叠层恢复后只剩初始占位文本（实测截图里
            // 「a11y 已连接」和 meta 叠印、答案正文消失）。
            if (!attached || card == null) showInner();
            if (!attached || card == null) return;

            String type = m.type == null ? "" : m.type;
            if (!type.equals(curType)) {
                curType = type;
                relayout(type);
            }
            // 统一浅灰透明背板，不随来源变色
            paintCard();

            answerView.setText(m.answer == null || m.answer.isEmpty() ? "…" : m.answer);
            scheduleAutoScroll(m.answer);

            StringBuilder meta = new StringBuilder(labelSource(m.source));
            if (!type.isEmpty()) meta.append(" · ").append(labelType(type));
            if (m.ms > 0) meta.append(" · ").append(m.ms).append("ms");
            metaView.setText(meta.toString());
        } });
    }

    public void status(final String text, final String kind) {
        h.post(new Runnable() { public void run() {
            if (!attached || statusView == null) return;
            boolean bad = "error".equals(kind) || "off".equals(kind);
            statusView.setText(bad ? "⚠ " + text : text);
            statusView.setTextColor(Color.parseColor(bad ? "#FFFFCDD2" : "#90FFFFFF"));
        } });
    }

    /** 宽度按题型：简答要宽、判断可窄；高度交给内容自适应（WRAP），长答案封顶滚动 */
    private void relayout(String type) {
        int w = cardWidth(type);
        try {
            wm.updateViewLayout(card, buildParams(w, WindowManager.LayoutParams.WRAP_CONTENT));
        } catch (Throwable ignored) {}
    }

    private int cardWidth() { return cardWidth(curType); }

    private int cardWidth(String type) {
        switch (type == null ? "" : type) {
            case "short":  return 1000;
            case "blank":  return 940;
            case "multi":  return 920;
            case "judge":  return 780;
            case "single": return 900;
            default:       return 900;
        }
    }

    /** 背板统一浅灰透明：覆盖题目时不让题面被遮住，来源不染色 */
    private void paintCard() {
        GradientDrawable g = new GradientDrawable();
        g.setColor(Color.parseColor("#1AE0E0E0"));
        g.setCornerRadius(dp(14));
        g.setStroke(dp(2), Color.parseColor("#FF9E9E9E"));
        if (card != null) card.setBackground(g);
    }

    /**
     * 超长答案自动滚动。浮层是 NOT_FOCUSABLE|NOT_TOUCHABLE，用户碰不到
     * 滚动条，只能程序自己滚：内容超出可视区 → 慢慢滚到底 → 停一会 →
     * 回顶 → 停一会 → 再滚；短答案不滚动。
     */
    private void scheduleAutoScroll(String answer) {
        if (autoScroll != null) h.removeCallbacks(autoScroll);
        autoScroll = null;
        final String text = answer == null ? "" : answer;
        if (text.isEmpty() || !attached || answerView == null) return;
        answerView.post(new Runnable() { public void run() {
            // 布局完还没量高度，先等等
            if (answerView.getHeight() <= 0) {
                answerView.postDelayed(this, 100);
                return;
            }
            boolean overflow = answerView.getLineCount() > 0
                    && answerView.getLayout() != null
                    && answerView.getLayout().getLineTop(answerView.getLineCount()) > answerView.getHeight();
            if (!overflow) return;
            scrollLoop();
        } });
    }

    private void scrollLoop() {
        final long[] phase = { 0 }; // 0=向下 1=停底 2=向上 3=停顶
        final Runnable[] step = new Runnable[1];
        autoScroll = step[0] = new Runnable() { public void run() {
            if (!attached || answerView == null) { autoScroll = null; return; }
            if (answerView.getLayout() == null || answerView.getLineCount() == 0) { autoScroll = null; return; }
            int max = answerView.getLayout().getLineTop(answerView.getLineCount()) - answerView.getHeight();
            if (max <= 0) { autoScroll = null; return; }

            int y = answerView.getScrollY();
            switch ((int) phase[0]) {
                case 0: // 向下滚
                    y += SCROLL_STEP_PX;
                    if (y >= max) { phase[0] = 1; answerView.scrollTo(0, max); h.postDelayed(step[0], PAUSE_AT_END_MS); return; }
                    answerView.scrollTo(0, y);
                    break;
                case 1: // 到底停，回顶
                    phase[0] = 2; break;
                case 2: // 向上回
                    y -= SCROLL_STEP_PX;
                    if (y <= 0) { phase[0] = 3; answerView.scrollTo(0, 0); h.postDelayed(step[0], PAUSE_AT_TOP_MS); return; }
                    answerView.scrollTo(0, y);
                    break;
                case 3: // 回顶停，再滚
                    phase[0] = 0; break;
            }
            h.postDelayed(step[0], SCROLL_TICK_MS);
        } };
        step[0].run();
    }

    private static String labelSource(String s) {
        if (s == null) return "未知来源";
        switch (s) {
            case "qoder": return "AI · DeepSeek";
            case "cache": return "题库缓存";
            case "heuristic": return "启发式占位";
            case "none": return "未识别到题目";
            case "error": return "引擎错误";
            case "openai": return "AI · OpenAI";
            case "echo": return "回显测试";
            default: return s;
        }
    }

    private static String labelType(String t) {
        switch (t) {
            case "single": return "单选";
            case "multi": return "多选";
            case "judge": return "判断";
            case "blank": return "填空";
            case "short": return "简答";
            default: return t;
        }
    }

    private int dp(int v) {
        return Math.round(v * ctx.getResources().getDisplayMetrics().density);
    }

    // ─────────────────────── 自检 ───────────────────────

    /**
     * 自报当前叠层上真实显示的文字。
     *
     * 为什么需要：SKIP_SCREENSHOT 让 screencap 看不到这个窗口，uiautomator dump
     * 也不含 TYPE_ACCESSIBILITY_OVERLAY 窗口，因此「叠层到底显示了什么」没有
     * 外部观测手段。这里直接从 View 树读回文本，作为渲染结果的客观证据。
     *
     * @return "meta｜answer｜status" 三段拼接；未挂载返回 null
     */
    public String snapshot() {
        if (!attached || card == null) return null;
        StringBuilder sb = new StringBuilder();
        sb.append(metaView != null ? metaView.getText() : "")
          .append(" ｜ ")
          .append(answerView != null ? answerView.getText() : "")
          .append(" ｜ ")
          .append(statusView != null ? statusView.getText() : "");
        return sb.toString();
    }

    /** 叠层实际窗口尺寸，用于核对题型驱动的 relayout 是否生效 */
    public String geometry() {
        if (!attached || card == null) return "not-attached";
        return card.getWidth() + "x" + card.getHeight();
    }
}