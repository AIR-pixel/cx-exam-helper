package com.air.mpprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * ToggleStore —— 两个独立开关的持久化 + 状态广播。
 *
 *   overlayOn : 只控制浮层显隐；读题/作答照常进行（"先别挡着我，但继续答"）
 *   appOn     : 总开关；关掉后 onAccessibilityEvent 直接 return，浮层也隐藏
 *
 * 状态双写：
 *   - SharedPreferences（App 自己读，速度快）
 *   - /data/data/com.air.mpprobe/files/{overlay,app}.flag（root 脚本/音量键 daemon 可改）
 *   flag 文件用 "1"/"0"，和 SKIP 模块那套 flag 同目录同风格。
 *
 * 注意：flag 文件只是"外部可写的镜像"，App 内部以 SP 为准；
 * 外部改 flag 后需 force-stop 重绑服务才生效（和 SKIP 一致），
 * 音量键双击路径直接改内存状态并回写两边，即时生效。
 */
public final class ToggleStore {
    private static final String TAG = "AnsToggle";
    private static final String SP_NAME = "toggle";
    private static final String K_OVERLAY = "overlayOn";
    private static final String K_APP = "appOn";
    private static final String K_TREEDUMP = "treeDumpOn";
    private static final String FLAG_DIR = "/data/data/com.air.mpprobe/files";

    private static SharedPreferences sp;
    private static volatile boolean overlayOn = true;
    private static volatile boolean appOn = true;
    private static volatile boolean treeDumpOn = false;

    public static void init(Context c) {
        if (sp != null) return;
        sp = c.getApplicationContext().getSharedPreferences(SP_NAME, Context.MODE_PRIVATE);
        overlayOn = sp.getBoolean(K_OVERLAY, true);
        appOn = sp.getBoolean(K_APP, true);
        treeDumpOn = sp.getBoolean(K_TREEDUMP, false);
        // 若 flag 文件存在，以文件为准（方便 root 脚本预设开机状态）
        Boolean o = readFlag("overlay.flag");
        Boolean a = readFlag("app.flag");
        Boolean d = readFlag("treedump.flag");
        if (o != null) overlayOn = o;
        if (a != null) appOn = a;
        if (d != null) treeDumpOn = d;
        writeAll();
        Log.d(TAG, "init overlay=" + overlayOn + " app=" + appOn + " treeDump=" + treeDumpOn);
    }

    public static boolean overlayOn() { return overlayOn; }
    public static boolean appOn() { return appOn; }
    /** 诊断开关：图片题拿不到 targetUrl 时打开，把整棵 a11y 树打进日志 */
    public static boolean treeDumpOn() { return treeDumpOn; }

    public static boolean toggleTreeDump() {
        treeDumpOn = !treeDumpOn;
        persist();
        Log.d(TAG, "treeDump -> " + treeDumpOn);
        return treeDumpOn;
    }

    public static boolean toggleOverlay() {
        overlayOn = !overlayOn;
        persist();
        Log.d(TAG, "overlay -> " + overlayOn);
        return overlayOn;
    }

    public static boolean toggleApp() {
        appOn = !appOn;
        persist();
        Log.d(TAG, "app -> " + appOn);
        return appOn;
    }

    private static void persist() {
        if (sp != null) sp.edit()
                .putBoolean(K_OVERLAY, overlayOn)
                .putBoolean(K_APP, appOn)
                .putBoolean(K_TREEDUMP, treeDumpOn)
                .apply();
        writeAll();
    }

    private static void writeAll() {
        writeFlag("overlay.flag", overlayOn);
        writeFlag("app.flag", appOn);
        writeFlag("treedump.flag", treeDumpOn);
    }

    private static Boolean readFlag(String name) {
        try {
            byte[] b = readFile(new File(FLAG_DIR, name));
            String s = new String(b, StandardCharsets.UTF_8).trim();
            if ("0".equals(s)) return Boolean.FALSE;
            if ("1".equals(s)) return Boolean.TRUE;
        } catch (Throwable ignored) {}
        return null;
    }

    private static void writeFlag(String name, boolean on) {
        try {
            File dir = new File(FLAG_DIR);
            if (!dir.exists()) dir.mkdirs();
            try (FileOutputStream fos = new FileOutputStream(new File(dir, name), false)) {
                fos.write((on ? "1" : "0").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable t) {
            Log.w(TAG, "writeFlag " + name + " failed: " + t.getMessage());
        }
    }

    private static byte[] readFile(File f) throws IOException {
        if (!f.exists()) throw new IOException("missing");
        int n = (int) f.length();
        byte[] b = new byte[Math.max(n, 1)];
        java.io.FileInputStream fis = new java.io.FileInputStream(f);
        try {
            int off = 0;
            while (off < b.length) {
                int r = fis.read(b, off, b.length - off);
                if (r < 0) break;
                off += r;
            }
            return b;
        } finally { fis.close(); }
    }

    private ToggleStore() {}
}
