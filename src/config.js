export function readConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? "3000", 10),
    nodeEnv: env.NODE_ENV ?? "development",
    mail: {
      enabled: env.MAIL_POLL_ENABLED === "true",
      host: env.IMAP_HOST ?? "imap.163.com",
      port: Number.parseInt(env.IMAP_PORT ?? "993", 10),
      secure: env.IMAP_SECURE !== "false",
      user: env.IMAP_USER ?? "",
      password: env.IMAP_PASSWORD ?? "",
      mailbox: env.IMAP_MAILBOX ?? "INBOX",
      intervalMs: Number.parseInt(env.MAIL_POLL_INTERVAL_MS ?? "180000", 10),
      connectionTimeoutMs: Number.parseInt(env.IMAP_CONNECTION_TIMEOUT_MS ?? "30000", 10),
      pollTimeoutMs: Number.parseInt(env.MAIL_POLL_TIMEOUT_MS ?? "120000", 10),
      markSeenTimeoutMs: Number.parseInt(env.MAIL_MARK_SEEN_TIMEOUT_MS ?? "5000", 10),
      maxMessagesPerPoll: Number.parseInt(env.MAIL_POLL_MAX_MESSAGES ?? "20", 10),
      includeSeen: env.MAIL_POLL_INCLUDE_SEEN === "true",
      skipUnchanged: env.MAIL_POLL_SKIP_UNCHANGED !== "false",
      processedStorePath: env.MAIL_PROCESSED_STORE_PATH ?? ".codex-tmp/processed-mail-ids.json",
      stopAfterProcessed: env.MAIL_STOP_AFTER_PROCESSED === "true",
      pollOnStart: env.MAIL_POLL_ON_START === "true",
    },
    larkBase: {
      enabled: env.LARK_BASE_WRITE_ENABLED === "true",
      mode: env.LARK_WRITE_MODE ?? "app",
      cliCommand: env.LARK_CLI_COMMAND ?? "lark-cli.cmd",
      cliAs: env.LARK_CLI_AS ?? "user",
      cliTimeoutMs: Number.parseInt(env.LARK_CLI_TIMEOUT_MS ?? "20000", 10),
      apiBase: env.LARK_API_BASE ?? "https://open.feishu.cn/open-apis",
      appId: env.LARK_APP_ID ?? "",
      appSecret: env.LARK_APP_SECRET ?? "",
      baseToken: env.LARK_BASE_TOKEN ?? "ZyYAb61ewaI0MFsTzM9cmb4xnKd",
      tables: {
        mailEvents: env.LARK_TABLE_MAIL_EVENTS ?? "tblnMJc1DIJQHpps",
        candidates: env.LARK_TABLE_CANDIDATES ?? "tbl2zbTyiwbr5qAk",
        clients: env.LARK_TABLE_CLIENTS ?? "tblVH4kqYOXwXtvx",
        jobs: env.LARK_TABLE_JOBS ?? env.LARK_TABLE_CLIENT_NEEDS ?? "tblWnU6FVN7kZNHY",
        hunters: env.LARK_TABLE_HUNTERS ?? "tblZW1hmvdSDzu5Q",
        ecosystemPartners: env.LARK_TABLE_ECOSYSTEM_PARTNERS ?? "tbl4VAA3l8hLxtKp",
      },
    },
    larkContent: {
      enabled: env.LARK_CONTENT_FETCH_ENABLED === "true",
      apiBase: env.LARK_API_BASE ?? "https://open.feishu.cn/open-apis",
      accessToken: env.LARK_USER_ACCESS_TOKEN ?? env.LARK_TENANT_ACCESS_TOKEN ?? "",
    },
    wechatArticles: {
      enabled: env.WECHAT_ARTICLE_POLL_ENABLED === "true",
      apiBase: (env.WECHAT_DOWNLOAD_API_BASE ?? "http://127.0.0.1:5000").replace(/\/+$/, ""),
      fakeid: env.WECHAT_ARTICLE_FAKEID ?? "",
      fakeids: parseList(env.WECHAT_ARTICLE_FAKEIDS ?? env.WECHAT_ARTICLE_FAKEID ?? ""),
      accountNames: parseMap(env.WECHAT_ARTICLE_ACCOUNT_NAMES ?? ""),
      intervalMs: Number.parseInt(env.WECHAT_ARTICLE_POLL_INTERVAL_MS ?? "300000", 10),
      pollOnStart: env.WECHAT_ARTICLE_POLL_ON_START === "true",
      stopAfterPoll: env.WECHAT_ARTICLE_STOP_AFTER_POLL === "true",
      limit: Number.parseInt(env.WECHAT_ARTICLE_POLL_LIMIT ?? "20", 10),
      statePath: env.WECHAT_ARTICLE_STATE_PATH ?? ".codex-tmp/wechat-article-push-state.json",
      pushExistingOnFirstRun: env.WECHAT_PUSH_EXISTING_ON_FIRST_RUN === "true",
      feishuWebhookUrl: env.FEISHU_ARTICLE_WEBHOOK_URL ?? "",
      feishuChatId: env.FEISHU_ARTICLE_CHAT_ID ?? "",
      larkApiBase: env.LARK_API_BASE ?? "https://open.feishu.cn/open-apis",
      larkAppId: env.WECHAT_ARTICLE_LARK_APP_ID ?? env.LARK_APP_ID ?? "",
      larkAppSecret: env.WECHAT_ARTICLE_LARK_APP_SECRET ?? env.LARK_APP_SECRET ?? "",
      larkCliCommand: env.LARK_CLI_COMMAND ?? "lark-cli.cmd",
      larkCliAs: env.WECHAT_ARTICLE_LARK_CLI_AS ?? env.LARK_CLI_AS ?? "user",
      larkCliProfile: env.WECHAT_ARTICLE_LARK_CLI_PROFILE ?? "",
      larkCliTimeoutMs: Number.parseInt(env.LARK_CLI_TIMEOUT_MS ?? "20000", 10),
      titlePrefix: env.WECHAT_ARTICLE_PUSH_TITLE_PREFIX ?? "WeChat article update",
      pushFields: parseList(env.WECHAT_ARTICLE_PUSH_FIELDS ?? ""),
      loginReminderEnabled: env.WECHAT_LOGIN_REMINDER_ENABLED !== "false",
      loginReminderThresholdHours: Number.parseInt(env.WECHAT_LOGIN_REMINDER_THRESHOLD_HOURS ?? "12", 10),
      useDynamicSubscriptions: env.WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS !== "false",
    },
  };
}

function parseList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMap(value) {
  return Object.fromEntries(
    String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf(":");
        if (separator === -1) return [item, ""];
        return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
      })
      .filter(([key, label]) => key && label),
  );
}
