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
    /**
     * 文字黑描边半径。
     *
     * 背景现在完全透明（#00000000），描边是唯一的可读性来源，所以给到 8。
     * 演进：2.5（10% 背板时，糊）→ 6（55% 背板时，够）→ 8（全透明，需要更厚）。
     * 白字 + 8px 黑边在任何底色（浅色题面/深色夜间模式/彩色图片）上都能读，
     * 且不产生任何色块遮挡 —— 这就是"背景透明"和"文字可读"能同时成立的原因。
     */
    private static final float OUTLINE_R = 8f;
    // 窗口高度上限：短答案自动包内容（WRAP），超长答案封顶后内部自动滚动
    private static final int MAX_ANSWER_HEIGHT = 480;
    /** 空态答案区最小高度（dp）：保证浮层挂上时是一块看得见的实体，不是一条线 */
    private static final int EMPTY_MIN_H = 56;
    /** 空态提示文案：自解释，用户一眼看出「在，只是还没读到题」 */
    private static final String EMPTY_HINT = "等待读题…\n长按音量减 2 秒立即识别";

    // 自动滚动参数：浮层 NOT_TOUCHABLE，用户拖不了，超长答案只能自己滚
    private static final int SCROLL_TICK_MS = 16;      // ~60fps
    private static final int SCROLL_STEP_PX = 6;       // 每帧滚 6px ≈ 4.3 行/秒
    private static final int PAUSE_AT_END_MS = 1800;   // 滚到底停一会
    private static final int PAUSE_AT_TOP_MS = 2500;   // 回顶停一会再滚

    private final Context ctx;
    private final WindowManager wm;
    private final Handler h = new Handler(Looper.getMainLooper());

    private LinearLayout card;
    // 用 TextView + setShadowLayer。试过自绘 OutlineTextView（Paint.Style.STROKE
    // 描边 + FILL 填字），在 TYPE_ACCESSIBILITY_OVERLAY 窗口里文字完全不显示
    // （真机截图 ov5/ov6.png：边框在、文字区一片空白），所以退回 TextView。
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
            // padV 从 8 加到 14：真机截图里状态行「a11y 已连接」紧贴卡片下沿，
            // 看起来像被切掉。上下各留 14dp 才像一张完整的卡。
            int padH = dp(14), padV = dp(14);
            card.setPadding(padH, padV, padH, padV);
            paintCard();

            metaView = new TextView(ctx);
            metaView.setText("答案助手 · 等待题目");
            metaView.setTextColor(Color.parseColor("#EEFFFFFF"));
            metaView.setTextSize(TypedValue.COMPLEX_UNIT_SP, META_SP);
            metaView.setSingleLine(true);
            metaView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);

            answerView = new TextView(ctx);
            // 空态文案要自解释：用户看到它就知道「浮层在，只是还没读到题」，
            // 而不是「这东西坏了」。配合下面的实心深色背板一起看。
            answerView.setText(EMPTY_HINT);
            answerView.setTextColor(Color.WHITE);
            answerView.setTextSize(TypedValue.COMPLEX_UNIT_SP, ANSWER_SP);
            answerView.setGravity(android.view.Gravity.CENTER);
            answerView.setLineSpacing(dp(2), 1f);
            // 空态最小高度：窗口是 WRAP_CONTENT，若只有两行 10sp 小字，
            // 整张卡会缩成一条 40px 的细线（真机实测：挂在天气组件里，
            // 用户完全看不出这是个浮层）。给答案区一个下限，空态就有实体。
            answerView.setMinHeight(dp(48));
            // 不再硬限行数：长简答要能整段显示出来。
            // 上界由窗口高度兜（见 relayout），超出才出现滚动。
            answerView.setMovementMethod(new ScrollingMovementMethod());
            answerView.setVerticalScrollBarEnabled(true);
            // 背景透明后靠这层黑晕把字从底下题面里"抠"出来
            answerView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);
            // 长答案封顶：超出 MAX_ANSWER_HEIGHT 后内部滚动，不撑爆全屏
            answerView.setMaxHeight(dp(MAX_ANSWER_HEIGHT));

            statusView = new TextView(ctx);
            statusView.setText("a11y 已连接");
            statusView.setTextColor(Color.parseColor("#CCFFFFFF"));
            statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, META_SP);
            statusView.setSingleLine(true);
            statusView.setShadowLayer(OUTLINE_R, 0f, 0f, Color.BLACK);

            card.addView(metaView);
            // 空态给一个实心高度：窗口是 WRAP_CONTENT，如果答案区只有一行文字，
            // 整张卡就缩成一条细线（真机实测：900x40 挂在天气组件里，
            // 用户看到的只是「弹窗已打开」那行小字，以为浮层没出来）。
            // 显式指定高度而非 setMinHeight —— 后者在 WRAP_CONTENT 的
            // LayoutParams 下不保证生效，实测确实没生效。
            //
            // 上下各留 6dp 外边距：真机截图里 meta「题库缓存·单选·3127ms」和
            // 答案首行、答案末行和 status「a11y 已连接」都贴在一起，
            // 三层文字糊成一块，分不清哪行是答案。
            LinearLayout.LayoutParams ansLp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    dp(EMPTY_MIN_H));
            ansLp.topMargin = dp(6);
            ansLp.bottomMargin = dp(6);
            card.addView(answerView, ansLp);
            card.addView(statusView);

            WindowManager.LayoutParams lp = buildParams(cardWidth(),
                    WindowManager.LayoutParams.WRAP_CONTENT);
            wm.addView(card, lp);
            attached = true;
            // 挂载成功必须留痕：真机排查「弹窗不出来」时，dumpsys window 能看到
            // 窗口但用户看不到（背板近透明），日志里却什么都没有，无从判断
            // 是没挂上还是挂上了不可见。这条把两者分开。
            android.util.Log.i("AnswerOverlay", "OVERLAY[attached] "
                    + lp.width + "x" + lp.height + " y=" + lp.y + " type=" + lp.type);
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
        // y 位置演进：
        //   200 → 压在「答题进度 05/20」那一行上，叠印
        //   260 → 避开进度条，但正好盖住 A 选项。背景透明后这不是"遮挡"而是
        //         "叠印"：浮层的答案文字和底下 A 选项的正文几乎同一位置、
        //         同一内容（因为答案本来就是 A 选项的原文），看起来像重影，
        //         用户会以为显示坏了（真机截图 ov7.png）。
        //   现在用 BOTTOM 贴底：答题页底部通常是「保存/提交/下一题」按钮区，
        //   题面和选项在中间 —— 浮层贴底就不会和任何选项正文重叠。
        lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        lp.y = dp(96);
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

            // 空答案必须保持空态（实心背板 + 固定高度 + 自解释文案）。
            // 之前这里写 answerView.setText("…")，结果：paintCard 认为"有答案"
            // 切成近透明背板、高度重置成 WRAP_CONTENT，整张卡塌成一条 100px
            // 的细线（真机截图：只剩「…」和状态行浮在天气组件上）。
            // 空答案 = 没答案可显示，就该留在空态。
            boolean hasAnswer = m.answer != null && m.answer.trim().length() > 0
                    && !"…".equals(m.answer.trim());
            if (hasAnswer) {
                answerView.setText(m.answer);
                answerView.setGravity(android.view.Gravity.START);
                setAnswerHeight(android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
            } else {
                answerView.setText(EMPTY_HINT);
                answerView.setGravity(android.view.Gravity.CENTER);
                setAnswerHeight(dp(EMPTY_MIN_H));
            }
            paintCard();
            scheduleAutoScroll(hasAnswer ? m.answer : null);

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

    /**
     * 改答案区高度。
     *
     * 为什么不能只靠 setMinHeight：窗口 LayoutParams 是 WRAP_CONTENT，
     * 高度由内容测量决定，minHeight 在实测里没拦住塌缩（浮层变成 900x40
     * 一条细线）。显式改 LayoutParams.height 才能保证空态有实体高度。
     */
    private void setAnswerHeight(int h) {
        if (answerView == null) return;
        android.view.ViewGroup.LayoutParams lp = answerView.getLayoutParams();
        if (lp == null) return;
        if (lp.height == h) return;
        lp.height = h;
        answerView.setLayoutParams(lp);
    }

    /** 宽度按题型：简答要宽、判断可窄；高度交给内容自适应（WRAP），长答案封顶滚动 */
    private void relayout(String type) {        int w = cardWidth(type);
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

    /**
     * 背板：两档不透明度，但**都必须能读清文字**。
     *
     * 历史（真机两次踩坑）：
     *   1. 最初统一用 #1AE0E0E0（alpha=26/255，约 10%）。空态时整张卡只剩两行
     *      10sp 小字浮在任意背景上，浅色桌面上完全看不出来 —— 用户以为「弹窗
     *      没出来」，其实是出来了。于是空态改成深色实心 + 亮边。
     *   2. 有答案后仍保留 10% 近透明，理由是「不遮题面」。但这是自相矛盾的：
     *      答案必然覆盖题面，10% 背板下答案文字和底下的「答题进度 05/20」
     *      直接叠印在一起（2026-11-25 真机截图，答案和进度数字糊成一团）。
     *      浮层的唯一职责是让用户看清答案，不是透视题面。
     *
     * 现在：背景 22% 深色（几乎透明）+ 6px 黑晕，文字可读且题面可透视。
     *
     * 演进过程（四次真机截图，别再来回改）：
     *   1. 10% 半透明 + 2.5px 阴影 → 失败。答案白字与底下题干黑字叠印成乱码。
     *   2. 完全不透明 → 可读，但把题面遮死，用户看不到自己在选哪个选项。
     *   3. 55% 半透明 + 6px 阴影 → 仍有重影：「A 第一次握手…」白字和黑字
     *      同时出现两遍，因为深色块 + 白字 + 底下黑字是三层叠印。
     *   4. 全透明 #00000000 + 6px 阴影 → 白字变虚影，浅色页面上几乎看不清。
     *   5. 自绘 OutlineTextView（STROKE 描边）→ 文字完全不显示（overlay 窗口
     *      里自绘 Paint 风格切换不生效）。
     *   6. 现在：22% 深色（#38181B22）+ 6px 黑晕。
     *      22% 足够把白字底下那层"黑字轮廓"压淡，又几乎不遮挡题面 ——
     *      截图验证：能同时读清答案和底下 A/B/C/D 四个选项。
     *
     * 这个值不能随便调：<15% 白字开始和题面叠印，>35% 题面明显变暗。
     */
    private void paintCard() {
        boolean empty = answerView == null || answerView.getText().length() == 0
                || answerView.getText().toString().startsWith("等待读题");
        GradientDrawable g = new GradientDrawable();
        // 22% 深色：够压住底下的黑字，又不遮挡题面
        g.setColor(Color.parseColor("#38181B22"));
        if (empty) {
            // 空态：只留蓝边，表示"在工作但还没读到"
            g.setStroke(dp(2), Color.parseColor("#FF4FC3F7"));
        } else {
            // 有答案：灰边定出卡片范围
            g.setStroke(dp(2), Color.parseColor("#FF7A8899"));
        }
        g.setCornerRadius(dp(14));
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