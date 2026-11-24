package com.air.mpprobe;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;

/**
 * ConfigStore —— 答题服务地址配置（无线连接的关键）。
 *
 * 默认 http://127.0.0.1:18888/answer（USB adb reverse 场景，保持兼容）。
 * 无线场景把地址写进 flag 文件（root/脚本可改），App 启动时读取：
 *   /data/data/com.air.mpprobe/files/endpoint.txt
 * 内容示例：
 *   http://100.64.1.2:18888/answer      ← Tailscale tailnet IP（推荐，跨网段）
 *   http://10.99.64.158:18888/answer    ← 局域网 IP（需同网段/VLAN 互通）
 *
 * 也支持 SharedPreferences（配置页改），flag 文件优先（方便自动化）。
 */
public final class ConfigStore {
    private static final String TAG = "AnsCfg";
    private static final String SP_NAME = "config";
    private static final String K_ENDPOINT = "endpoint";
    public static final String DEFAULT_ENDPOINT = "http://127.0.0.1:18888/answer";
    private static final String FLAG = "/data/data/com.air.mpprobe/files/endpoint.txt";

    private static SharedPreferences sp;
    private static volatile String endpoint = DEFAULT_ENDPOINT;

    public static void init(Context c) {
        if (sp != null) return;
        sp = c.getApplicationContext().getSharedPreferences(SP_NAME, Context.MODE_PRIVATE);
        String fromSp = sp.getString(K_ENDPOINT, DEFAULT_ENDPOINT);
        String fromFile = readEndpointFile();
        endpoint = (fromFile != null && !fromFile.isEmpty()) ? fromFile : fromSp;
        Log.d(TAG, "endpoint=" + endpoint + " (file=" + fromFile + " sp=" + fromSp + ")");
    }

    public static String endpoint() { return endpoint; }

    /** 配置页/外部设置新地址，同时写 SP 和 flag 文件 */
    public static void setEndpoint(String url) {
        if (url == null || url.trim().isEmpty()) url = DEFAULT_ENDPOINT;
        endpoint = url.trim();
        if (sp != null) sp.edit().putString(K_ENDPOINT, endpoint).apply();
        try {
            File dir = new File("/data/data/com.air.mpprobe/files");
            if (!dir.exists()) dir.mkdirs();
            java.io.FileOutputStream fos = new java.io.FileOutputStream(new File(dir, "endpoint.txt"), false);
            try { fos.write(endpoint.getBytes("utf-8")); } finally { fos.close(); }
        } catch (Throwable t) {
            Log.w(TAG, "write endpoint flag failed: " + t.getMessage());
        }
        Log.d(TAG, "endpoint set to " + endpoint);
    }

    private static String readEndpointFile() {
        try {
            File f = new File(FLAG);
            if (!f.exists() || f.length() > 512) return null;
            byte[] b = new byte[(int) f.length()];
            FileInputStream fis = new FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int r = fis.read(b, off, b.length - off);
                    if (r < 0) break;
                    off += r;
                }
            } finally { fis.close(); }
            return new String(b, "utf-8").trim();
        } catch (Throwable t) {
            return null;
        }
    }

    private ConfigStore() {}
}
