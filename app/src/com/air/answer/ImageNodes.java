/**
 * 从 a11y 节点树里抽取图片信息。
 *
 * 关键发现（实测）：WebView 里 <img> 对应的 AccessibilityNodeInfo 是
 * className=android.widget.Image 的节点，它的 extras 里有
 *   AccessibilityNodeInfo.targetUrl = 图片地址
 * 以及 unclippedWidth/Height/Left/Right/Bottom 和 hint。
 *
 * 也就是说手机端能直接拿到图片 URL，不需要截屏 OCR。
 * 网页端脚本读的是 DOM 的 img.src；手机端 a11y 通过 targetUrl 给出同一信息。
 */
package com.air.mpprobe;

import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;

public final class ImageNodes {

    /** 一个图片节点的抽取结果 */
    public static final class Shot {
        public String url = "";      // targetUrl（可能是 data: 或 http(s):）
        public String desc = "";     // contentDescription（来自 alt）
        public int width, height;    // unclipped 尺寸
        public int left, top;

        public String toString() {
            return "url=" + shorten(url) + " desc=[" + desc + "] " + width + "x" + height;
        }

        private static String shorten(String s) {
            if (s == null) return "";
            return s.length() > 90 ? s.substring(0, 90) + "…" : s;
        }
    }

    /** 递归收集整棵树里所有带 targetUrl 或 desc 的图片节点 */
    public static List<Shot> collect(AccessibilityNodeInfo root) {
        List<Shot> out = new ArrayList<>();
        walk(root, out, 0);
        return out;
    }

    private static void walk(AccessibilityNodeInfo n, List<Shot> out, int depth) {
        if (n == null || depth > 40) return;

        String cls = String.valueOf(n.getClassName());
        // WebView 里 <img> 的节点类是 android.widget.Image（不是 ImageView）。
        // 只认这两个精确名，别用 contains("Image")——会把 ImageButton、
        // ImageSwitcher、FrameLayout 里带 Image 的都算进来。
        boolean isImage = cls.endsWith(".widget.Image")
                || cls.endsWith(".widget.ImageView")
                || cls.endsWith("ImageView");
        if (isImage) {
            Shot s = read(n);
            if (s != null) out.add(s);
        }

        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            // getChild 返回的节点由调用方负责 recycle；不回收会泄漏。
            // 这里 walk 完立刻 recycle，避免轮询场景下节点池被撑爆。
            AccessibilityNodeInfo c = null;
            try {
                c = n.getChild(i);
                if (c != null) walk(c, out, depth + 1);
            } catch (Throwable ignored) {
            } finally {
                if (c != null) {
                    try { c.recycle(); } catch (Throwable ignored) { }
                }
            }
        }
    }

    /** 读一个图片节点的元信息；没有 url 也没有 desc 就返回 null（状态栏图标之类） */
    private static Shot read(AccessibilityNodeInfo n) {
        Shot s = new Shot();
        try {
            CharSequence d = n.getContentDescription();
            if (d != null) s.desc = d.toString();
        } catch (Throwable ignored) { }

        try {
            Bundle ex = n.getExtras();
            if (ex != null) {
                Object u = ex.get("AccessibilityNodeInfo.targetUrl");
                if (u != null) s.url = String.valueOf(u);
                s.width = intOf(ex, "AccessibilityNodeInfo.unclippedWidth");
                s.height = intOf(ex, "AccessibilityNodeInfo.unclippedHeight");
                s.left = intOf(ex, "AccessibilityNodeInfo.unclippedLeft");
                s.top = intOf(ex, "AccessibilityNodeInfo.unclippedTop");
            }
        } catch (Throwable ignored) { }

        if (s.url.isEmpty() && s.desc.isEmpty()) return null;
        // 状态栏小图标：没有 url、尺寸很小，丢掉。
        // width=0 说明节点没上报尺寸（不是「很小」），不能按小图标处理。
        if (s.url.isEmpty() && s.width > 0 && s.width < 80) return null;
        return s;
    }

    private static int intOf(Bundle b, String k) {
        try {
            Object v = b.get(k);
            return v instanceof Integer ? (Integer) v : 0;
        } catch (Throwable t) {
            return 0;
        }
    }

    private ImageNodes() { }
}
