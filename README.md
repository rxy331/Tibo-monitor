# Tibo Monitor

一个免安装的 Windows 本地监控工具：低频读取 Tibo（默认 `@thsottiaux`）的公开 X 动态，用 DeepSeek V4 Flash 判断他是否“准备重置”或“已经重置”GPT / Codex / ChatGPT Work 额度，并通过 SMTP 邮件提醒。

## 设计要点

- Electron `portable` 目标，输出可直接双击的便携 EXE。
- 只调用 XActions 的只读时间线抓取接口；仅使用 Mozilla Firefox 的现有 X 登录资料，不提供 Chrome、Edge、官方 API 或软件专用登录模式。
- 回复与纯转推始终自动排除，只分析 Tibo 本人原创帖；界面不提供重新开启这些抓取范围的设置。每轮只分析最近30分钟原创帖，默认每 15 分钟轮询，可在 5–30 分钟内配置。
- 若 X/Grok 自动把帖子显示成中文，程序会按帖子 ID 从 X 的结构化响应恢复作者原文后再交给 DeepSeek；发现自动译文却拿不到原文时，本轮停止判断以避免误报。
- 软件不会读取浏览器保存的密码；每轮只把所选 profile 的必要文件复制到系统临时目录，后台读取结束后立即删除，不会写入日常浏览器资料或软件数据目录。
- 首次成功抓取只建立基线，绝不会为历史动态群发邮件。
- Tweet ID、分析结果、事件与邮件均做幂等去重。
- 进入监控范围的每条 Tibo 原创帖都调用 DeepSeek，不做任何本地关键词预筛选；每帖最多生成一个主事件。首次基线帖也会分析，但不会补发历史提醒。
- AI 证据必须逐字来自当前帖子，历史上下文不能证明当前事件。分类以整帖语义为主：Tibo 的试探式问句或社交媒体预热可以构成“已预告”信号；已经执行但仍需几分钟生效的重置归为“已完成”。代码只保留原文证据校验，不用固定关键词或时态规则替代模型结论。
- 需要人工复核的判断不会通知；旧版误判会标记为 superseded，主历史仅显示有效记录，旧记录只保留“已隐藏且不会重发”的审计摘要。迁移后仍有效的正例继续显示；若仅旧版邮件被 superseded，界面显示“旧版邮件已停止重试”。
- DeepSeek API URL、模型名、阈值和 API Key 均可在界面编辑。
- DeepSeek 与 QQ SMTP 的测试结果会保存在本地，重启后继续显示；相关配置或密钥改变后会自动要求重新测试。
- API Key 与 SMTP 授权码由 Electron `safeStorage`（Windows DPAPI）加密。
- 运行数据固定写入 `%USERPROFILE%\Documents\Tibo Monitor`，不写 EXE 所在目录。
- 邮件失败会保留在本地发件箱，并在后续轮询时重试。
- 收件邮箱使用可添加、逐个删除的列表；添加或删除后立即自动写入本地设置，无需再点底部的“保存设置”。测试邮件和正式提醒会发送给列表中的全部地址。
- 提醒邮件同时附上 X 帖子的完整作者原文和 DeepSeek 生成的完整中文翻译；SMTP 测试邮件也使用同一可见模板。
- 最近轮询分别显示新帖、新信号、历史重试和已发送数量；没有新帖但补发成功时会明确显示“无新帖，补发 N 封历史提醒”，不会称为新提醒。

## 本地开发

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD='true'
npm install
npm test
npm start
```

生成便携版：

```powershell
npm run build:portable
```

普通用户可直接从 GitHub Releases 下载便携 EXE，无需安装。构建产物不提交到 Git 源码历史。

## 数据目录

```text
Documents\Tibo Monitor\
├─ settings.json       # 非敏感配置
├─ state.json          # 水位线、动态、AI 判断、事件、邮件状态
├─ secrets.dat         # DPAPI 加密密钥
├─ logs\              # 脱敏日志，保留 30 天
└─ exports\
```

## 注意

XActions 使用网页浏览器自动化，并非 X 官方事件流。X 登录墙、验证码、页面结构变化或平台规则变化都可能导致抓取失败；软件会保留原水位线并进入“监控降级”，不会把失败误判为“没有新帖”。请保持低频只读使用，并自行遵守 X 的适用条款。

点击测试后，Tibo Monitor 会自动依次验证 Firefox 的现有资料，并记住成功项。每次读取使用一次性临时快照；如果 Firefox 正在写入资料导致复制失败，请关闭 Firefox 后重试。登录尚未生效时，可点击“打开 Firefox 登录 X”，不会创建另一套登录资料。

## 作者

[Bilibili 社交主页](https://space.bilibili.com/6398431)
