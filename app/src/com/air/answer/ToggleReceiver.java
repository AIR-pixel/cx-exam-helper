package com.air.mpprobe;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * ToggleReceiver —— 接收 Xposed 模块（system_server）音量键手势发来的指令。
 *
 * 为什么用广播而不是直接写 flag 文件：
 *   hook 跑在 system_server（uid 1000 / SELinux system_server），直接写
 *   /data/data/com.air.mpprobe/files/ 可能被 SELinux 拒（app_data_file）。
 *   system_server 发广播无此限制，app 自己收到后由 ToggleStore 改内存+回写 flag。
 *
 * 广播是显式Intent + 自定义权限保护（签名级），防止第三方伪造。
 * 这里用简单做法：action 带私钥字符串，只有知道该串的模块能发。
 *
 * which 取值：
 *   "overlay" → 切浮层显隐（Vol+ ×2）
 *   "app"     → 切总开关（Vol- ×3）
 *   "scan"    → 主动识别当前屏一次（Vol- 长按 2s），不改变任何开关状态
 */
public class ToggleReceiver extends BroadcastReceiver {
    private static final String TAG = "AnsToggle";
    public static final String ACTION = "com.air.mpprobe.TOGGLE";
    public static final String EXTRA_WHICH = "which";   // "overlay" | "app" | "scan"
    public static final String SECRET = "cx-helper-2026-toggle";

    @Override public void onReceive(Context c, Intent i) {
        if (i == null || !ACTION.equals(i.getAction())) return;
        if (!SECRET.equals(i.getStringExtra("secret"))) {
            Log.w(TAG, "toggle broadcast rejected: bad secret");
            return;
        }
        String which = i.getStringExtra(EXTRA_WHICH);
        ToggleStore.init(c);
        if ("overlay".equals(which)) {
            boolean on = ToggleStore.toggleOverlay();
            Log.d(TAG, "broadcast toggle overlay=" + on);
            // 通知 ReaderService 更新浮层显隐（通过 Bus 状态触发）
            Bus.publishStatus("弹窗已" + (on ? "打开" : "关闭") + "（Vol-×2）", "toggle");
        } else if ("app".equals(which)) {
            boolean on = ToggleStore.toggleApp();
            Log.d(TAG, "broadcast toggle app=" + on);
            Bus.publishStatus(on ? "应用已开启" : "应用已暂停（Vol-×3 恢复）", "toggle");
        } else if ("scan".equals(which)) {
            // 主动识别：一次性读当前屏，不启动轮询、不改任何开关。
            // 这是「非学习通场景」的唯一入口 —— 用户按一下才读，程序不自己猜。
            Log.d(TAG, "broadcast manual scan");
            ReaderService.forceScanNow();
        }
    }
}
