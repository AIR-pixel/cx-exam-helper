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
 *   Vol+ 单击    → 浮层存在时：立即识别当前屏（which=fast，视觉+快模型 4~5s）
 *                  浮层不存在：完全放行，正常调音量
 *   Vol- 双击    → 广播 ... {which=overlay}  浮层显隐（读题/作答继续）
 *   Vol- 三击    → 广播 ... {which=app}      总开关（读题/浮层全停）
 *   Vol- 按住 2s → 广播 ... {which=scan}     主动识别当前屏一次（旧入口，保留）
 *   触发后静默 600ms。
 *
 * Vol+ 单击为什么要看浮层状态：
 *   Vol+ 单击是最常用的调音量动作，无条件拦截会让音量没法加。
 *   而「浮层开着」= 用户明确在用这个工具，此时 Vol+ 才属于工具；
 *   浮层关掉 = 工具不在场，Vol+ 就该是普通音量键。
 *   这个判据自解释，用户不需要记「什么时候按一下有效」。
 *
 * 跨进程：system_server 发显式广播到 com.air.mpprobe，app 端 ToggleReceiver
 *   收到后改内存状态 + 回写 flag 文件（避免 system_server 直接写 app 私有目录
 *   被 SELinux 拒）。
 *   反方向（app → system_server）走 /data/local/tmp/cx-ovstate 文件：
 *   app 写、system_server 读。实测 system_server 读 app_data_file 被拒，
 *   而 shell_data_file 可以。
 *
 * scope 必须包含 "android"（system_server 的包名）。
 */
public class VolKeyModule implements IXposedHookLoadPackage {

    private static final String TAG = "[VolKey]";
    private static final String TARGET_APP = "com.air.mpprobe";
    private static final String ACTION = "com.air.mpprobe.TOGGLE";
    private static final String SECRET = "cx-helper-2026-toggle";

    /**
     * app 写来的跨进程状态文件（app 写、system_server 读）。
     *
     * 不能用 app 私有目录：system_server 读 app_data_file 会被 SELinux 拒。
     * /data/local/tmp 是 shell_data_file，system_server 可读、app 可写。
     */
    private static final String SHARED_STATE = "/data/local/tmp/cx-ovstate";

    /** 触发后静默，防连发 */
    private static final long COOLDOWN_MS = 600;
    /** 短按派发窗口：最后一次松手后等这么久才判定单击/双击/三击 */
    private static final long TAP_WINDOW_MS = 500;
    /** 长按阈值：按住超过这个时长（且未松手）即触发主动识别 */
    private static final long LONG_PRESS_MS = 2000;

    /** Vol- 触发冷却 */
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

        // Vol+ 双击 → 快速识别（无思考档）；其余情况放行。
        if (code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            onVolDown(e, action, downTime);
        } else {
            onVolUp(e, action, downTime);
        }
    }

    // ───────────────────────── Vol+ ─────────────────────────

    /**
     * Vol+ 手势（2026-11-26 改版）：
     *
     *   浮层存在时 单击 → 立即识别当前屏（which=fast，视觉+快模型 4~5s）
     *   浮层不存在 单击 → 完全放行，正常调音量
     *
     * 为什么从「双击」改成「单击」：
     *   air 反馈「主动识题长按太累了」。原来要 Vol- 长按 2 秒，考试时每道题
     *   都这么按很累。而 Vol+ 单击是最自然的"再来一次"动作。
     *
     * 为什么用「浮层是否存在」当开关，而不是无条件拦截：
     *   无条件拦截会让音量没法加 —— 这是用户最常用的动作，不能占。
     *   而浮层开着 = 用户明确在用这个工具，此时 Vol+ 才属于工具。
     *   浮层关掉 = 工具不在场，Vol+ 就该是普通音量键。这个判据是自解释的，
     *   不需要额外记"什么时候按一下有效"。
     *
     * 为什么不做双击/三击了：
     *   单击已经能触发，多击反而要等 500ms 窗口才能判定，慢。
     *   视觉现在是默认路径，也不需要单独一个手势切过去。
     *   保留 n>=1 的判断（而不是 ==1），这样快速连按两下也只触发一次，
     *   不会因为手抖变成两次请求。
     *
     * 音量怎么处理：
     *   本模块一直是「旁路监听 + 事后回滚」，不拦截事件（拦截要改
     *   interceptKeyBeforeQueueing 的返回值，各 ROM 行为不一致，风险高）。
     *   所以按一下音量会 +1，触发后立刻回滚到按下前的值。
     *   浮层不在时不做回滚 —— 那是用户真的要调音量。
     */
    private static void onVolUp(KeyEvent e, int action, long downTime) {
        long now = System.currentTimeMillis();

        if (action == KeyEvent.ACTION_DOWN) {
            int repeat = 0;
            try { repeat = e.getRepeatCount(); } catch (Throwable ignored) {}
            if (repeat == 0) {
                // 记下当前音量：若最终判定为「触发识别」，要回滚掉这次 +1。
                // 浮层状态在 DOWN 时读一次就够（一次按压内不会变），
                // 缓存到字段避免 UP 时再读一次文件。
                volUpSavedVolume = readMusicVolume();
                volUpOverlayAtDown = isOverlayOn();
            }
            return;
        }

        if (now - lastFireUp < COOLDOWN_MS) return;

        volUpTapCount++;
        XposedBridge.log(TAG + " Vol+ tap #" + volUpTapCount
                + " overlay=" + volUpOverlayAtDown);

        cancelUpTapDispatch();

        // 浮层存在 → 立即触发，不等点击窗口。
        // 不等的原因：单击就是最终意图，没有"可能要按第二下"的歧义了。
        // 等 500ms 会让用户觉得按了没反应。
        if (volUpOverlayAtDown) {
            volUpTapCount = 0;
            lastFireUp = now;
            restoreVolUpVolume();
            vibrate();
            XposedBridge.log(TAG + " Vol+ single (overlay on) -> fast scan");
            sendBroadcast("fast");
            return;
        }

        // 浮层不存在 → 放行，让音量正常变化。
        // 仍走一次延迟派发，把计数器清干净，避免残留计数影响下一次判定。
        final int expected = volUpTapCount;
        upTapDispatch = new Runnable() { public void run() {
            upTapDispatch = null;
            if (volUpTapCount != expected) return;
            volUpTapCount = 0;
            // 不拦截、不回滚 —— 用户就是要调音量
        } };
        postDelayed(upTapDispatch, TAP_WINDOW_MS);
    }

    /** DOWN 时缓存的浮层状态（同一次按压内不变） */
    private static volatile boolean volUpOverlayAtDown = false;

    /**
     * 读 app 写来的浮层状态。
     *
     * 为什么要绕这一圈：本模块跑在 system_server（uid 1000 / SELinux
     * system_server），读不了 app 私有目录。实测：
     *   system 读 /data/data/com.air.mpprobe/files/overlay.flag → Permission denied
     * 而 /data/local/tmp 是 shell_data_file 标签，system_server 可读，
     * app 也可写（目录 0777）。所以 app 把状态写在那儿（见 ToggleStore
     * .writeSharedState），这里读。
     *
     * 读不到时返回 false（保守：宁可让 Vol+ 当普通音量键，也不要误拦）。
     */
    private static boolean isOverlayOn() {
        try {
            java.io.File f = new java.io.File(SHARED_STATE);
            if (!f.exists()) return false;
            // 文件很小（几十字节），直接读
            byte[] buf = new byte[256];
            int n;
            java.io.FileInputStream fis = new java.io.FileInputStream(f);
            try { n = fis.read(buf); } finally { fis.close(); }
            if (n <= 0) return false;
            String s = new String(buf, 0, n, "UTF-8");
            // 解析 "overlay=1\napp=1"
            int i = s.indexOf("overlay=");
            if (i < 0) return false;
            int p = i + "overlay=".length();
            return p < s.length() && s.charAt(p) == '1';
        } catch (Throwable t) {
            XposedBridge.log(TAG + " read state err: " + t);
            return false;
        }
    }

    /** Vol+ 短按计数器 */
    private static int volUpTapCount = 0;
    private static Runnable upTapDispatch = null;
    private static long lastFireUp = 0;
    private static int volUpSavedVolume = -1;

    private static void cancelUpTapDispatch() {
        if (upTapDispatch != null) {
            removeCallbacks(upTapDispatch);
            upTapDispatch = null;
        }
    }

    private static void restoreVolUpVolume() {
        if (volUpSavedVolume < 0) return;
        try {
            android.content.Context ctx = getSystemContext();
            if (ctx == null) return;
            android.media.AudioManager am =
                    (android.media.AudioManager) ctx.getSystemService(
                            android.content.Context.AUDIO_SERVICE);
            if (am == null) return;
            am.setStreamVolume(android.media.AudioManager.STREAM_MUSIC,
                    volUpSavedVolume, 0);
            XposedBridge.log(TAG + " Vol+ volume restored to " + volUpSavedVolume);
        } catch (Throwable t) {
            XposedBridge.log(TAG + " Vol+ volume restore err: " + t);
        } finally {
            volUpSavedVolume = -1;
        }
    }

    // ───────────────────────── Vol- ─────────────────────────

    /**
     * Vol- 手势：
     *   按住 ≥2s        → 主动识别当前页（which=scan）
     *   单击            → 不拦截，正常调音量
     *   双击            → 浮层显隐（which=overlay）
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
