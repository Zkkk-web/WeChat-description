# Headhunter Agent Backend

云端猎头助手的最小后端骨架。第一阶段只验证两个事实：服务能跑，事件能进来。

## Milestone

- `GET /health`：验证服务在线。
- `POST /webhook`：接收邮件或平台事件，返回标准化结果。

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

## Environment

复制 `.env.example` 后按部署平台配置环境变量。当前版本不读取密钥，只保留后续接入飞书、邮箱和模型的配置位。

## Next

1. 选择部署平台，让 `/health` 暴露到公网。
2. 用测试邮件或事件订阅调用 `/webhook`。
3. 接入飞书 Base 写入。
4. 接入模型抽取候选人信息。
