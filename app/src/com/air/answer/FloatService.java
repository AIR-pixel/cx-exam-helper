package com.air.mpprobe;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.IBinder;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.TextView;

public class FloatService extends Service {
    private WindowManager wm;
    private TextView card;
    private WindowManager.LayoutParams params;

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel("ans", "Answer", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        Notification n = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "ans").setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Answer running").build()
            : new Notification.Builder(this).setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Answer running").build();
        startForeground(1, n);

        wm = (WindowManager) getSystemService(WINDOW_SERVICE);
        card = new TextView(this);
        card.setText("Q: TEST QUESTION - is this overlay visible?\nA: B (if you can read this, SKIP works)");
        card.setTextColor(Color.WHITE);
        card.setTextSize(20);
        card.setBackgroundColor(Color.argb(255, 200, 0, 0));  // solid red, unmistakable
        card.setGravity(Gravity.CENTER);
        card.setPadding(30, 30, 30, 30);

        int type = Build.VERSION.SDK_INT >= 26
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
            900, 200,   // fixed size
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL |
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = 300;   // upper-middle, away from bottom/IME
        try {
            wm.addView(card, params);
        } catch (Throwable t) {
            android.util.Log.e("FloatService", "addView FAILED: " + t);
        }
        card.post(() -> card.setText("Q: TEST QUESTION visible?\nA: B - RED BOX = WORKS"));
    }

    @Override public int onStartCommand(Intent i, int f, int s) { return START_STICKY; }
    @Override public void onDestroy() {
        try { if (card != null && card.getParent() != null) wm.removeView(card); } catch (Throwable ignored) {}
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }
}
