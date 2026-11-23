package com.air.skipmodule;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

import java.io.File;
import java.io.FileInputStream;
import java.util.HashSet;
import java.util.Set;

/**
 * Xposed module: 给目标应用的所有窗口打 SKIP_SCREENSHOT。
 *
 * ## 为什么有运行时开关
 *
 * 原先用编译期常量 APPLY_SKIP 做 A/B 对照，需要每改一次就重装 APK。
 * 但 LSPosed 在 modules_config.db 里缓存了模块的 apk_path，
 * 重装后路径变了（/data/app/~~xxxx 会变），LSPosed 找不到模块就静默跳过 ——
 * 表现为「模块没报错、scope 也对、但 hook 完全不生效」，极难排查。
 *
 * 改成读标志文件：装一次，之后开关只写文件，不再碰 APK。
 *   /system 之外的 app uid 无法读 /data/local/tmp 下的文件（目录 0771，
 *   有 search 无 read），所以标志文件放 sdcard 并由 shell 预创建。
 *
 * 判据：
 *   文件不存在 / 内容为 "1" / 其它   -> 打 SKIP（默认行为）
 *   内容为 "0"                        -> 不打 SKIP（可见性对照实验）
 */
public class SkipModule implements IXposedHookLoadPackage {

    static final String TARGET = "com.air.mpprobe";

    /**
     * 标志文件。放在目标 app 自己的数据目录里 ——
     * /storage/emulated/0 在 Android 13+ 上要有存储权限才可读，SELinux 也会拦
     * （app 进程读 shell_data_file 被拒）；app 自己的 files/ 是 app_data_file，
     * 同域可读，只需要 adb root 写进去。
     */
    static final String FLAG = "/data/data/com.air.mpprobe/files/skip.flag";

    private final Set<Object> applied = new HashSet<>();

    @Override
    public void handleLoadPackage(final XC_LoadPackage.LoadPackageParam lpparam) {
        if (!TARGET.equals(lpparam.packageName)) return;
        XposedBridge.log("[SkipModule] loaded, apply=" + shouldApply() + " flag=" + FLAG);

        try {
            final Class<?> vri = XposedHelpers.findClass("android.view.ViewRootImpl", lpparam.classLoader);

            // Android 17 的 setView 签名已经和 AOSP 13 不同（多了参数），
            // 用 findAndHookMethod 做精确匹配会 NoSuchMethodError，而且异常会
            // 把同一个 try 块里后面的 hook 全部带掉。所以：
            //   1) 只按名字 hookAllMethods，不锁签名；
            //   2) 每个 hook 各自 try-catch，互不影响。
            hook(vri, "setView", new XC_MethodHook() {
                @Override protected void afterHookedMethod(MethodHookParam p) {
                    schedule(p.thisObject);
                }
            });
            hook(vri, "performTraversals", new XC_MethodHook() {
                @Override protected void afterHookedMethod(MethodHookParam p) {
                    tryApply(p.thisObject);
                }
            });
            XposedBridge.log("[SkipModule] hooks installed");
        } catch (Throwable t) {
            XposedBridge.log("[SkipModule] setup err: " + t);
        }
    }

    private static void hook(Class<?> cls, String name, XC_MethodHook cb) {
        try {
            XposedBridge.hookAllMethods(cls, name, cb);
            XposedBridge.log("[SkipModule] hooked " + name);
        } catch (Throwable t) {
            XposedBridge.log("[SkipModule] hook " + name + " err: " + t);
        }
    }

    /** 读标志文件决定这次要不要打 SKIP */
    static boolean shouldApply() {
        File f = new File(FLAG);
        if (!f.exists()) return true;              // 默认开
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] b = new byte[8];
            int n = in.read(b);
            if (n <= 0) return true;
            String s = new String(b, 0, n).trim();
            return !"0".equals(s);
        } catch (Throwable t) {
            return true;
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
        }
    }

    private void schedule(final Object vri) {
        if (!shouldApply()) return;
        try {
            Object view = XposedHelpers.getObjectField(vri, "mView");
            if (view instanceof android.view.View) {
                ((android.view.View) view).post(new Runnable() {
                    public void run() { tryApply(vri); }
                });
                return;
            }
        } catch (Throwable ignored) {}
        try {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
                public void run() { tryApply(vri); }
            });
        } catch (Throwable ignored) {}
        tryApply(vri);
    }

    private synchronized void tryApply(Object vri) {
        if (!shouldApply() || vri == null || applied.contains(vri)) return;
        Object sc = findSurfaceControl(vri);
        if (sc == null) return;
        if (applySkip(sc)) {
            applied.add(vri);
            XposedBridge.log("[SkipModule] SKIP applied to " + sc);
        }
    }

    private Object findSurfaceControl(Object vri) {
        String[] fields = {"mSurfaceControl", "mSurfaceControlLocked", "mLeash",
                "mSurfaceControlFromPerfMonitor"};
        for (String f : fields) {
            try {
                Object sc = XposedHelpers.getObjectField(vri, f);
                if (sc != null && sc.getClass().getName().contains("SurfaceControl")) return sc;
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private boolean applySkip(Object sc) {
        try {
            Class<?> txClass = XposedHelpers.findClass("android.view.SurfaceControl$Transaction", null);
            Object tx = txClass.newInstance();
            XposedHelpers.callMethod(tx, "setSkipScreenshot", sc, true);
            XposedHelpers.callMethod(tx, "apply");
            return true;
        } catch (Throwable t) {
            XposedBridge.log("[SkipModule] applySkip err: " + t);
            return false;
        }
    }
}