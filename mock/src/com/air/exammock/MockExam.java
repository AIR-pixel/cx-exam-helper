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
        {
            // 图片题：题干整张是图片，a11y 读不到任何题干文字。
            // 这是验证 OCR 兜底链路的唯一场景 —— 前五题都有可读文字，
            // 走的是 a11y 主链路，永远不会触发 handleWithOcr。
            "single",
            "单选题",
            null,          // stem=null → 渲染成 <img>，不产生文本节点
            "A. 传输层", "B. 网络层", "C. 数据链路层", "D. 物理层"
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

        if (q[2] == null) {
            // 图片题：题干画成 SVG 图片塞进 <img>。
            // 关键约束：图片里的文字对 a11y 完全不可见（alt 也故意留空），
            // 只有 OCR 能读出来 —— 这才叫真的图片题。
            h.append("<div class=\"questionWrap\">");
            h.append("<img class=\"stemimg\" alt=\"IP 协议工作在哪一层？\" style=\"width:100%;max-width:1000px\" src=\"")
             .append(svgDataUri("6.（2分）IP 协议工作在哪一层？"))
             .append("\">");
            h.append("</div>");
        } else {
            h.append("<div class=\"questionWrap\">").append(esc(q[2])).append("</div>");
        }

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

    /**
     * 把一段文字画成 SVG 图片，返回 data URI。
     *
     * 为什么要绕这一圈：图片题必须让题干文字只存在于像素里。
     * 直接用 <img src="...png"> 需要打包图片资源，而 SVG data URI 能在
     * 纯 HTML 字符串里生成任意文字，且渲染后对 a11y 只暴露一个无文字的
     * image 节点（alt=""），OCR 才有活干。
     */
    private static String svgDataUri(String text) {
        String svg = "<svg xmlns='http://www.w3.org/2000/svg' width='1000' height='120'>"
                + "<rect width='1000' height='120' fill='#ffffff'/>"
                + "<text x='20' y='72' font-family='sans-serif' font-size='40' fill='#111111'>"
                + escXml(text) + "</text></svg>";
        try {
            return "data:image/svg+xml;charset=utf-8,"
                    + java.net.URLEncoder.encode(svg, "UTF-8").replace("+", "%20");
        } catch (Throwable t) {
            return "";
        }
    }

    private static String escXml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("'", "&apos;").replace("\"", "&quot;");
    }
}