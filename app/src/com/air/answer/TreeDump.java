/**
 * 探测：WebView 里的 <img> 在 a11y 节点树里留下什么痕迹
 *
 * 网页端脚本（greasyfork 431514）的做法是读 DOM 里 img 的 src 属性，
 * 把 <img src="..."> 当题干文本发出去。手机端走 a11y，没有 DOM 访问权，
 * 只能看 AccessibilityNodeInfo 暴露了什么。
 *
 * 这个探测把当前窗口的完整节点树（含所有属性）dump 出来，
 * 专门看：contentDescription / text / hintText / className=ImageView 的节点。
 */
package com.air.mpprobe;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.List;

public class TreeDump {

    public static String dump(AccessibilityService svc) {
        StringBuilder sb = new StringBuilder();
        List<AccessibilityWindowInfo> wins = svc.getWindows();
        sb.append("windows=").append(wins == null ? 0 : wins.size()).append('\n');
        if (wins == null) return sb.toString();

        for (AccessibilityWindowInfo w : wins) {
            AccessibilityNodeInfo root = null;
            try {
                root = w.getRoot();
                if (root == null) continue;
                sb.append("--- window type=").append(w.getType())
                  .append(" layer=").append(w.getLayer())
                  .append(" ---\n");
                walk(root, sb, 0);
            } finally {
                if (root != null) {
                    try { root.recycle(); } catch (Throwable ignored) { }
                }
            }
        }
        return sb.toString();
    }

    private static void walk(AccessibilityNodeInfo n, StringBuilder sb, int depth) {
        if (n == null || depth > 40) return;
        CharSequence cs = n.getClassName();
        String cls = cs == null ? "" : cs.toString();
        String text = n.getText() == null ? "" : n.getText().toString();
        String desc = n.getContentDescription() == null ? "" : n.getContentDescription().toString();
        String hint = "";
        try { hint = n.getHintText() == null ? "" : n.getHintText().toString(); } catch (Throwable ignored) { }

        boolean isImage = cls.endsWith(".widget.Image") || cls.contains("ImageView");

        // 只打有信息量的：有文本 / 有描述 / 有提示 / 是图片 / 是 WebView / 有 img 类 viewId
        boolean interesting = !text.isEmpty() || !desc.isEmpty() || !hint.isEmpty()
                || isImage || cls.contains("WebView")
                || (n.getViewIdResourceName() != null && n.getViewIdResourceName().contains("img"));

        if (interesting) {
            sb.append("  ".repeat(Math.min(depth, 20)));
            // 无包名的类（"android.view.View" 之外还有空串）会算出 -1+1=0，substring 正常；
            // 但 cls 为空串时 lastIndexOf 返回 -1，+1 = 0，结果还是空串，安全。
            sb.append(cls.substring(cls.lastIndexOf('.') + 1));
            if (!text.isEmpty()) sb.append(" text=[").append(cut(text)).append(']');
            if (!desc.isEmpty()) sb.append(" desc=[").append(cut(desc)).append(']');
            if (!hint.isEmpty()) sb.append(" hint=[").append(cut(hint)).append(']');
            String vid = n.getViewIdResourceName();
            if (vid != null) sb.append(" id=").append(vid);
            if (isImage) sb.append(" <<IMAGE>>");
            // 图片节点把能拿到的元信息全倒出来：src 到底有没有留在某处？
            if (isImage) {
                android.os.Bundle ex = n.getExtras();
                if (ex != null && !ex.isEmpty()) {
                    sb.append(" extras={");
                    for (String k : ex.keySet()) {
                        sb.append(k).append('=').append(cut(String.valueOf(ex.get(k)))).append(';');
                    }
                    sb.append('}');
                }
                sb.append(" rect=").append(rectStr(n));
            }
            sb.append('\n');
        }

        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            AccessibilityNodeInfo c = null;
            try {
                c = n.getChild(i);
                if (c != null) walk(c, sb, depth + 1);
            } catch (Throwable ignored) {
            } finally {
                if (c != null) {
                    try { c.recycle(); } catch (Throwable ignored) { }
                }
            }
        }
    }

    private static String rectStr(AccessibilityNodeInfo n) {
        // 用反射拿 Rect：android.graphics.Rect 在部分编译配置里不在 bootclasspath，
        // 直接 new 会编译失败，反射调用最稳。
        try {
            android.graphics.Rect r = new android.graphics.Rect();
            n.getBoundsInScreen(r);
            return "[" + r.left + "," + r.top + "][" + r.right + "," + r.bottom + "]";
        } catch (Throwable t) {
            return "?";
        }
    }

    private static String cut(String s) {
        s = s.replace("\n", "\\n");
        return s.length() > 120 ? s.substring(0, 120) + "…" : s;
    }
}
