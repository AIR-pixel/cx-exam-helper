# 18 · 图片题识别（OCR 链路）从零打通

> 2026-11-24 晚 · 实测设备 Redmi M2101K9C / Android 17 / 学习通 7.0.4
> 结论先说：**图片题现在能识别**，但证据只来自 mock 测试页 —— 学习通真机登录态仍缺，未在真实考试页验证过。

## 一、为什么之前"能识别"是假象

上一版 mock 的 5 道题全部带可读文本，`a11y` 永远走主路径，**OCR 分支一次都没被触发过**。
所以"图片题支持"只是代码里写着 `handleWithOcr()`，从未被证明。

这一版给 mock 加了第 6 题，题干用 SVG 画成 `<img>`，a11y 里只暴露一个无文字的 image 节点：

```java
// mock/src/com/air/exammock/MockExam.java
{"single", "单选题", null, "A. 传输层", "B. 网络层", "C. 数据链路层", "D. 物理层"}
//                      ^^^^ q[2]=null → 走 <img> 分支
```

`render()` 用 SVG data URI 生成图片，文字只存在于像素里：

```java
h.append("<img class=\"stemimg\" alt=\"\" style=\"width:100%;max-width:1000px\" src=\"")
 .append(svgDataUri("6.（2分）IP 协议工作在哪一层？")).append("\">");
```

## 二、实测暴露的 6 个真 bug

### bug 1 · 图片题判据缺失（选项≥2 就放行）

修复前的 `looksLikeQuestion()`：

```js
if (options.length >= 2) return true;   // 题干为空也返回 true
```

图片题有 4 个选项但题干是空的 → 判为"可答题" → 走 `handleText` → 模型拿四个层名硬猜。
实测它猜出了 `B 网络层`，**答案对但纯属运气**，换成「下列哪个是传输层协议」就必错。

**修法**（双端各一处）：

```java
// ReaderService.java —— 三条件同时成立才认定图片题
private boolean isImageQuestion() {
    String stem = j.optString("stem", "").trim();
    int opts = j.optJSONArray("options") == null ? 0 : j.optJSONArray("options").length();
    String typeLabel = j.optString("typeLabel", "").trim();
    return stem.isEmpty() && opts >= 2 && !typeLabel.isEmpty();
}
```

```js
// answer-server.mjs —— 服务端同判据，让 OCR 文本接管题干
const imageStem = !!preStructured && !structStem && structOpts >= 2 && !!preStructured.typeLabel;
```

日志证据：

```
attempt#0 windows=1 chars=75 usable=true imageStem=true
image question: options without stem, use OCR
```

### bug 2 · 图片题换页根本不触发扫描

从第 5 题（简答）点「下一题」到第 6 题（图片题），`AnsReader` **一条日志都没有**。

原因：图片题的 DOM 里没有任何文本节点变化，`TYPE_WINDOW_CONTENT_CHANGED` 不触发，
事件驱动的扫描器完全静默。学习通的真实图片题同样如此。

**修法**：考试页启动周期性兜底扫描。

```java
private static final long POLL_MS = 2500;

private void startPoll() {
    pollRunning = true;
    pollTick = new Runnable() { public void run() {
        if (!pollRunning || !ToggleStore.appOn()) { stopPoll(); return; }
        String t = readAllWindows();
        if (isExamPage(t)) { scan(); h.postDelayed(pollTick, POLL_MS); }
        else stopPoll();
    } };
    h.postDelayed(pollTick, POLL_MS);
}
```

只在 `EXAM_CHROME` 命中时轮询，非答题页不烧 CPU、不截屏。

### bug 3 · 慢响应吞掉下一题（与图片题无关的通病）

qoder 简答要 3.5~5.4s，这期间 `inFlight=true`。
用户翻页 → `scan()` 第一行 `if (inFlight) return;` → 这次扫描被静默丢弃，
而请求结束后没有任何补偿机制。

**修法**：被丢弃的扫描记账，请求结束补跑。

```java
private volatile boolean deferredScan = false;

private void scan() {
    if (inFlight) { deferredScan = true; return; }
    attempt(0);
}
private void flushDeferredScan() {
    if (!deferredScan) return;
    deferredScan = false;
    scheduleScan();
}
// handleText / handleWithOcr 的 finally 里都调 flushDeferredScan()
```

### bug 4 · OCR 截到自己上一题的答案（自问自答）

`SKIP_SCREENSHOT` 只挡 `MediaProjection`/系统截屏，**挡不住 root screencap**。
截屏时上一题的答案卡片正盖在题干上，OCR 读到的全是自己的输出：

```
个报文丢失会使后续已到达的数据也无法上交应用
层，造成整体停顿：UDP面向报文，各报文独立，丢
B4.避拥塞控制导致速率骤降。TCP 的拥塞控制会
```

**修法**：截屏前 hide 叠层，截完立刻恢复，且必须用 latch 等 UI 线程真正跑完。

```java
final boolean wasShown = overlay != null && ToggleStore.overlayOn();
if (wasShown) {
    final CountDownLatch done = new CountDownLatch(1);
    h.post(() -> { try { overlay.hide(); } finally { done.countDown(); } });
    done.await(2, TimeUnit.SECONDS);
    Thread.sleep(250);   // 等 SurfaceFlinger 合成完
}
String img;
try { img = captureScreenBase64(); }
finally {
    if (wasShown) { /* 同样的 latch 套路把 overlay.show() 放回去 */ }
}
```

效果：截图从 **950KB → 116KB**，OCR 从 **27 行 462 字符 → 12 行 90 字符**。

### bug 5 · OCR 把状态栏读成题干（题库被污染成 4 份）

状态栏、Activity 标题、Magisk toast 全被 OCR 读进来，而且电量图标被读成 `l78` / `￥578` / `￥78`：

```
stem: "l78 IP 协议工作在哪一层?"
stem: "￥578 IP 协议工作在哪一层?"
stem: "￥78 IP 协议工作在哪一层?"
stem: "IP 协议工作在哪一层?"          ← 只有这条是干净的
```

同一道题生成 4 个 qkey，缓存命中率被拉低，题库被污染。

**修法**：两层清洗 —— 整行丢 + 行首剥。

```js
const OCR_UI_NOISE = [
  /^\d{1,2}[:：]\d{2}$/,                       // 9:30
  /^[（(]?\d{1,3}[）)]?$/,                     // (77
  /^(?:KB|MB|GB)\/s$/i,                        // 网速
  /^(?:Exam Mock|答案助手|答案)$/,               // Activity 标题
  /a11y\s*已连接/, /Vol[+＋]?\s*[×x]\s*2/,      // 叠层底栏
  /超级用户权限/,                                // Magisk toast
  /^[^\u4e00-\u9fa5A-Za-z]{0,2}[lI|]?\d{1,3}[A-Za-z]?$/,  // 电量碎片
];

// 行首剥离（不是整行丢，否则会丢掉真题干）
const LEADING_UI_CRUMB =
  /^\s*(?:[^\u4e00-\u9fa5A-Za-z0-9]{0,3}[lI|]?\d{1,3}[A-Za-z]?|\d{1,2}[:：]\d{2})\s+(?=[\u4e00-\u9fa5A-Za-z])/;
```

注意 `l/I/1/|` 是电量图标的竖条，不是字母 —— 第一版正则漏了 `l78`，测试直接抓出来。

### bug 6 · 叠层 hide 后恢复成空白卡片

图片题答完后叠层显示 `OVERLAY[not-attached] null`，或恢复后只有占位文本、
meta 与 status 挤在一起互相叠印（实测卡片塌成 120px，正常单选 174px）。

三个原因叠加：

1. `render()` 开头 `if (!attached) return;` —— hide 期间答案到达，直接丢弃。
2. `showInner()` 重建 View 后没有回填 `Bus.last()`。
3. 轮询每 2.5s 触发一次 OCR，反复 hide/show 交错，最终停在隐藏态。

**修法**：

```java
// render：未挂载就先挂载再渲染
if (!attached || card == null) showInner();
if (!attached || card == null) return;

// show：挂载后回填当前答案
showInner();
Bus.Msg cur = Bus.last();
if (cur != null && attached) render(cur);

// handleWithOcr：同一屏不重复截屏，跳过时也要把叠层放回去
if (a11yText.equals(lastOcrA11yText) && !lastScreenHash.isEmpty()) {
    if (overlay != null && ToggleStore.overlayOn() && ToggleStore.appOn()) overlay.show();
    return;
}
```

### 附带修 · `C undefined`

`renderAnswer()` 用 `opts[i].text` 取选项文案，而手机端传来的是字符串数组
`["A. 传输层", ...]`，没有 `key`/`text` 字段 → 叠层上出现 `C undefined`。

```js
// 合并手机端选项时必须转成 {key, text}
structured.primary.options = preStructured.options.map((s, i) => {
  const m = String(s).trim().match(/^([A-J])\s*[.、．)）:：]\s*(.*)$/);
  return m ? { key: m[1], text: m[2].trim() }
           : { key: String.fromCharCode(65 + i), text: String(s).trim() };
});
```

## 三、修复后的完整链路（实测日志）

```
# 手机端
attempt#0 windows=1 chars=75 usable=true imageStem=true
image question: options without stem, use OCR
OCR fallback: sending 116KB image          ← 叠层已隐藏，画面干净

# 服务端
[ocr] 12 lines, 90 chars
[image-question] OCR 清洗后 61 chars:
[image-question] OCR 接管题干: "IP 协议工作在哪一层?" opts=4（沿用手机端）
[cache HIT] a14f19273817e6af19118913d793b37f hits=1 type=single

# 手机端
OCR answer src=cache type=single => B 网络层
```

答案正确（IP 在网络层），且进了题库。

## 四、验证矩阵

| 项 | 状态 | 证据 |
|---|---|---|
| 图片题判据 | ✅ | `imageStem=true` 日志 |
| 图片题触发扫描 | ✅ | `poll tick (exam page)` |
| 叠层不污染截图 | ✅ | 950KB→116KB，27行→12行 |
| OCR 噪声过滤 | ✅ | 39 项断言 `.probe-ocr-clean.mjs` |
| OCR 题干接管 | ✅ | `OCR 接管题干: "IP 协议工作在哪一层?"` |
| 答案格式 | ✅ | `B 网络层`，不再是 `C undefined` |
| 叠层恢复 | ✅ | `handleText` 路径 `OVERLAY[1000x1394]` 正常 |
| 慢响应不吞题 | ✅ | `flush deferred scan` |
| **学习通真机** | ❌ | 无登录态，未验证 |

## 五、遗留风险（诚实列出）

1. **只在 mock 上验证过**。学习通真实图片题可能是 `<canvas>`、可能是 base64 内嵌、
   也可能带图片懒加载 —— 都需要真机登录后重测。
2. **轮询 2.5s 有代价**。考试页常驻轮询会持续读 a11y 树，耗电和 CPU 都会上升。
   如果真机上 `EXAM_CHROME` 判据误命中非考试页，会一直空转。
3. **OCR 依赖 root screencap**。没 root 时 `handleWithOcr` 直接失败，只有提示没有降级。
4. **题干在图上、选项也是图** 的情况未处理 —— 目前只信任手机端抽到的选项。
5. **模型幻觉仍会发生**。同一道「IP 在哪一层」曾出现 `selectedIndex: 2`（C，错）
   和 `selectedIndex: 1`（B，对）两个答案，说明缓存可能固化错误答案。
   建议给单选/判断加二次校验（同一题问两次取一致结果）。

## 六、题库清理记录

清理前 20 条，删掉 13 条污染（10 条状态栏碎片 + 3 条导航条开头/空题干），保留 7 条：

```
已删除 13 条
剩余 7 条
```

删除判据（`.probe-cache-fix.mjs`）：

```js
const POLLUTED  = /^\s*[^\u4e00-\u9fa5A-Za-z]{0,3}[lI|]?\d{1,3}[A-Za-z]?\s+[\u4e00-\u9fa5A-Za-z]/;
const POLLUTED2 = /Exam Mock|a11y\s*已连接|Vol[+＋]?[×x]2|KB\/s/;
const POLLUTED3 = /^\s*(?:答题卡|上一题|下一题|交卷|保存\s*提交)/;
const POLLUTED4 = (s) => !String(s || '').trim();
```

另删除两条自相矛盾的 TCP 三次握手答案（`selectedIndex` 分别为 0 和 3）。
