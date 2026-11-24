package com.air.mpprobe;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Main —— 只是一个配置页，不再承载叠层。
 *
 * 叠层已搬进 ReaderService（TYPE_ACCESSIBILITY_OVERLAY），
 * 因为普通 Activity 会被学习通这类后启动的前台应用盖掉。
 *
 * 这个页面负责：
 *   · 打开无障碍设置，让人手动启用 ReaderService
 *   · 显示当前 Bus 上的状态（a11y 是否连上、最近一次答案来源）
 *   · 手动触发一次读题（调试用）
 */
public class Main extends Activity {

    private TextView stat;
    private Button masterBtn;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 96, 48, 48);
        // 必须给不透明背景：默认窗口背景是透明的，底下的 Exam Mock / 学习通
        // 会透上来，看起来像自己页面被盖住了（实测截图里题干和选项都透出来）。
        root.setBackgroundColor(0xFFFFFFFF);
        // 状态文字是浅灰，深色底上才看得清；这里统一改深色

        TextView title = new TextView(this);
        title.setText("Answer Helper");
        title.setTextSize(26);
        title.setTextColor(0xFF111111);

        TextView hint = new TextView(this);
        hint.setText("1. 打开无障碍，启用「答案助手」\n"
                   + "2. 启动目标应用（学习通 / MockExam）\n"
                   + "3. 叠层由无障碍服务绘制，会压在所有界面之上\n\n"
                   + "叠层不可截图（LSPosed SKIP_SCREENSHOT）。");
        hint.setTextSize(15);
        hint.setTextColor(0xFF444444);
        hint.setPadding(0, 32, 0, 32);

        stat = new TextView(this);
        stat.setTextSize(14);
        stat.setTextColor(0xFF333333);
        stat.setPadding(0, 16, 0, 16);

        Button a11y = new Button(this);
        a11y.setText("打开无障碍设置");
        a11y.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            }
        });

        // 答题服务地址（USB 用 127.0.0.1；无线填 PC 的 Tailscale IP 或局域网 IP）
        ConfigStore.init(this);
        final EditText ep = new EditText(this);
        ep.setHint("答题服务地址");
        ep.setText(ConfigStore.endpoint());
        ep.setSingleLine(true);

        Button saveEp = new Button(this);
        saveEp.setText("保存地址（无线连接填 PC 的 IP）");
        saveEp.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                ConfigStore.setEndpoint(ep.getText().toString());
                dump();
            }
        });

        Button refresh = new Button(this);
        refresh.setText("刷新状态");
        refresh.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { dump(); }
        });

        // ── 总开关：不停服务，只让叠层/截屏不工作 ──
        // 对应音量键 Vol-×2，适合临时收手又不想重开无障碍。
        final Button master = new Button(this);
        masterBtn = master;
        master.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                boolean now = ToggleStore.toggleApp();
                if (!now) Bus.publishStatus("总开关已关（不再读题）", "off");
                else Bus.publishStatus("总开关已开", "ok");
                dump();
            }
        });

        // ── 彻底关闭：注销无障碍 + 退进程 ──
        // 关无障碍是唯一能让进程真正退出的办法：只要服务还注册着，
        // 系统会立刻把进程拉起来（force-stop 后几秒又回来）。
        // 注销后进程失去前台服务身份，stopSelf + Process.killProcess 才能退干净。
        final Button shutdown = new Button(this);
        shutdown.setText("彻底关闭（注销无障碍并退出）");
        shutdown.setTextColor(0xFFFF5252);
        shutdown.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                new android.app.AlertDialog.Builder(Main.this)
                    .setTitle("彻底关闭答案助手？")
                    .setMessage("将注销无障碍服务并退出进程。\n"
                              + "之后要重新启用，需回本页点「打开无障碍设置」。\n\n"
                              + "注意：LSPosed 音量键 hook 仍驻留 system_server，"
                              + "要完全停用需在 LSPosed 里关掉模块并重启。")
                    .setPositiveButton("彻底关闭", new android.content.DialogInterface.OnClickListener() {
                        public void onClick(android.content.DialogInterface d, int w) { shutdownAll(); }
                    })
                    .setNegativeButton("取消", null)
                    .show();
            }
        });

        // 诊断开关：图片题拿不到 targetUrl 时打开，把整棵 a11y 树打进 logcat。
        // 平时关着——每道图片题都 dump 一棵树会把日志淹掉。
        final Button treeDump = new Button(this);
        treeDump.setText(ToggleStore.treeDumpOn() ? "诊断：a11y 树 dump 开" : "诊断：a11y 树 dump 关");
        treeDump.setTextColor(0xFF666666);
        treeDump.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                boolean on = ToggleStore.toggleTreeDump();
                treeDump.setText(on ? "诊断：a11y 树 dump 开" : "诊断：a11y 树 dump 关");
                Bus.publishStatus(on ? "下次图片题会打印节点树（logcat -s AnsReader）" : "诊断已关闭", "ok");
            }
        });

        root.addView(title);
        root.addView(hint);
        root.addView(new TextView(this)); // 间距
        root.addView(ep);
        root.addView(saveEp);
        root.addView(a11y);
        root.addView(refresh);
        root.addView(master);
        root.addView(treeDump);
        root.addView(shutdown);
        root.addView(stat);
        setContentView(root);
        dump();
    }

    private void dump() {
        Bus.Msg m = Bus.last();
        StringBuilder sb = new StringBuilder();
        sb.append("服务地址：").append(ConfigStore.endpoint()).append('\n');
        sb.append("总开关：").append(ToggleStore.appOn() ? "开" : "关").append('\n');
        sb.append("叠层：").append(ToggleStore.overlayOn() ? "显示" : "隐藏").append('\n');
        sb.append("状态：").append(Bus.status()).append('\n');
        if (m != null && !m.answer.isEmpty()) {
            sb.append("来源：").append(m.source)
              .append("  题型：").append(m.type.isEmpty() ? "-" : m.type)
              .append("  耗时：").append(m.ms).append("ms\n");
            sb.append("答案：").append(m.answer);
        } else {
            sb.append("尚无答案");
        }
        stat.setText(sb.toString());
        // 总开关按钮文案跟着状态走
        if (masterBtn != null) masterBtn.setText(ToggleStore.appOn() ? "总开关：开（点此关闭）" : "总开关：关（点此开启）");
    }

    /** 彻底关闭：注销无障碍 → 停叠层 → 杀进程 */
    private void shutdownAll() {
        try {
            // 1. 先让叠层消失，避免注销瞬间留个残影在屏幕上
            Bus.publishStatus("正在关闭…", "off");
            ReaderService.hideOverlayNow();
        } catch (Throwable t) {
            android.util.Log.w("Main", "shutdown hide: " + t);
        }

        // 2. 注销无障碍服务。
        //    只 force-stop 不够：服务注册在 Settings.Secure 里，系统会立刻把
        //    进程重新拉起来（实测 force-stop 后 5 秒进程又出现）。
        //    而 Settings.Secure.putString 需要 WRITE_SECURE_SETTINGS，普通应用
        //    写会静默失败（实测：进程退了、注册还在）。只有 disableSelf() 有效。
        ReaderService.disableSelfNow();

        // 3. 停服务 + 杀进程。给系统 400ms 处理注销，再退。
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
                new Runnable() {
                    public void run() {
                        try { stopService(new Intent(Main.this, ReaderService.class)); } catch (Throwable ignored) { }
                        finishAndRemoveTask();
                        android.os.Process.killProcess(android.os.Process.myPid());
                    }
                }, 400);
    }

    @Override protected void onResume() {
        super.onResume();
        // 叠层是 TYPE_ACCESSIBILITY_OVERLAY，会盖在自己的配置页上（实测截图里
        // 叠层正好压在题干和按钮中间）。进本页就先把叠层藏起来，离开再恢复。
        Bus.setSuppressOverlay(true);
        // 抑制标志只拦新的 show()，已挂载的要主动撤掉
        ReaderService.hideOverlayNow();
        dump();
    }

    @Override protected void onPause() {
        super.onPause();
        Bus.setSuppressOverlay(false);
    }
}