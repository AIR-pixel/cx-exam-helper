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

    /** 触发后静默，防连发 */
    private static final long COOLDOWN_MS = 600;
    /** 短按派发窗口：最后一次松手后等这么久才判定单击/双击/三击 */
    private static final long TAP_WINDOW_MS = 500;
    /** 双击窗口（Vol+ 专用，Vol- 用 TAP_WINDOW_MS 计数器） */
    private static final long DOUBLE_MS = 500;
    /** 长按阈值：按住超过这个时长（且未松手）即触发主动识别 */
    private static final long LONG_PRESS_MS = 2000;

    private static long lastUp = 0;
    /** Vol- 触发冷却（与 Vol+ 的 lastFireUp 互不干扰） */
    private static long lastFireDown = 0;
    private static long lastFireUp = 0;
    /**
     * 同一次物理按键的标识：KeyEvent.getDownTime()。
     *
     * 为什么不用时间窗口：实测同一次按下会先后经过 interceptKeyBeforeQueueing
     * 和 interceptKeyBeforeDispatching 两个 hook，两者相隔约 140ms、跑在不同线程。
     * 30ms 的窗口挡不住，放宽到 200ms 又会把真实连按（人手最快约 100ms）吞掉。
     * downTime 是事件自带的，同一次按下必然相同，是唯一可靠标识。
     */
    private static long lastDownTime = 0;
    /** UP 事件的 downTime 去重（与 lastDownTime 分开，两者 downTime 相同但 action 不同） */
    private static long lastUpDownTime = 0;

    // ───────────────────── 长按状态（Vol- 专用） ─────────────────────

    /** 当前 Vol- 是否处于「按住中」 */
    private static boolean volDownHeld = false;
    /** 本次按住是否已经触发过长按（触发后松手不再算单击） */
    private static boolean volDownLongFired = false;
    /** 长按定时器代号：每次按下 ++，旧定时器醒来发现代号变了就退出 */
    private static int volDownHoldGen = 0;
    /** 按下瞬间的音量，用于长按触发后回滚 */
    private static int volDownSavedVolume = -1;

    /**
     * 长按/三击的定时器 Handler，懒初始化。
     *
     * 为什么不能写成 static final 直接 new：
     *   实测 LSPosed 在 <clinit> 阶段抛异常 → "Failed to load class
     *   com.air.skipmodule.VolKeyModule at VolKeyModule.<clinit>(VolKeyModule.java:72)"
     *   → 整个模块加载失败，音量键完全不工作。
     *   <clinit> 里做系统服务调用风险太高（Looper 可能未就绪、classloader 差异）。
     *   改成首次用时才创建，异常也被 try 吞掉，不会连累类加载。
     */
    private static android.os.Handler H;

    private static android.os.Handler handler() {
        android.os.Handler h = H;
        if (h != null) return h;
        synchronized (VolKeyModule.class) {
            if (H == null) {
                try {
                    H = new android.os.Handler(android.os.Looper.getMainLooper());
                } catch (Throwable t) {
                    XposedBridge.log(TAG + " handler init err: " + t);
                    return null;
                }
            }
            return H;
        }
    }

    private static void postDelayed(Runnable r, long ms) {
        android.os.Handler h = handler();
        if (h == null) return;
        try { h.postDelayed(r, ms); } catch (Throwable t) {
            XposedBridge.log(TAG + " postDelayed err: " + t);
        }
    }

    private static void removeCallbacks(Runnable r) {
        android.os.Handler h = handler();
        if (h == null) return;
        try { h.removeCallbacks(r); } catch (Throwable ignored) {}
    }

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

        int action = e.getAction();
        long downTime = e.getDownTime();

        // ① 用 downTime 去重 —— 同一次物理按键的可靠标识。
        //    实测：同一次按下会先后经过 interceptKeyBeforeQueueing 和
        //    interceptKeyBeforeDispatching，两者相隔约 140ms 且在不同线程，
        //    靠时间窗口去重完全挡不住，只能靠事件自带的 downTime。
        //    注意：DOWN 和 UP 的 downTime 相同（同一次按压），所以去重只在
        //    同 action 内生效，否则 UP 会被当成重复的 DOWN 丢掉。
        if (action == KeyEvent.ACTION_DOWN) {
            if (downTime == lastDownTime) return;
            lastDownTime = downTime;
        } else if (action == KeyEvent.ACTION_UP) {
            // UP 也必须去重，否则一次物理松手会被两个 hook 各算一次 tap，
            // 单击立刻变成双击（实测 tap #1 与 #2 相隔 3ms、线程不同）。
            // DOWN 和 UP 的 downTime 相同（同一次按压），所以不能共用 lastDownTime。
            if (downTime == lastUpDownTime) return;
            lastUpDownTime = downTime;
        }

        if (code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            onVolDown(e, action, downTime);
        } else {
            onVolUp(e, action);
        }
    }

    // ───────────────────────── Vol+ ─────────────────────────

    private static void onVolUp(KeyEvent e, int action) {
        if (action != KeyEvent.ACTION_DOWN) return;
        try {
            if (e.getRepeatCount() > 0) return;
        } catch (Throwable ignored) {}

        long now = System.currentTimeMillis();
        if (now - lastFireUp < COOLDOWN_MS) return;

        boolean isDouble = now - lastUp <= DOUBLE_MS;
        lastUp = now;
        if (!isDouble) return;

        lastFireUp = now;
        XposedBridge.log(TAG + " Vol+ x2 -> toggle overlay");
        sendBroadcast("overlay");
    }

    // ───────────────────────── Vol- ─────────────────────────

    /**
     * Vol- 手势：
     *   按住 ≥2s        → 主动识别当前页（which=scan）
     *   单击            → 不拦截，正常调音量
     *   双击            → 退出弹窗（which=overlay）
     *   三击            → 总开关（which=app）
     *
     * 为什么要等一个窗口才派发：
     *   按完第二下时无法知道用户还会不会按第三下。要么双击立即触发（那三击
     *   永远不可能实现），要么等 TAP_WINDOW_MS。选后者 —— 双击晚 500ms 生效，
     *   用户几乎感觉不到，但三击得以成立。
     *
     * 为什么用计数器而不是「上次时刻」：
     *   原来靠 now-lastDown / now-lastTripleBase 两层时间差判断，状态互相污染，
     *   实测单击会被判成双击。计数器只有一个变量，每按一下 +1，定时器醒来按
     *   最终值派发，逻辑无歧义。
     */
    private static void onVolDown(KeyEvent e, int action, long downTime) {
        long now = System.currentTimeMillis();

        if (action == KeyEvent.ACTION_DOWN) {
            int repeat = 0;
            try { repeat = e.getRepeatCount(); } catch (Throwable ignored) {}

            if (repeat == 0) {
                // 新的按下：起长按定时器
                volDownHeld = true;
                volDownLongFired = false;
                final int gen = ++volDownHoldGen;
                // 记下当前音量，长按触发后回滚（否则按 2 秒音量会掉到静音）
                if (volDownTapCount == 0) volDownSavedVolume = readMusicVolume();

                postDelayed(new Runnable() { public void run() {
                    if (gen != volDownHoldGen) return;      // 已被后续按下取代
                    if (!volDownHeld) return;               // 已松手
                    if (volDownLongFired) return;
                    volDownLongFired = true;
                    onLongPress();
                } }, LONG_PRESS_MS);
            }
            // repeat 事件说明还按着，定时器在跑，什么都不做
            return;
        }

        if (action != KeyEvent.ACTION_UP) return;

        boolean longFired = volDownLongFired;
        volDownHeld = false;
        volDownHoldGen++;          // 作废还没跑的长按定时器

        if (longFired) {
            // 长按已触发，这次松手不再计入单击/双击/三击
            volDownLongFired = false;
            volDownTapCount = 0;
            cancelTapDispatch();
            return;
        }

        if (now - lastFireDown < COOLDOWN_MS) return;

        // 计一次短按
        volDownTapCount++;
        XposedBridge.log(TAG + " Vol- tap #" + volDownTapCount);

        if (volDownTapCount >= 3) {
            // 三击：立即派发，不用再等
            cancelTapDispatch();
            volDownTapCount = 0;
            lastFireDown = now;
            XposedBridge.log(TAG + " Vol- x3 -> toggle app");
            sendBroadcast("app");
            return;
        }

        // 单击/双击：重排派发定时器（每多按一下就把窗口往后推）
        cancelTapDispatch();
        final int expected = volDownTapCount;
        tapDispatch = new Runnable() { public void run() {
            tapDispatch = null;
            int n = volDownTapCount;
            volDownTapCount = 0;
            if (n != expected) return;          // 期间又变了，交给新的定时器
            if (n == 1) {
                // 单击：不拦截，系统已经调过音量了
                return;
            }
            lastFireDown = System.currentTimeMillis();
            XposedBridge.log(TAG + " Vol- x2 -> toggle overlay");
            sendBroadcast("overlay");
        } };
        postDelayed(tapDispatch, TAP_WINDOW_MS);
    }

    /** Vol- 短按计数器：1=单击 2=双击 3=三击 */
    private static int volDownTapCount = 0;
    private static Runnable tapDispatch = null;

    private static void cancelTapDispatch() {
        if (tapDispatch != null) {
            removeCallbacks(tapDispatch);
            tapDispatch = null;
        }
    }

    private static void onLongPress() {
        XposedBridge.log(TAG + " Vol- long press -> scan current screen");
        // 先把音量恢复，否则用户按住 2 秒音量已经掉到底
        restoreMusicVolume();
        vibrate();
        sendBroadcast("scan");
    }

    // ─────────────────── 音量回滚 ───────────────────

    private static int readMusicVolume() {
        try {
            android.content.Context ctx = getSystemContext();
            if (ctx == null) return -1;
            android.media.AudioManager am =
                    (android.media.AudioManager) ctx.getSystemService(
                            android.content.Context.AUDIO_SERVICE);
            if (am == null) return -1;
            return am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
        } catch (Throwable t) {
            return -1;
        }
    }

    private static void restoreMusicVolume() {
        if (volDownSavedVolume < 0) return;
        try {
            android.content.Context ctx = getSystemContext();
            if (ctx == null) return;
            android.media.AudioManager am =
                    (android.media.AudioManager) ctx.getSystemService(
                            android.content.Context.AUDIO_SERVICE);
            if (am == null) return;
            am.setStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                    volDownSavedVolume, 0);
            XposedBridge.log(TAG + " volume restored to " + volDownSavedVolume);
        } catch (Throwable t) {
            XposedBridge.log(TAG + " volume restore err: " + t);
        }
    }

    // ─────────────────── 震动反馈 ───────────────────

    private static void vibrate() {
        try {
            android.content.Context ctx = getSystemContext();
            if (ctx == null) return;
            android.os.Vibrator v =
                    (android.os.Vibrator) ctx.getSystemService(
                            android.content.Context.VIBRATOR_SERVICE);
            if (v == null) return;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                v.vibrate(android.os.VibrationEffect.createOneShot(
                        40, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(40);
            }
        } catch (Throwable t) {
            XposedBridge.log(TAG + " vibrate err: " + t);
        }
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
