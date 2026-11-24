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

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 96, 48, 48);

        TextView title = new TextView(this);
        title.setText("Answer Helper");
        title.setTextSize(26);

        TextView hint = new TextView(this);
        hint.setText("1. 打开无障碍，启用「答案助手」\n"
                   + "2. 启动目标应用（学习通 / MockExam）\n"
                   + "3. 叠层由无障碍服务绘制，会压在所有界面之上\n\n"
                   + "叠层不可截图（LSPosed SKIP_SCREENSHOT）。");
        hint.setTextSize(15);
        hint.setPadding(0, 32, 0, 32);

        stat = new TextView(this);
        stat.setTextSize(14);
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

        root.addView(title);
        root.addView(hint);
        root.addView(new TextView(this)); // 间距
        root.addView(ep);
        root.addView(saveEp);
        root.addView(a11y);
        root.addView(refresh);
        root.addView(stat);
        setContentView(root);
        dump();
    }

    private void dump() {
        Bus.Msg m = Bus.last();
        StringBuilder sb = new StringBuilder();
        sb.append("服务地址：").append(ConfigStore.endpoint()).append('\n');
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
    }

    @Override protected void onResume() {
        super.onResume();
        dump();
    }
}