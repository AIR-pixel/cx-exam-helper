# 19 - 图片题的 URL 方案 vs 截屏 OCR

调研来源：网页端脚本普遍读 DOM 的 `img.src` 把 `<img src="...">` 当题干发出去
（[超星网课助手 greasyfork 431514](https://greasyfork.org/zh-CN/scripts/431514) 的 `filterImg`）。
本文回答：手机端 a11y 有没有等价通道，两条路各差在哪。

## 结论

**URL 方案可行，且在手机端比截屏 OCR 更优。** 关键发现是 a11y 的 `Image` 节点
`extras` 里有 `AccessibilityNodeInfo.targetUrl`，跟 DOM 的 `img.src` 是同一份信息。

实测对照（Redmi M2101K9C / Android 17 / WebView，mock 第 6 题）：

| 环节 | URL 方案 | 截屏 OCR |
|---|---|---|
| 取图 | a11y 节点 `targetUrl`，0 次截屏 | root `screencap`，~114 KB PNG |
| 叠层处理 | 不需要（不截屏就没污染） | 必须 hide→等 250ms→show，叠层闪烁 |
| 服务端识别 | SVG 抽 `<text>`：**9 ms** | RapidOCR：**3168 ms** |
| 噪声 | 无（不含状态栏） | 状态栏/标题栏/toast，需 12 条正则清洗 |
| 失真 | 无（拿的是原始 URL） | 有（1080 宽截图缩放后 OCR） |
| 模型推理 | 1857 ms | 1589 ms |

两条路的模型推理时间相当（±200ms），**差距全在取图和识别环节：9ms vs 3168ms**。

## a11y 树里的 img 到底长什么样

探测代码 `app/src/com/air/answer/TreeDump.java`，dump 出来的原文：

```
Image desc=[IP 协议工作在哪一层？] <<IMAGE>>
  extras={
    AccessibilityNodeInfo.unclippedRight=1047;
    AccessibilityNodeInfo.unclippedWidth=1014;
    AccessibilityNodeInfo.unclippedBottom=423;
    AccessibilityNodeInfo.targetUrl=data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D...;
    AccessibilityNodeInfo.unclippedLeft=33;
    AccessibilityNodeInfo.unclippedHeight=126;
    AccessibilityNodeInfo.hint=;
    AccessibilityNodeInfo.hasImage=true;
    AccessibilityNodeInfo.chromeRole=image;
    AccessibilityNodeInfo.unclippedTop=297;
  }
  rect=[33,297][1047,423]
```

四个可用的字段：

- **`targetUrl`** —— 图片地址。`data:` 或 `http(s):` 都有。
- `unclippedWidth/Height` —— 原始尺寸，可用来挑「哪个是题干图」（题干图通常占满一行）
- `contentDescription` —— 来自 `<img alt="...">`
- `hasImage` / `chromeRole=image` —— 确认这是图片节点

## 一条重要限制：a11y 读不到 src，只能读 alt 和 targetUrl

同一个 `<img>`，`alt=""` 和 `alt="IP 协议工作在哪一层？"` 两种写法的差别：

```html
<!-- alt 为空 -->
<img alt="" src="data:image/svg+xml,...">
→ a11y 树里：Image <<IMAGE>>（desc 为空，但有 targetUrl）

<!-- alt 有内容 -->
<img alt="IP 协议工作在哪一层？" src="data:image/svg+xml,...">
→ a11y 树里：Image desc=[IP 协议工作在哪一层？] <<IMAGE>>
```

**`alt` 会进 `contentDescription`，`src` 会进 `targetUrl`，但 `src` 本身不出现在
`text` / `desc` / `hint` 里。** 网页端脚本能直接 `$(this).attr("src")`，
手机端只能走 `extras`。

## 实现

### 手机端

`ImageNodes.java` —— 递归遍历，取 `extras` 里的 `targetUrl`：

```java
Bundle ex = n.getExtras();
Object u = ex.get("AccessibilityNodeInfo.targetUrl");
if (u != null) s.url = String.valueOf(u);
s.width  = intOf(ex, "AccessibilityNodeInfo.unclippedWidth");
s.height = intOf(ex, "AccessibilityNodeInfo.unclippedHeight");
```

过滤规则：没有 url 也没有 desc 的丢掉（状态栏图标）；有 desc 但宽度 <80px 的丢掉（小图标）。

`ReaderService.firstImageUrl()` —— 只在主窗口（`TYPE_APPLICATION`）里找，
取宽度最大的那个（题干图占满一行）：

```java
for (AccessibilityWindowInfo w : wins) {
    if (w.getType() != AccessibilityWindowInfo.TYPE_APPLICATION) continue;
    for (ImageNodes.Shot s : ImageNodes.collect(w.getRoot())) {
        if (!s.url.startsWith("data:") && !s.url.startsWith("http")) continue;
        if (s.width > bestW) { bestW = s.width; best = s.url; }
    }
}
```

图片题分支改成 URL 优先、OCR 兜底：

```java
if (imageStem && ToggleStore.appOn()) {
    String imgUrl = firstImageUrl();
    if (!imgUrl.isEmpty()) { handleWithImageUrl(text, imgUrl); return; }
    Log.d(TAG, "no image url in a11y tree, fallback to screenshot OCR");
    handleWithOcr(text);
}
```

### 服务端

`answer-server.mjs` 的 `imageToBase64()` 归一三种输入：

```js
if (s.startsWith('data:')) {
    const meta = s.slice(5, comma);
    const payload = s.slice(comma + 1);
    if (/;base64/i.test(meta)) return payload;
    const decoded = decodeURIComponent(payload);
    if (mime.includes('svg')) return `__SVG__${decoded}`;   // SVG 走文本提取
    return Buffer.from(decoded, 'binary').toString('base64');
}
if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s, { signal: AbortSignal.timeout(15000) });
    return Buffer.from(await r.arrayBuffer()).toString('base64');
}
return s;   // 已经是 base64（截屏路径）
```

SVG 直接抽 `<text>`，跳过 OCR：

```js
function textFromSvg(svg) {
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  // 去嵌套标签、反转义实体
}
```

## 实测日志

```
手机端: image url found: data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fw…
服务端: [image] data URI image/svg+xml, 220 chars decoded
        [image] svg text: 1 lines, 18 chars
        [image-question] OCR 清洗后 18 chars:
        6.（2分）IP 协议工作在哪一层？
        [image-question] OCR 接管题干: "IP 协议工作在哪一层?" opts=4（沿用手机端）
        [cache HIT] a14f19273817e6af19118913d793b37f hits=8 type=single
        [answer] 38ms source=cache type=single from=127.0.0.1
```

对照 OCR 路径（同一题）：

```
手机端: OCR fallback: sending 114KB image
服务端: [ocr] 12 lines, 90 chars
        [image-question] OCR 清洗后 61 chars
```

**URL 路径 18 字符 vs OCR 路径 90 字符（含噪声），且 URL 路径 9ms vs 3168ms。**

## 真实学习通会怎样

这是**推断，不是实测**（登录态仍为空，无法验证）：

- 学习通题干图基本是 `<img src="https://p.ananas.chaoxing.com/star3/origin/xxx.png">`
  这种 CDN 地址，不是 `data:` SVG
- 那么 `targetUrl` 会是 `https://...`，走服务端的 `fetch` 下载分支
- 下载一张图约 100–300 ms（同城 CDN），仍远快于 3168 ms 的 OCR
- 但**如果学习通把图片放在 CSS `background-image` 里，a11y 就不会有 Image 节点**，
  这时只能退回截屏 OCR

已加的双路设计正是为了覆盖这两种情况：URL 拿得到就走 URL，拿不到就 OCR。

## 和网页端脚本的本质差别

| | 网页端（Tampermonkey） | 手机端（本方案） |
|---|---|---|
| 运行位置 | 学习通网页内部，同源 | 外部无障碍服务 |
| 取图方式 | `document.querySelectorAll('img')` 直接读 DOM | `AccessibilityNodeInfo.getExtras()` 读 targetUrl |
| 能拿到的东西 | src、alt、完整 HTML 结构、题目 id | targetUrl、alt、尺寸、位置；**拿不到 DOM** |
| 优势 | 信息最全，能读到隐藏字段（题目 id/答案） | 不依赖网页，任何 app 都能读 |
| 劣势 | 只在浏览器里有效 | 信息量少一层 |

网页端脚本还能顺手读 `input[name=answer]`、`<div class="questionId">` 这类隐藏字段，
a11y 完全看不到。这是两条路的固有差距，不是实现问题。

## Review 阶段发现并修掉的问题

首版跑通后做了一轮针对性 review，6 个问题：

### 1. 重复请求：同一张图 10 秒发了 5 次（性能，实际浪费）

`handleWithOcr` 有发送前去重，`handleWithImageUrl` 漏了。轮询每 2.5s 一跳，
每次都把同一张图重发，只有等服务端返回后才发现 `stableKey` 重复。

```
修前：image url found 5 次 / skip same question 4 次 → 4 次请求白烧
修后：image url found 7 次 / skip same url 6 次    → 只 1 次真请求
```

修法：加 `lastImageUrl` 字段，发送前比对 URL。

### 2. a11y 节点没 recycle（内存，长期轮询会累积）

`getRoot()` / `getChild()` 返回的 `AccessibilityNodeInfo` 由调用方负责回收。
不回收，节点池会被撑爆。轮询每 2.5s 遍历一次全树，这是实打实的泄漏。

修法：`ImageNodes.walk`、`TreeDump.walk`、`firstImageUrl` 全部加 `try/finally` + `recycle()`。

### 3. `endsWith("Image")` 误伤 `ImageButton`

`android.widget.ImageButton` 也以 `Image` 结尾，会被当图片节点收进来。
改为精确匹配 `.widget.Image` / `.widget.ImageView`。

### 4. `isImageQuestion()` 重复遍历全树

主路径里 `attempt` 已经调过 `readStructured()`，`isImageQuestion()` 内部又调一次。
每轮多走一遍树。改为 `isImageQuestion(struct)` 复用。

### 5. `decodeURIComponent` 遇畸形编码抛 URIError → /answer 500

学习通若给出半截编码的 SVG，`decodeURIComponent` 直接抛，整个请求崩。
加 try/catch 兜底走原始 payload。

### 6. `textFromSvg` 的实体处理不全

- 缺十进制/十六进制数字实体（`&#20013;` / `&#x4E2D;`）
- 缺 CDATA：`<![CDATA[a < b]]>` 里的 `<` 会被当标签删掉
- `&amp;` 必须最后替换，否则 `&amp;lt;` 会二次解码成 `<`

修法：数字实体走 `String.fromCodePoint`（越界码点丢弃），CDATA 内容先把 `< >`
换成占位符再还原，`&amp;` 放最后。

### 附带：服务端下载加防护

- `decodeURIComponent` 异常兜底
- `Content-Length` 超 8MB 直接丢弃（`IMAGE_MAX_BYTES` 可调）
- 下载带 `Referer: https://mooc1.chaoxing.com/`，学习通 CDN 对裸请求偶尔 403
- 超时可配（`IMAGE_FETCH_TIMEOUT_MS`，默认 15s）

## 遗留风险

1. **真实学习通未验证** —— 登录态为空。`targetUrl` 是 http 还是 data 未知。
2. **`background-image` 场景** —— 图片若由 CSS 绘制，无 Image 节点，必须靠 OCR。
3. **Canvas 渲染的图** —— 同上，a11y 只能看到一个 Canvas 节点。
4. **图片鉴权** —— 若 CDN 地址带时效签名，服务端 `fetch` 可能 403。已加 Referer 但未做重试。
5. **多图题** —— 一道题多张图时，`firstImageUrl` 只取最大的那张，会漏图。
6. **叠层是否触发学习通切屏上报** —— 未验证。备选方案是 LSPosed hook 客户端上报逻辑。
