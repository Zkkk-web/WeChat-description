# 猎头助手后端

## 架构骨架

```text
.
├── src/
│   ├── config.js        # 读取运行配置，集中处理环境变量
│   ├── http.js          # 极简 HTTP 服务器和 JSON 响应工具
│   ├── server.js        # 组合路由并启动服务
│   └── routes/
│       ├── health.js    # 服务存活检查
│       └── webhook.js   # 邮件/事件入口的最小接收面
├── test/
│   ├── health.test.js   # 验证 health contract
│   └── webhook.test.js  # 验证 webhook contract
├── package.json         # Node 脚本入口
├── .env.example         # 必要配置样例
└── README.md            # 项目目标、启动方式、下一步
```

## 设计决策

第一版只做后端骨架，不接数据库、不接模型、不接飞书写入。系统必须先证明自己能长期运行、能接收事件、能被测试验证。状态和副作用以后再接入，入口契约先稳定。

## 开发规范

- 每个接口返回 JSON。
- `/health` 只回答服务状态，不夹带业务逻辑。
- `/webhook` 只负责接收和标准化事件，不在入口里堆复杂处理。
- 新增外部依赖前先证明标准库无法满足。

## 变更日志

- 2026-06-23：创建最小后端骨架，完成 `/health` 与 `/webhook`。
