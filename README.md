# Headhunter Agent Backend

猎头助手后端原型。当前重点是验证外部事件进入系统后，能否稳定补处理并把结果推回飞书。

## 当前已跑通

公众号文章更新推送链路已经跑通：

```text
微信公众号后台登录态
  -> wechat-download-api 抓取文章
  -> 本地 feed API
  -> 本后端轮询 / 补处理
  -> 飞书话题群
```

已验证结果：

- `wechat-download-api` 健康检查返回 `healthy`。
- 老板公众号后台登录成功，订阅数为 `1`。
- 真实公众号文章入库 `10` 篇。
- 首次补处理只记录水位，不推历史旧文：`checked=10, pushed=0, skippedInitial=10`。
- 演示推送成功：`checked=1, pushed=1`。
- 飞书话题群能搜索到推送消息。
- 多公众号已验证：`泛函` + `宝玉AI` 两个 fakeid 可独立记录水位。
- 登录态可观测：一键体检会显示剩余有效期，例如 `expires in 3.6d`。

## 启动

先启动 `wechat-download-api`，并扫码登录公众号后台：

```powershell
cd .codex-tmp\wechat-download-api
.\.venv312\Scripts\python.exe app.py
```

登录页：

```text
http://127.0.0.1:5000/login.html
```

再启动本后端：

```powershell
$env:WECHAT_ARTICLE_POLL_ENABLED='true'
$env:WECHAT_DOWNLOAD_API_BASE='http://127.0.0.1:5000'
$env:WECHAT_ARTICLE_FAKEIDS='Mzg4NjQ5Njg4Nw=='
$env:WECHAT_ARTICLE_ACCOUNT_NAMES='Mzg4NjQ5Njg4Nw==:泛函'
$env:FEISHU_ARTICLE_CHAT_ID='oc_85d747806e696642d420426a3a596ab3'
$env:WECHAT_ARTICLE_STATE_PATH='.codex-tmp/wechat-article-push-state.json'
$env:WECHAT_PUSH_EXISTING_ON_FIRST_RUN='false'
npm start
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

## 手动补处理

用于演示和兜底。它会立刻检查公众号文章源，并根据本地水位只推新文章：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/wechat/articles/poll
```

## 一键体检

只检查服务状态，不触发推送：

```powershell
$env:WECHAT_DOWNLOAD_API_BASE='http://127.0.0.1:5000'
$env:WECHAT_ARTICLE_FAKEIDS='Mzg4NjQ5Njg4Nw=='
$env:BACKEND_BASE='http://127.0.0.1:3000'
npm run wechat:doctor
```

检查状态并触发一次补处理：

```powershell
$env:WECHAT_DOCTOR_RUN_POLL='true'
npm run wechat:doctor
```

期望看到类似输出：

```text
wechat health: healthy FastAPI
wechat login: logged in as 泛函
wechat subscriptions: subscriptions=1
wechat feed: articles=3 next_since=1782293034
backend health: healthy
backend compensation poll: checked=0 pushed=0 skippedInitial=0
```

首次运行默认不推旧文章，只记录水位。只有显式设置：

```powershell
$env:WECHAT_PUSH_EXISTING_ON_FIRST_RUN='true'
```

才会把历史文章当作待推送内容。

## 关键配置

```env
WECHAT_ARTICLE_POLL_ENABLED=true
WECHAT_DOWNLOAD_API_BASE=http://127.0.0.1:5000
WECHAT_ARTICLE_FAKEIDS=Mzg4NjQ5Njg4Nw==
WECHAT_ARTICLE_ACCOUNT_NAMES=Mzg4NjQ5Njg4Nw==:泛函
WECHAT_ARTICLE_POLL_INTERVAL_MS=300000
WECHAT_ARTICLE_STATE_PATH=.codex-tmp/wechat-article-push-state.json
WECHAT_PUSH_EXISTING_ON_FIRST_RUN=false
FEISHU_ARTICLE_CHAT_ID=oc_85d747806e696642d420426a3a596ab3
```

多公众号用逗号分隔：

```env
WECHAT_ARTICLE_FAKEIDS=Mzg4NjQ5Njg4Nw==,Mzk1NzgxMjQ0OA==
WECHAT_ARTICLE_ACCOUNT_NAMES=Mzg4NjQ5Njg4Nw==:泛函,Mzk1NzgxMjQ0OA==:宝玉AI
```

## 智能体直接订阅管理

目标智能体必须直接调用 `POST /agent/wechat-subscriptions`，不能等待另一个机器人代为执行或返回回执。接口支持：

```text
list
search
add
remove
```

- 请求必须携带 `Authorization: Bearer <token>`，令牌从 `WECHAT_AGENT_API_TOKEN` 读取；未配置时接口直接拒绝服务。
- 接口固定使用 `FEISHU_ARTICLE_CHAT_ID` 对应的唯一推送群，并拒绝其他群。
- 新增前先调用 `search`，由用户确认候选项后再把候选项的 `fakeid` 传给 `add`。
- 取消只接受公众号名称、微信号或内部识别码的精确匹配。
- 智能体只能在收到 `ok: true` 的真实接口结果后确认操作完成。
- 该接口只解决订阅操作；文章要以目标智能体身份推送，还必须配置该智能体自己的飞书 App 凭据。

## 测试

```powershell
npm test
```

当前测试覆盖：

- 读取 `wechat-download-api` feed。
- 首次运行不刷历史文章。
- 已初始化后只推新文章。
- 多公众号独立水位。
- 重复文章去重。
- 飞书 webhook 和飞书 chat ID 两种推送方式。
- 飞书群内查询、新增、精确取消以及单群限制。
- Windows 下绕开 `lark-cli.cmd` 多行中文参数拆坏问题。
- 一键体检可检查抓取服务、登录态、订阅数、feed、后端健康和补处理结果。

## 已知边界

- `wechat-download-api` 登录态约 4 天过期；当前已能体检显示剩余时间，后续可升级为主动飞书提醒。
- 当前是本地运行，关机或进程退出后不会自动处理；但 state 文件会保留水位，重启后不会重复推旧文章。
- 如果公众号抓取服务或飞书推送失败，本后端不会推进水位，避免丢文章。
