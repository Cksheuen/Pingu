#!/usr/bin/env bash
set -euo pipefail

PROXY_URL="http://127.0.0.1:2080"
LOG_FILE="$(mktemp /tmp/sing-proxy-routing-log.XXXXXX)"

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]] && kill -0 "${PROXY_PID}" >/dev/null 2>&1; then
    kill "${PROXY_PID}" >/dev/null 2>&1 || true
    wait "${PROXY_PID}" >/dev/null 2>&1 || true
  fi
  if [[ "${KEEP_LOG_FILE:-0}" != "1" ]]; then
    rm -f "${LOG_FILE}"
  fi
}
trap cleanup EXIT

echo "构建 debug-proxy..."
cargo build --manifest-path src-tauri/Cargo.toml --bin debug-proxy >/dev/null

echo "启动 debug-proxy，日志输出到 ${LOG_FILE}"
script -q "${LOG_FILE}" src-tauri/target/debug/debug-proxy start >/dev/null 2>&1 &
PROXY_PID=$!

echo "等待本地代理监听 127.0.0.1:2080 ..."
python3 - <<'PY'
import socket
import sys
import time

deadline = time.time() + 30
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", 2080), timeout=1):
            sys.exit(0)
    except OSError:
        time.sleep(0.2)
sys.exit(1)
PY

request() {
  local url="$1"
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 --proxy "${PROXY_URL}" "${url}" || true)"
  echo "${code}"
}

echo "发起国内/国外请求..."
BAIDU_CODE="$(request "https://www.baidu.com")"
QQ_CODE="$(request "https://www.qq.com")"
GOOGLE_CODE="$(request "https://www.google.com")"
WIKI_CODE="$(request "https://www.wikipedia.org")"

echo "baidu=${BAIDU_CODE} qq=${QQ_CODE} google=${GOOGLE_CODE} wiki=${WIKI_CODE}"

for code in "${BAIDU_CODE}" "${QQ_CODE}" "${GOOGLE_CODE}" "${WIKI_CODE}"; do
  if [[ -z "${code}" || "${code}" == "000" ]]; then
    echo "FAIL: 至少一个站点不可达"
    echo "===== debug log ====="
    cat "${LOG_FILE}"
    exit 1
  fi
done

sleep 2

echo "校验实际出站日志..."
if ! grep -F "outbound/direct[direct]: outbound connection to www.baidu.com:443" "${LOG_FILE}" >/dev/null \
  || ! grep -F "outbound/direct[direct]: outbound connection to www.qq.com:443" "${LOG_FILE}" >/dev/null \
  || ! grep -F "outbound/vless[proxy]: outbound connection to www.google.com:443" "${LOG_FILE}" >/dev/null \
  || ! grep -F "outbound/vless[proxy]: outbound connection to www.wikipedia.org:443" "${LOG_FILE}" >/dev/null; then
  KEEP_LOG_FILE=1
  echo "FAIL: 日志中的实际出站与预期不一致"
  echo "log file kept at: ${LOG_FILE}"
  echo "===== debug log ====="
  cat "${LOG_FILE}"
  exit 1
fi

echo "PASS: 国内请求走 direct，国外请求走 vless proxy，且四个站点都可达。"
