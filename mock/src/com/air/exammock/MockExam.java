package com.air.exammock;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;

/**
 * MockExam —— 学习通考试页仿真。
 *
 * 目的：不复刻学习通客户端，只复刻它考试页对无障碍服务暴露出来的那棵树。
 * 照 14 号报告记录的 DOM 结构写：
 *   div.singleQuesId.ans-cc-exam   单题容器
 *   .questionWrap                  题干容器
 *   .singleoption / .multioption / .judgeoption   选项容器
 *   input[name^=type][name$=type]  题型字段
 *   #answer<qid>                   答案隐藏域
 *
 * 五道题覆盖 single / multi / judge / blank / short，可按钮切换，
 * 用来验证 ReaderService 的整屏读取 + PC 端题型判定 + 叠层显示。
 */
public class MockExam extends Activity {

    private WebView web;
    private int idx = 0;

    /** 五道题：刻意涵盖五种题型 + 典型干扰文字（倒计时/题号/分值/按钮） */
    private static final String[][] QUESTIONS = {
        {
            "single",
            "单选题",
            "1.（2分）下列关于 TCP 三次握手的描述，正确的是：",
            "A. 第一次握手由客户端发送 SYN 报文",
            "B. 第二次握手由服务端发送 SYN 报文",
            "C. 第三次握手由服务端发送 ACK 报文",
            "D. 三次握手一共需要四个报文段"
        },
        {
            "multi",
            "多选题",
            "2.（3分）下列属于 HTTP 幂等方法的有：",
            "A. GET",
            "B. PUT",
            "C. POST",
            "D. DELETE"
        },
        {
            "judge",
            "判断题",
            "3.（1分）HTTPS 在 TCP 之上加入 TLS，因此传输内容对中间人不可读。",
            "A. 对",
            "B. 错"
        },
        {
            "blank",
            "填空题",
            "4.（2分）TCP 首部固定长度是____字节，IP 首部固定长度是____字节。",
            null, null, null, null
        },
        {
            "short",
            "简答题",
            "5.（5分）简述为什么 UDP 不保证可靠传输却仍然被大量实时业务采用。",
            null, null, null, null
        },
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        Button next = new Button(this);
        next.setText("下一题 / NEXT");
        next.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                idx = (idx + 1) % QUESTIONS.length;
                render();
            }
        });

        web = new WebView(this);
        web.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        web.getSettings().setJavaScriptEnabled(true);
        web.setWebViewClient(new WebViewClient());
        // 关键：WebView 必须显式对自己开放无障碍，否则整棵树对 a11y 不可见
        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);

        root.addView(web);
        root.addView(next);
        setContentView(root);
        render();
    }

    private void render() {
        String[] q = QUESTIONS[idx];
        StringBuilder h = new StringBuilder();
        h.append("<!doctype html><html><head><meta charset=\"utf-8\">")
         .append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
         .append("<style>body{font:16px/1.6 sans-serif;margin:12px;color:#111}")
         .append(".timer{color:#c00;font-weight:bold}")
         .append(".questype{font-weight:bold;margin:12px 0 6px}")
         .append(".questionWrap{margin:8px 0 14px;line-height:1.7}")
         .append(".answerList div{margin:10px 0;padding:8px;border:1px solid #ddd;border-radius:6px}")
         .append("</style></head><body>");

        // 顶部倒计时：真实考试页必有，验证 UI_CHROME 清洗不误伤
        h.append("<div class=\"timer\">剩余时间 12:34</div>");
        h.append("<div class=\"toolbar\">答题卡 上一题 下一题 交卷</div>");

        // 单题容器，结构对齐学习通
        h.append("<div class=\"singleQuesId ans-cc-exam\" data-qid=\"q").append(idx + 1).append("\">");
        h.append("<input type=\"hidden\" name=\"type").append(idx + 1)
         .append("type\" value=\"").append(q[0]).append("\">");
        h.append("<input type=\"hidden\" id=\"answerq").append(idx + 1)
         .append("\" value=\"\">");

        // 题型标签单独成行（学习通就是这么渲染的，题号/分值也各占一行）
        h.append("<div class=\"questype\">").append(q[1]).append("</div>");
        h.append("<div class=\"questionWrap\">").append(esc(q[2])).append("</div>");

        if (q[3] != null) {
            String cls = "multi".equals(q[0]) ? "multioption"
                       : "judge".equals(q[0]) ? "judgeoption" : "singleoption";
            h.append("<div class=\"answerList ").append(cls).append("\">");
            for (int i = 3; i < q.length; i++) {
                if (q[i] == null) continue;
                h.append("<div class=\"").append(cls).append("\">")
                 .append(esc(q[i])).append("</div>");
            }
            h.append("</div>");
        } else if ("blank".equals(q[0])) {
            h.append("<div class=\"answerList\">");
            h.append("<div>第1空 <input type=\"text\"></div>");
            h.append("<div>第2空 <input type=\"text\"></div>");
            h.append("</div>");
        } else {
            h.append("<div class=\"answerList\">");
            h.append("<div>在此输入你的答案</div>");
            h.append("</div>");
        }
        h.append("</div>");
        h.append("<div class=\"footer\">保存 提交</div>");
        h.append("</body></html>");

        web.loadDataWithBaseURL("https://mooc1.chaoxing.com/exam", h.toString(),
                "text/html", "utf-8", null);
    }

    private static String esc(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}