#!/usr/bin/env bash
set -euo pipefail

PUBLIC_PORT="${PORT:-5000}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
WECHAT_DATA_DIR="${WECHAT_DATA_DIR:-/data/wechat-api}"
BACKEND_DATA_DIR="${BACKEND_DATA_DIR:-/data/backend}"

mkdir -p "$WECHAT_DATA_DIR" "$BACKEND_DATA_DIR"

rm -rf /app/wechat-download-api/data
ln -s "$WECHAT_DATA_DIR" /app/wechat-download-api/data
touch "$WECHAT_DATA_DIR/.env"
ln -sf "$WECHAT_DATA_DIR/.env" /app/wechat-download-api/.env

export RSS_DB_PATH="${RSS_DB_PATH:-$WECHAT_DATA_DIR/rss.db}"
export WECHAT_DOWNLOAD_API_BASE="http://127.0.0.1:$PUBLIC_PORT"
export WECHAT_ARTICLE_STATE_PATH="${WECHAT_ARTICLE_STATE_PATH:-$BACKEND_DATA_DIR/wechat-article-push-state.json}"
export WECHAT_ARTICLE_POLL_ENABLED="${WECHAT_ARTICLE_POLL_ENABLED:-true}"
export WECHAT_ARTICLE_POLL_ON_START="${WECHAT_ARTICLE_POLL_ON_START:-true}"
export WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS="${WECHAT_ARTICLE_DYNAMIC_SUBSCRIPTIONS:-true}"

cd /app/wechat-download-api
/opt/wechat-api-venv/bin/uvicorn app:app --host 0.0.0.0 --port "$PUBLIC_PORT" &
wechat_pid="$!"

until curl -sf "http://127.0.0.1:$PUBLIC_PORT/api/health" >/dev/null; do
  sleep 1
done

cd /app
PORT="$BACKEND_PORT" node src/server.js &
backend_pid="$!"

term() {
  kill "$backend_pid" "$wechat_pid" 2>/dev/null || true
}
trap term INT TERM

wait -n "$wechat_pid" "$backend_pid"
term
