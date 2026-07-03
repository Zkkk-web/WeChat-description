import { pollWechatArticles } from "../hooks/wechatArticlePoller.js";
import { json } from "../http.js";

export function wechatArticlesRoute(config = {}) {
  return {
    method: "POST",
    path: "/wechat/articles/poll",
    async handler(_req, res) {
      if (!config.wechatArticles?.enabled) {
        json(res, 409, { ok: false, error: "wechat_article_poll_disabled" });
        return;
      }

      const result = await pollWechatArticles(config.wechatArticles, { fetch: config.fetch });
      json(res, 200, { ok: true, result });
    },
  };
}
