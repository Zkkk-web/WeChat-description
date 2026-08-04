# 猎头助手后端

## 2026-07-03 架构补充

`scripts/wechatIntelEventBridge.js` 是公众号情报机器人的飞书入站消息桥。它保持 `lark-cli event consume im.message.receive_v1` 长连接，读取机器人私聊/群聊消息，并把事件转发到 `POST /webhook`。文章推送仍由 `src/hooks/wechatArticlePoller.js` 负责；私聊订阅管理由这个 bridge 加 `src/routes/webhook.js` 负责。推送和监听是两条独立链路，不混在一个模块里。

<!-- 2026-06-29: src/domain/buildHermesPrompt.js turns accepted webhook events into the Hermes prompt returned by /webhook. -->
<!-- 2026-06-29: /webhook now normalizes Feishu event payloads and returns fetch-first Hermes tasks for mail, minutes, and meeting events. -->
<!-- 2026-06-29: src/integrations/larkContent.js fetches Feishu mail details and minutes transcripts behind LARK_CONTENT_FETCH_ENABLED. -->

## 架构骨架

```text
.
├─ src/
│  ├─ config.js              # 读取运行配置，集中处理环境变量
│  ├─ env.js                 # 从 .env.local 读取本地开发环境变量
│  ├─ http.js                # 极简 HTTP 服务和 JSON 响应工具
│  ├─ server.js              # 组合路由、邮件 Hook 和业务处理链
│  ├─ hooks/
│  │  └─ mailPoller.js       # 轮询 IMAP 未读邮件，只负责触发邮件处理链
│  ├─ domain/
│  │  ├─ normalizeMail.js    # 把原始邮件事件整理成统一内部模型
│  │  ├─ classifyMail.js     # 用硬规则判断候选人、客户需求、客户转发简历或其他
│  │  ├─ processMailEvent.js # 编排标准化、分类、写入计划和可选真实入库
│  │  └─ routeMail.js        # 根据分类生成应写入飞书 Base 的记录计划
│  ├─ integrations/
│  │  └─ larkBase.js         # 飞书 Base REST 写入器，隔离外部 API 细节
│  └─ routes/
│     ├─ health.js           # 服务存活检查
│     └─ webhook.js          # 邮件/事件入口，接收事件并调用 domain 模块
├─ test/
│  ├─ health.test.js         # 验证 health contract
│  ├─ webhook.test.js        # 验证 webhook 接收、分类和入库计划
│  ├─ mailPoller.test.js     # 验证 IMAP Hook 到邮件事件的转换
│  └─ larkBase.test.js       # 验证飞书 Base 写入请求和字段清洗
├─ scripts/
│  └─ mailDoctor.js          # 独立诊断 IMAP 连接、开箱和未读邮件数量
├─ railway.json              # Railway 部署、启动和健康检查配置
├─ package.json              # Node 脚本入口
├─ .env.example              # 完整配置样例
└─ README.md                 # 项目目标、启动方式、部署路径、下一步
```

## 设计决策

入口必须薄。`/webhook` 只接收事件，`hooks/mailPoller.js` 只监听邮箱，二者都交给 `processMailEvent`。业务判断在 `domain`，外部写入在 `integrations`，路由层不理解飞书，轮询层不理解猎头业务。

真实入库由 `LARK_BASE_WRITE_ENABLED=true` 控制。默认只生成 `plannedWrites`，打开开关后才调用 `src/integrations/larkBase.js` 写入飞书 Base。这样分类验证、邮箱连接、飞书权限三个问题不会搅成一团。

飞书写入有两种身份：`LARK_WRITE_MODE=app` 使用 AppID/AppSecret，适合云上长期运行；`LARK_WRITE_MODE=cli` 使用本机 `lark-cli --as user` 登录态，适合本地快速打通闭环。模式是单一事实源，不要在调用点写分支。

Windows 本地优先显式配置 `LARK_CLI_COMMAND` 为全局 npm 生成的 `lark-cli.cmd`。`larkBase.js` 会通过 `cmd.exe /c` 执行 `.cmd`，通过 `powershell.exe -File` 执行 `.ps1`。CLI 写入字段会先落到 `.codex-tmp/lark-cli-json/*.json`，再用 `--json @relative-file` 传给 `lark-cli`，避免 PowerShell 解析 JSON。

分类结果不能被外部写入绑架。飞书写入失败时，`processMailEvent` 仍返回分类和计划写入，轮询器打印失败原因，不标已读，不停止轮询。只有真实写入成功，才允许邮件状态前进。

当前测试写入目标是副本 Base `ZyYAb61ewaI0MFsTzM9cmb4xnKd`。邮件流水写入「邮件事件」，候选人投递写入「候选人」，客户岗位邮件写入「岗位」，猎头合作写入「猎头伙伴」，生态合作写入「生态伙伴」。字段名必须跟 Base 真实字段一致，不允许用旧测试库的英文占位字段。

Base 表结构是事实源。代码只能适配现有表和字段，不允许为了代码方便去改表。客户提供新岗位时直接写「岗位」；猎头合作写「猎头伙伴」；生态合作写「生态伙伴」。不存在的「客户线索 / 客户需求」不再作为业务表概念使用。

邮件去重必须以本地已处理账本为准。163 IMAP 的标记已读会超时，不能让外部邮箱状态决定系统幂等性。真实写入成功后记录 `message_id` 到 `MAIL_PROCESSED_STORE_PATH`；后续即使邮箱仍显示未读，也只尝试标记已读，不再重复入库。写入失败的邮件不进账本，保持可重试。

对账模式打开 `MAIL_POLL_INCLUDE_SEEN=true` 后，邮箱 Hook 会扫描最近 N 封全部邮件，而不是只看未读。处理前先用 `邮件事件.邮件ID` 查询 Base；Base 已有则跳过并写入本地账本，Base 没有则补录。已读状态只是邮箱 UI 状态，不再决定业务是否处理。

日常轮询采用轻探测。每轮只读取最近 N 封的 UID 列表，若与上一轮完全一致，就跳过正文解析、Base 查询和写入；只有 UID 集合变化时才深处理一圈。深处理存在失败写入时不记录 UID 集合，下一轮继续重试，避免失败被误认为已同步。

字段处理保持朴素：先写文本、数字、状态、时间；附件本体暂不上传，只记录附件名。能稳定入库，比一次性追求全能更重要。

## 开发规范

- 每个接口返回 JSON。
- `/health` 只返回服务状态，不夹带业务逻辑。
- `/webhook` 只接事件并调用 domain 模块。
- 邮箱轮询默认关闭，只有 `MAIL_POLL_ENABLED=true` 时才启动。
- 邮箱轮询按批处理未读邮件，默认每轮最多 20 封；不能假设 10 秒内只来一封。
- 邮件写入成功后必须记录 `message_id` 到本地账本；标记已读失败不能造成重复入库。
- 对账模式用 `MAIL_POLL_INCLUDE_SEEN=true` 打开；打开后必须先查 Base 是否已有同一 `邮件ID`，再决定是否补录。
- `MAIL_POLL_SKIP_UNCHANGED=true` 时，只在最近 N 封 UID 集合变化后深处理；失败写入不能更新 UID 集合。
- 本地开发优先使用 `.env.local`，不要在 PowerShell 里反复手敲密钥。
- `IMAP_PASSWORD` 必须是邮箱客户端授权码，不是网页登录密码。
- IMAP 错误只能让本轮轮询失败，不能杀死 Node 服务。
- `MAIL_STOP_AFTER_PROCESSED=true` 用于本地一次性验证：处理到至少一封邮件后停止定时器。
- 飞书写入默认关闭，只有 `LARK_BASE_WRITE_ENABLED=true` 且 app 凭证完整才真实写入。
- 本地权限未打通时优先使用 `LARK_WRITE_MODE=cli`；云上部署再切回 `LARK_WRITE_MODE=app`。
- 飞书写入必须有超时，失败不能吞掉分类结果，也不能把邮件标记为已读。
- 测试只能写副本 Base；切回正式库前必须显式替换 `LARK_BASE_TOKEN` 和所有表 ID。
- 不修改 Base 结构。字段不匹配时改代码映射，不改表。
- 外部 API 细节只允许出现在 `src/integrations`，不要泄漏回路由和 domain 规则。
- 新增文件、移动职责或改变目录结构时，必须同步更新本文档。

## 变更日志

- 2026-06-23: 创建最小后端骨架，完成 `/health` 与 `/webhook`。
- 2026-06-23: 添加 Railway 部署配置，把 `/health` 设为平台健康检查入口。
- 2026-06-26: 新增 webhook 模拟分类链路，将邮件标准化、分类和 Base 写入计划拆到 `domain` 模块。
- 2026-06-26: 新增 IMAP 邮箱轮询 Hook，支持用 163 邮箱未读邮件触发同一套邮件处理链路。
- 2026-06-26: 为 IMAP 客户端补充 error 兜底、连接超时、阶段日志和诊断脚本。
- 2026-06-26: 邮箱轮询改为只取最新 N 封未读邮件，并支持处理成功后停止轮询。
- 2026-06-26: 新增 `src/integrations/larkBase.js`，把 `plannedWrites` 真实写入飞书 Base，并用总开关控制外部副作用。
- 2026-06-26: 飞书写入增加 `cli` 模式，可用本机用户身份先完成本地入库闭环。
- 2026-06-26: 兼容 Windows 上的 `lark-cli.ps1`，避免 Node 进程找不到 `lark-cli`。
- 2026-06-26: 飞书写入失败不再拖死邮箱轮询；分类照常输出，邮件保持未读等待重试。
- 2026-06-29: 将测试写入目标切到副本 Base，并把路由字段映射到真实业务表「邮件事件 / 候选人 / 客户列表 / 岗位」。
- 2026-06-29: 本地 CLI 写入改为调用 `lark-cli.cmd`，并用相对 JSON 文件传参，解决 Windows 命令解析、中文路径和绝对 @file 限制。
- 2026-06-29: 轮询改为默认每轮最多处理 20 封未读；新增猎头伙伴、生态伙伴路由；客户岗位邮件直接写「岗位」。
- 2026-06-29: 新增本地已处理邮件账本，入库成功即记住 `message_id`，避免 163 标记已读超时导致重复写入。
- 2026-06-29: 邮件分类从顺序 if/else 改为规则表打分器，减少分类优先级被代码顺序绑架的问题。
- 2026-06-29: 入库路由从多段 if 改为分类路由表，分类名直接映射目标表和字段构造器。
- 2026-06-29: 拆出单封邮件处理函数，让 IMAP 轮询只负责连接、搜索和遍历，去重与写入状态留在消息处理层。
- 2026-06-29: 新增 Base 对账模式，可扫描已读邮件；以「邮件事件.邮件ID」判断是否补录，避免邮箱已读导致漏入库。
- 2026-06-29: 第三方自动岗位订阅归为 `external_job_feed`，识别平台名、自动发件、岗位订阅和退订信号，只写邮件事件不写岗位；客户合作招聘同时写「客户列表」和「岗位」。
- 2026-06-29: 客户入库改为按「邮箱 / 客户名称」查重后更新，岗位创建时写入「关联客户」，由 Base 双向关联回填客户表「正在招聘的岗位」。
- 2026-06-29: 新增最近 UID 集合轻探测；邮箱无新 UID 时跳过深扫描，有新 UID 才读取正文并对账入库一圈。
## 2026-07-04 Cloud deployment addendum

`Dockerfile` and `deploy/cloud/start.sh` package the WeChat public-account pusher
as one cloud container. The public process is `wechat-download-api`; the private
process is the Node backend poller. `/data` is the single persistent state root:
WeChat login credentials, RSS subscriptions, and article push state must live
there, never in the image.

Cloud Feishu push should use either `FEISHU_ARTICLE_WEBHOOK_URL` or
`LARK_APP_ID` + `LARK_APP_SECRET` + `FEISHU_ARTICLE_CHAT_ID`. Local `lark-cli`
is only a development shortcut and must not be the production dependency.

```text
.
├── Dockerfile                 # Cloud image: Node backend + WeChat API runtime
├── .dockerignore              # Keeps local secrets, caches, and login state out
├── deploy/
│   └── cloud/
│       ├── start.sh           # Starts WeChat API, waits for health, starts poller
│       ├── env.example        # Cloud environment-variable contract
│       └── README.md          # Deployment notes and operational boundary
├── vendor/
│   └── wechat-download-api/   # Vendored WeChat RSS service required by Docker build
└── src/                       # Existing backend and article poller
```

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain documentation layout. See `docs/agents/domain.md`.

## 2026-07-12 Agent skill configuration

```text
docs/agents/
├── issue-tracker.md   # GitHub Issues operations and request-surface boundary
├── triage-labels.md   # Canonical triage roles mapped to repository labels
└── domain.md          # Domain context and ADR consumption rules
```

The agent configuration is repository-local and declarative. Skills read these files before operating; they do not create remote issues merely because configuration exists. `CONTEXT.md` and ADRs remain lazy artifacts created only when domain decisions need to be recorded.

### Change log

- 2026-07-12: Configured Matt Pocock's engineering skills for GitHub Issues, default triage labels, and a single-context domain documentation layout.
