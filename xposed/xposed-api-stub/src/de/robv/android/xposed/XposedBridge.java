package de.robv.android.xposed;

import java.util.HashSet;
import java.util.Set;

/**
 * 编译期 stub —— 只为让 SkipModule.java 能通过 javac。
 *
 * 运行期 LSPosed 会把它自己的真实实现注入 classpath，
 * 因此这份 stub 绝不能被 d8 打进 APK。
 *
 * ## 签名必须和真实 Xposed API 一致
 *
 * hookAllMethods 的真实返回类型是 Set<XC_MethodHook.Unhook>，不是 Unhook。
 * 写成 Unhook 时 javac 能过（stub 自己说了算），但运行期 dex 里的方法描述符
 * 是 hookAllMethods(...)Ljava/util/Set;，而 stub 编译出的调用点引用的是
 * hookAllMethods(...)LXC_MethodHook$Unhook; —— 两者对不上，直接
 * NoSuchMethodError: No static method hookAllMethods(...)Unhook。
 *
 * 所以 stub 的方法签名必须逐字节照抄真实 API。
 */
public class XposedBridge {
    public static void log(String text) { }
    public static void log(Throwable t) { }

    public static Set<XC_MethodHook.Unhook> hookAllMethods(
            Class<?> hookClass, String methodName, XC_MethodHook callback) {
        return new HashSet<XC_MethodHook.Unhook>();
    }

    public static Set<XC_MethodHook.Unhook> hookAllConstructors(
            Class<?> hookClass, XC_MethodHook callback) {
        return new HashSet<XC_MethodHook.Unhook>();
    }
}