# Tibo Monitor

一个免安装的 Windows 本地监控工具：低频读取 Tibo（默认 `@thsottiaux`）的公开 X 动态，使用 DeepSeek 判断他是否“准备重置”或“已经重置”GPT / Codex / ChatGPT Work 额度，并通过 Windows 系统通知、SMTP 邮件或两种方式同时提醒。

本项目基于 [rxy331/Tibo-monitor](https://github.com/rxy331/Tibo-monitor) 扩展开发。感谢原作者提供项目基础；本仓库的 `v0.2.0` 在原有监控与邮件提醒能力上增加了 Windows 通知、主动复盘和可选回复帖分析。

## v0.2.0 新增功能

### Windows 系统通知

- Windows 通知与 SMTP 邮件可以独立启用，也可以同时启用。
- 设置页可以发送测试通知；程序会注册开始菜单快捷方式，使通知可正确显示应用名称。
- 点击系统通知可以重新显示 Tibo Monitor 窗口。
- Windows 通知和邮件分别记录投递状态；某一通道失败不会抹掉另一通道的成功结果。
- 失败的提醒会保留在本地，并在后续监控轮询中重试。

### 启动复盘与主动复盘

- 可选择在每次启动后的首次成功检查中，自动复盘过去 `1 / 3 / 6 / 12 / 24 / 72` 小时。
- 也可以随时从界面立刻主动复盘上述任一时间段，无需重启程序。
- 单次复盘最多处理 100 条动态；达到上限时界面会明确提示。
- 已分析的动态、事件和通知均使用持久化标识去重，重复复盘不会重复生成同一提醒。
- 启动复盘抓取失败时不会被误记为完成，会在下一次成功检查时继续尝试。

### 可选回复帖分析

- 默认仍只分析 Tibo 本人的原创帖。
- 可在设置中启用“Tibo 回复帖分析”；启用后会读取 `with_replies` 时间线，并把回复对象信息一并交给 DeepSeek。
- 原创帖与回复帖使用独立水位线，避免切换回复分析设置时漏报或把旧回复误判为新帖。
- 纯转推和无法确认回复状态的动态始终排除，不提供开启纯转推分析的设置。

## 下载与运行

从 [GitHub Releases](https://github.com/MizuIro-H/Tibo-monitor-Test/releases) 下载最新的 `Tibo-Monitor-*-portable.exe`，无需安装即可运行。

`v0.2.0` 下载：

- [Tibo-Monitor-0.2.0-portable.exe](https://github.com/MizuIro-H/Tibo-monitor-Test/releases/download/v0.2.0/Tibo-Monitor-0.2.0-portable.exe)
- [v0.2.0 Release 说明与源码](https://github.com/MizuIro-H/Tibo-monitor-Test/releases/tag/v0.2.0)

程序目前没有商业代码签名证书，因此 Windows SmartScreen 可能显示“未知发布者”。请确认下载地址属于本仓库后再选择运行。

## 使用前准备

- Windows x64。
- 已安装 Mozilla Firefox，并已在日常 Firefox 资料中登录 X。
- 一个可用的 DeepSeek API Key。
- 如需邮件提醒：SMTP 主机、账号、授权码和至少一个收件地址。
- 如需系统通知：在 Windows 设置中允许 Tibo Monitor 发送通知。

首次使用建议依次完成：

1. 阅读并勾选 XActions 只读自动化风险确认。
2. 关闭正在运行的普通 Firefox，然后测试 X 登录与读取。
3. 填写并测试 DeepSeek 配置。
4. 按需要启用并测试 Windows 通知。
5. 按需要配置 SMTP、收件人并发送测试邮件。
6. 保存设置并开启监控。

## 监控与判断规则

- Electron 使用 `portable` 目标，输出可直接双击的便携 EXE。
- 只调用 XActions 的只读时间线抓取能力；仅使用 Mozilla Firefox 的现有 X 登录资料，不提供 Chrome、Edge、官方 X API 或软件专用登录模式。
- 常规轮询只处理最近 30 分钟动态，默认每 15 分钟执行一次，可在 5–30 分钟内配置。
- 若 X/Grok 自动把帖子显示成中文，程序会按帖子 ID 从 X 的结构化响应恢复作者原文后再交给 DeepSeek；发现自动译文却拿不到原文时，本轮停止判断以避免误报。
- 软件不会读取浏览器保存的密码。每轮只把所选 Firefox profile 的必要文件复制到系统临时目录，读取结束后立即删除，不会写入日常浏览器资料。
- 默认首次成功抓取只建立基线，不会为历史动态群发提醒；只有用户明确启用启动复盘或主动执行复盘时，程序才会分析所选时间段。
- 进入监控范围的每条目标动态都会调用 DeepSeek，不做本地关键词预筛选；每帖最多生成一个主事件。
- AI 证据必须来自当前帖子，历史上下文不能单独证明当前事件。需要人工复核的判断不会发送通知。
- 旧版误判会标记为 `superseded`，主历史只显示有效记录，旧记录保留审计摘要但不会重发。
- DeepSeek API URL、模型名、置信度阈值和 API Key 均可在界面编辑。
- API Key 与 SMTP 授权码由 Electron `safeStorage`（Windows DPAPI）加密。
- 收件邮箱支持多个地址，添加或删除后立即保存；测试邮件和正式提醒会发送给列表中的全部地址。
- 提醒邮件会附上 X 帖子的完整作者原文和 DeepSeek 生成的中文翻译。
- 界面分别显示复盘数、新帖数、新信号数、邮件发送数和 Windows 通知数。

## 数据目录

运行数据固定写入 `%USERPROFILE%\Documents\Tibo Monitor`，不会写入 EXE 所在目录。

```text
Documents\Tibo Monitor\
├─ settings.json       # 非敏感配置
├─ state.json          # 水位线、复盘记录、动态、事件及通知状态
├─ secrets.dat         # Windows DPAPI 加密密钥
├─ logs\               # 脱敏日志，保留 30 天
└─ exports\
```

## 本地开发

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD='true'
npm install
npm test
npm start
```

生成 Windows x64 便携版：

```powershell
npm run build:portable
```

仓库内的 `.github/workflows/release.yml` 会在推送 `v*` 标签时使用 GitHub Actions 在 Windows runner 上执行测试、构建、体积校验和 Release 发布。`dist/`、`artifacts/`、`node_modules/` 与本地 Node.js 运行时均不会提交到 Git。

## 注意

XActions 使用网页浏览器自动化，并非 X 官方事件流。X 登录墙、验证码、页面结构变化或平台规则变化都可能导致抓取失败；软件会保留原水位线并进入监控降级，不会把抓取失败当作“没有新帖”。

请保持低频只读使用，并自行遵守 X 的适用条款。点击测试后，Tibo Monitor 会自动依次验证 Firefox 的现有资料并记住成功项。每次读取使用一次性临时快照；如果 Firefox 正在写入资料导致复制失败，请关闭 Firefox 后重试。

## 项目与作者

- 本扩展仓库：[MizuIro-H/Tibo-monitor-Test](https://github.com/MizuIro-H/Tibo-monitor-Test)
- 原始仓库：[rxy331/Tibo-monitor](https://github.com/rxy331/Tibo-monitor)
- [原作者 Bilibili 主页](https://space.bilibili.com/6398431)
