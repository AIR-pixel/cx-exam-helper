package com.air.mpprobe;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Bus —— ReaderService ↔ 叠层 Activity 的进程内静态总线。
 *
 * v2 起带上了 source / type / ms：
 *   source 决定叠层配色（qoder=绿、cache=灰、none/error=红）
 *   type   决定叠层宽度（简答题要更宽）
 * 另加 setListener 时的「立即回放当前值」语义，避免叠层后启动错过已到达的答案。
 */
public final class Bus {

    /** 一次完整答案 */
    public static final class Msg {
        public final String question;
        public final String answer;
        public final String source;   // qoder | cache | heuristic | none | error
        public final String type;      // single | multi | judge | blank | short | ""
        public final long ms;
        public final long at;

        Msg(String q, String a, String s, String t, long ms) {
            this.question = q == null ? "" : q;
            this.answer = a == null ? "" : a;
            this.source = s == null ? "" : s;
            this.type = t == null ? "" : t;
            this.ms = ms;
            this.at = System.currentTimeMillis();
        }
    }

    public interface Listener {
        void onUpdate(Msg m);
        void onStatus(String text, String kind);
    }

    private static volatile Msg last = new Msg("", "", "", "", 0);
    private static volatile String status = "初始化中…";
    private static volatile String statusKind = "off";

    private static final List<Listener> listeners = new CopyOnWriteArrayList<>();

    public static synchronized void setListener(Listener l) {
        if (l != null && !listeners.contains(l)) listeners.add(l);
    }

    public static synchronized void removeListener(Listener l) {
        if (l != null) listeners.remove(l);
    }

    public static Msg last() { return last; }
    public static String status() { return status; }
    public static String statusKind() { return statusKind; }

    /** 一条答案到达（带题目原文 + 来源 + 题型） */
    public static void publishV2(String question, String answer, String source, String type, long ms) {
        Msg m = new Msg(question, answer, source, type, ms);
        last = m;
        for (Listener l : listeners) {
            try { l.onUpdate(m); } catch (Throwable ignored) {}
        }
    }

    /** 状态行（a11y 连接/断开/错误） */
    public static void publishStatus(String text, String kind) {
        status = text == null ? "" : text;
        statusKind = kind == null ? "" : kind;
        for (Listener l : listeners) {
            try { l.onStatus(status, statusKind); } catch (Throwable ignored) {}
        }
    }

    // ── v1 兼容：旧叠层代码还在用这两个 ──
    public static String question() { return last.question; }
    public static String answer() { return last.answer; }
    public static long updatedAt() { return last.at; }

    private Bus() {}
}