FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY vendor/wechat-download-api ./wechat-download-api
COPY deploy/cloud/start.sh ./start.sh

RUN python3 -m venv /opt/wechat-api-venv \
    && /opt/wechat-api-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/wechat-api-venv/bin/pip install --no-cache-dir -r /app/wechat-download-api/requirements.txt \
    && chmod +x /app/start.sh \
    && mkdir -p /data/wechat-api /data/backend

ENV NODE_ENV=production \
    BACKEND_PORT=3000 \
    WECHAT_ARTICLE_POLL_ENABLED=true \
    WECHAT_ARTICLE_POLL_ON_START=true \
    WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS=true \
    WECHAT_DOWNLOAD_API_BASE=http://127.0.0.1:5000 \
    WECHAT_ARTICLE_STATE_PATH=/data/backend/wechat-article-push-state.json \
    RSS_DB_PATH=/data/wechat-api/rss.db

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -sf "http://127.0.0.1:${PORT:-5000}/api/health" || exit 1

CMD ["/app/start.sh"]
