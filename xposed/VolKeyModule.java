package com.air.skipmodule;

import android.view.KeyEvent;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/**
 * Xposed 模块：hook system_server 的按键分发，双击音量键切换答案助手开关。
 *
 * 为什么放 system_server：
 *   实测 HyperOS 上音量键事件不派发给 AccessibilityService.onKeyEvent，
 *   getevent/sendevent 也抓不到 —— 事件被 PhoneWindowManager 在 system_server
 *   里消费。只有 hook 这里才能可靠拿到按键。
 *
 * 手势：
 *   Vol+ 双击 → 广播 com.air.mpprobe.TOGGLE {which=overlay}
 *   Vol- 双击 → 广播 ... {which=app}
 *   单击不拦截（正常调音量），双击窗口 500ms，触发后静默 600ms。
 *
 * 跨进程：system_server 发显式广播到 com.air.mpprobe，app 端 ToggleReceiver
 *   收到后改内存状态 + 回写 flag 文件（避免 system_server 直接写 app 私有目录
 *   被 SELinux 拒）。
 *
 * scope 必须包含 "android"（system_server 的包名）。
 */
public class VolKeyModule implements IXposedHookLoadPackage {

    private static final String TAG = "[VolKey]";
    private static final String TARGET_APP = "com.air.mpprobe";
    private static final String ACTION = "com.air.mpprobe.TOGGLE";
    private static final String SECRET = "cx-helper-2026-toggle";

    private static final long DOUBLE_MS = 500;
    private static final long COOLDOWN_MS = 600;

    /**
     * 去重窗口：同一物理按键会先后经过 interceptKeyBeforeQueueing 和
     * interceptKeyBeforeDispatching 两个 hook，一次按下被 onKey() 处理两次。
     *
     * 后果（实测 2026-11-25）：第 1 次进 onKey 时 lastUp 还是 0，now-0 是个极大值
     * → isDouble=false，但 lastUp 已被写成 now；第 2 次进来 now-lastUp≈0
     * → isDouble=true，于是**每次单击都被判成双击**。
     *
     * 用「同一 keyCode + 同一 action + 极短间隔」判定为同一次物理按键，只处理第一次。
     * 30ms 足够覆盖两个 hook 之间的调用间隔（实测 <5ms），又远小于人手连按的
     * 最短间隔（约 100ms），不会误合并两次真实按键。
     */
    private static final long DEDUP_MS = 30;

    private static long lastUp = 0;
    private static long lastDown = 0;
    /** 冷却按 keyCode 分开：原来共享一个 lastFire，导致 Vol+ 会吃掉紧接的 Vol- */
    private static long lastFireUp = 0;
    private static long lastFireDown = 0;
    /**
     * 同一次物理按键的标识：KeyEvent.getDownTime()。
     *
     * 为什么不用时间窗口：实测同一次按下会先后经过 interceptKeyBeforeQueueing
     * 和 interceptKeyBeforeDispatching 两个 hook，两者相隔约 140ms、跑在不同线程。
     * 30ms 的窗口挡不住，放宽到 200ms 又会把真实连按（人手最快约 100ms）吞掉。
     * downTime 是事件自带的，同一次按下必然相同，是唯一可靠标识。
     */
    private static long lastDownTime = 0;

    @Override
    public void handleLoadPackage(final XC_LoadPackage.LoadPackageParam lpparam) {
        // system_server 的 packageName：LSPosed 里通常报 "android"，
        // 部分版本/ROM 报 "system"，两者都接受
        if (!"android".equals(lpparam.packageName)
                && !"system".equals(lpparam.packageName)) return;
        XposedBridge.log(TAG + " loaded in " + lpparam.packageName + " (system_server)");

        try {
            Class<?> pwm = null;
            // PhoneWindowManager 在 boot classpath，可能在 lpparam.classLoader 也可能在 bootstrap
            try {
                pwm = Class.forName("com.android.server.policy.PhoneWindowManager",
                        true, lpparam.classLoader);
            } catch (Throwable ignored) {
                pwm = Class.forName("com.android.server.policy.PhoneWindowManager", true, null);
            }

            // 两个入口都 hook：不同 Android 版本事件经过的方法不同，
            // 从参数里找 KeyEvent，找不到就跳过，互不干扰。
            hookKeyMethod(pwm, "interceptKeyBeforeQueueing");
            hookKeyMethod(pwm, "interceptKeyBeforeDispatching");
            XposedBridge.log(TAG + " hooks installed");
        } catch (Throwable t) {
            XposedBridge.log(TAG + " setup err: " + t);
        }
    }

    private static void hookKeyMethod(Class<?> pwm, final String name) {
        try {
            XposedBridge.hookAllMethods(pwm, name, new XC_MethodHook() {
                @Override protected void beforeHookedMethod(MethodHookParam p) {
                    try {
                        KeyEvent e = findKeyEvent(p.args);
                        if (e != null) onKey(e, name);
                    } catch (Throwable ignored) {}
                }
            });
            XposedBridge.log(TAG + " hooked " + name);
        } catch (Throwable t) {
            XposedBridge.log(TAG + " hook " + name + " err: " + t);
        }
    }

    private static KeyEvent findKeyEvent(Object[] args) {
        if (args == null) return null;
        for (Object a : args) {
            if (a instanceof KeyEvent) return (KeyEvent) a;
        }
        return null;
    }

    private static void onKey(KeyEvent e, String hookName) {
        int code = e.getKeyCode();
        if (code != KeyEvent.KEYCODE_VOLUME_UP && code != KeyEvent.KEYCODE_VOLUME_DOWN) return;
        if (e.getAction() != KeyEvent.ACTION_DOWN) return;
        // 长按 repeat 不触发
        try {
            if (e.getRepeatCount() > 0) return;
        } catch (Throwable ignored) {}

        long now = System.currentTimeMillis();
        long downTime = e.getDownTime();

        // ① 用 downTime 去重 —— 同一次物理按键的可靠标识。
        //    实测：同一次按下会先后经过 interceptKeyBeforeQueueing 和
        //    interceptKeyBeforeDispatching，两者相隔约 140ms 且在不同线程，
        //    靠时间窗口去重（30ms）完全挡不住，只能靠事件自带的 downTime。
        if (downTime == lastDownTime) return;
        lastDownTime = downTime;

        // ② 冷却按 keyCode 分开，避免 Vol+ 触发后把紧接着的 Vol- 吃掉。
        //    原来 lastFire 是共享的，实测按 Vol+ 后 300ms 内按 Vol- 完全无反应。
        long lastFireThisKey = code == KeyEvent.KEYCODE_VOLUME_UP ? lastFireUp : lastFireDown;
        if (now - lastFireThisKey < COOLDOWN_MS) return;

        boolean isDouble;
        if (code == KeyEvent.KEYCODE_VOLUME_UP) {
            isDouble = now - lastUp <= DOUBLE_MS;
            lastUp = now;
        } else {
            isDouble = now - lastDown <= DOUBLE_MS;
            lastDown = now;
        }
        if (!isDouble) return;

        if (code == KeyEvent.KEYCODE_VOLUME_UP) lastFireUp = now; else lastFireDown = now;

        String which = code == KeyEvent.KEYCODE_VOLUME_UP ? "overlay" : "app";
        XposedBridge.log(TAG + " double " + (code == KeyEvent.KEYCODE_VOLUME_UP ? "UP" : "DOWN")
                + " -> toggle " + which);
        sendBroadcast(which);
    }

    /** system_server 发广播到答案 app */
    private static void sendBroadcast(String which) {
        try {
            android.content.Context ctx = getSystemContext();
            if (ctx == null) { XposedBridge.log(TAG + " no system context"); return; }
            android.content.Intent i = new android.content.Intent(ACTION);
            i.setPackage(TARGET_APP);
            i.putExtra("secret", SECRET);
            i.putExtra("which", which);
            i.addFlags(android.content.Intent.FLAG_RECEIVER_FOREGROUND);
            ctx.sendBroadcast(i);
            XposedBridge.log(TAG + " broadcast sent: " + which);
        } catch (Throwable t) {
            XposedBridge.log(TAG + " broadcast err: " + t);
        }
    }

    /** 拿 system_server 的 Context（多种反射路径，任一成功即可） */
    private static android.content.Context getSystemContext() {
        try {
            // ActivityManager.getService() 是 @hide API，android.jar 里没有，反射调用
            java.lang.reflect.Method gs = android.app.ActivityManager.class
                    .getDeclaredMethod("getService");
            gs.setAccessible(true);
            Object am = gs.invoke(null);
            if (am != null) {
                java.lang.reflect.Field f = findField(am.getClass(), "mContext");
                if (f != null) {
                    f.setAccessible(true);
                    Object c = f.get(am);
                    if (c instanceof android.content.Context) return (android.content.Context) c;
                }
            }
        } catch (Throwable ignored) {}
        try {
            java.lang.reflect.Method m = Class.forName("android.app.ActivityThread")
                    .getDeclaredMethod("currentApplication");
            m.setAccessible(true);
            Object app = m.invoke(null);
            if (app instanceof android.content.Context) return (android.content.Context) app;
        } catch (Throwable ignored) {}
        try {
            java.lang.reflect.Field f = Class.forName("android.app.ActivityThread")
                    .getDeclaredField("sCurrentActivityThread");
            f.setAccessible(true);
            Object at = f.get(null);
            java.lang.reflect.Field fc = at.getClass().getDeclaredField("mSystemContext");
            fc.setAccessible(true);
            Object c = fc.get(at);
            if (c instanceof android.content.Context) return (android.content.Context) c;
        } catch (Throwable ignored) {}
        return null;
    }

    private static java.lang.reflect.Field findField(Class<?> c, String name) {
        Class<?> cur = c;
        while (cur != null) {
            try { return cur.getDeclaredField(name); } catch (Throwable ignored) {}
            cur = cur.getSuperclass();
        }
        return null;
    }
}
