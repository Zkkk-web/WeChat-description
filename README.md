# Headhunter Agent Backend

云端猎头助手的最小后端骨架。第一阶段只证明三件事：服务能长期运行、健康检查能被平台探测、外部事件能进入系统。

## Milestone

- `GET /health`: 验证服务在线。
- `POST /webhook`: 接收邮件或平台事件，返回标准化结果。

## Quick Start

```bash
node src/server.js
```

默认端口是 `3000`，可通过 `PORT` 修改。

```bash
PORT=8787 node src/server.js
```

## Test

```bash
node --test
```

## Railway Deploy

Railway 会读取 `railway.json`，使用 Nixpacks 构建，并用 `npm start` 启动服务。

部署时确认这几项：

1. GitHub 仓库选择 `Zkkk-web/headhunter-agent-backend`。
2. Start Command 使用 `npm start`。
3. Healthcheck Path 使用 `/health`。
4. 环境变量先保留 `.env.example` 里的占位项，等接入飞书、邮箱、模型时再填真实密钥。

部署成功后访问：

```text
https://你的-railway-域名/health
```

看到 `ok: true` 就算里程碑 2 的公网运行节点通过。

## Environment

复制 `.env.example` 后按部署平台配置环境变量。当前版本不读取密钥，只保留后续接入飞书、邮箱和模型的配置位。

## Next

1. 在 Railway 上部署，并验证公网 `/health`。
2. 用测试邮件或事件订阅调用 `/webhook`。
3. 接入飞书 Base 写入。
4. 接入模型抽取候选人信息。
