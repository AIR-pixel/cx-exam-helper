package com.air.skipmodule;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 壳界面，存在的唯一目的是让这个模块包被「启动」过一次。
 *
 * 装完但从未启动的包带 FLAG_STOPPED（dumpsys 里 stopped=true notLaunched=true）。
 * LSPosed 在 fork 目标进程时要用 PackageInfo 校验模块，对 stopped 包会查不到，
 * 日志表现为 `W/LSPosedService Failed to find package info of com.air.skipmodule`，
 * 模块被静默丢弃 —— 没有报错、scope 也对、hook 完全不生效。
 *
 * 打开一次界面即清掉该标志。
 */
public class Main extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int p = (int) (24 * getResources().getDisplayMetrics().density);
        root.setPadding(p, p, p, p);

        TextView tv = new TextView(this);
        tv.setText("SkipModule\n\n目标：" + SkipModule.TARGET
                + "\n标志文件：" + SkipModule.FLAG
                + "\n当前判定：" + (SkipModule.shouldApply() ? "打 SKIP（截图应为空）" : "不打 SKIP（截图可见）"));
        tv.setTextSize(14);
        root.addView(tv);

        Button btn = new Button(this);
        btn.setText("刷新");
        btn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { recreate(); }
        });
        root.addView(btn);

        setContentView(root);
    }
}