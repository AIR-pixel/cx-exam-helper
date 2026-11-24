# cx-exam-helper

学习通（超星）考试场景的**单设备答题辅助**研究项目：手机端读题 → 上送 PC → 作答 → 浮层回显。

> ⚠️ 学术研究 / 实验用途。仅用于自己的设备与模拟考试页（`mock/`），请勿用于真实考试作弊。

## 架构

```
┌─────────────────────────┐        adb reverse tcp:18888        ┌──────────────────────────┐
│  手机 (Android 17)       │ ◄──────────────────────────────────► │  PC (Node.js)             │
│                          │           HTTP 127.0.0.1:18888      │  answer-server.mjs        │
│  answer-app (a11y 服务)  │                                      │  ├ answer-core.mjs 解析器  │
│  ├ ReaderService 读题    │                                      │  ├ engine-qoder 真模型     │
│  ├ AnswerOverlay 浮层    │                                      │  ├ engine-heuristic 兜底  │
│  └（可选 SKIP 模块）     │                                      │  └ answer-cache 题库缓存  │
└─────────────────────────┘                                      └──────────────────────────┘
```

- **读题**：`TYPE_ACCESSIBILITY_OVERLAY` 走 a11y 无障碍树，读 WebView 里的虚拟节点（题干/选项/题型），
  整屏文本线性化后 `POST /answer` 上送。
- **作答**：PC 端优先走缓存（同一道题只问一次模型），miss 时才调 LLM；LLM 不可用时退回启发式引擎。
- **回显**：浮层 `NOT_FOCUSABLE | NOT_TOUCHABLE`，不抢焦点、不占 Activity 栈。超长答案自动滚动
  （16ms×6px 步进 → 底部停 1.8s → 回顶 → 停 2.5s → 循环）。
- **防截屏**（可选）：Xposed 模块 hook `ViewRootImpl#setView`，对叠加层应用
  `SurfaceControl$Transaction#setSkipScreenshot(true)`，录屏/截图里浮层不可见（A/B 像素实证）。

## 目录

| 目录 | 内容 |
|---|---|
| `docs/` | 17 篇研究文档（00 总报告 → 16 全流程实验） |
| `app/` | 安卓端无障碍服务 + 浮层（`build.ps1` 构建 answer-app 和 exam-mock 两个 APK） |
| `xposed/` | SKIP_SCREENSHOT 模块（含 xposed-api-stub 编译桩） |
| `mock/` | 学习通考试页仿真（WebView，五种题型） |
| `server/` | PC 端答题服务 + **可视化管理页**（见下） |
| `scripts/` | 设备调试脚本 + LSPosed DB 工具 |
| `evidence/` | 真机验证截图（A/B 对照 / 滚动 / 浅灰 UI） |

## 真机实验结论（`docs/16-单设备全流程实验.md`）

- 五题型（单选/多选/判断/填空/简答）端到端全跑通，`answer src=cache/qoder` 命中。
- 缓存 key 归一化哈希去重，同一题二次秒回（`answer-cache.db`）。
- SKIP 开关 A/B 像素级成立：skipon 浮层区域 `gray 0.84% / white 91.83%`（纯白=被剔除），
  skipoff `gray 86.49% / white 4.85%`（灰卡片可见）。
- 长答案自动滚动实测：三连拍像素 diff 44.7% / 41.4% / 46.2%（在滚），短答案 0.00%（不滚）。
- 浅灰透明背板（10% alpha）不遮题面。

### PC 可视化管理页（推荐）

双击仓库根目录的 `start-manager.cmd`（或 `node server/manager.mjs`），浏览器打开
**http://127.0.0.1:18889**。页面能做的：

- **启停打包好的答题服务**（`answer-server.mjs`）：一键 start / stop，实时显示 PID、运行状态与日志
- **引擎切换**：`auto`（DSH 优先+兜底）/ `qoder`（DSH 接口）/ `openai`（任意兼容 API）/ `heuristic` / `echo`
- **接口配置**：
  - DSH/qoder：区域（cn/global）、模型 key、PAT（留空自动读 `~/.dsh/.qoder-accounts.cn.json`）
  - OpenAI 兼容 API：Base URL / Key / 模型名，可一键拉取 DSH 模型列表
- 配置持久化到 `server/config.json`（**已被 .gitignore 排除**，PAT / Key 明文不入库）；页面回显密码字段始终脱敏
- 题库统计 / 一键清空、健康检查、`LONG_TEST` 自测开关（超长文本验浮层滚动，不耗额度）
- 运行中改配置会自动重启答题服务

> 手机侧仍需 `adb reverse tcp:18888 tcp:18888`（每次重启后重建）。

### 三项读题增强（2026-11-24）

1. **题号锚点去重**：PC 返回 `stableKey`（题干+选项哈希，不受滚动/可见节点变化影响），
   手机端优先用它替代整屏 `screenHash` 去重。同时清洗倒计时/状态栏时间/OCR 置信度噪声行，
   解决"拖长题目被误判成换题"的问题。实测 5 次内容变化只触发一次 `skip same question`。

2. **双开关（浮层 / 总开关）**：`ToggleStore` 持久化两个独立开关到 SharedPreferences +
   `/data/data/com.air.mpprobe/files/{overlay,app}.flag`（root 脚本可写）：
   - 弹窗开关：只隐藏浮层，读题/作答继续
   - 总开关：停掉整条读题链路并隐藏浮层
   - **切换方式**：a11y `onKeyEvent` 双击 Vol+ / Vol-（原生 Android 有效）。
     ⚠️ HyperOS/MIUI 实测不向无障碍服务派发按键，此路在该 ROM 上不生效，
     需改用 Xposed hook 按键分发或 flag 文件脚本（见下）。

3. **图片题 OCR 兜底**：a11y 重试耗尽仍读不到时，root `screencap` → base64 → `POST /answer{image}`
   → PC 端 Python RapidOCR（`server/ocr_server.py`，`127.0.0.1:18890`）识别成文字进同一条解析管线。
   实测端到端 2.9s 返回答案。开启方式：先 `python server/ocr_server.py`，
   answer-server 通过 `OCR_URL` 环境变量找它（默认 `http://127.0.0.1:18890/ocr`，设为空关闭）。

> OCR 依赖：`pip install rapidocr_onnxruntime`（已在本机 Python 3.13 验证）。

### 快速跑（PC 端 · 纯命令行）

```bash
# 1. 起答题服务（需 Node ≥ 18）
node --import ./dsh-resolve-register.mjs answer-server.mjs
#    可选引擎：ANSWER_ENGINE=qoder|heuristic|echo|openai（默认 auto）
#    不耗额度的管线自测：LONG_TEST=1 ANSWER_ENGINE=heuristic

# 2. 手机 adb reverse（每次重启后重建）
adb reverse tcp:18888 tcp:18888

# 3. 健康检查
curl http://127.0.0.1:18888/health
```

### 安卓端构建

见 `app/build.ps1`（aapt2 + javac + d8 + zipalign + apksigner，工具链路径在脚本头部注释里）。
安装后到系统设置开启「答案助手」无障碍服务即可。

## 版权与免责

本项目仅用于技术研究与个人设备实验。真实考试环境请遵守考试纪律。