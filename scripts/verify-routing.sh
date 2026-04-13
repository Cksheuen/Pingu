#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBUG_PROXY_BIN="${ROOT_DIR}/src-tauri/target/debug/debug-proxy"
PROXY_URL="http://127.0.0.1:2080"
LOG_FILE="$(mktemp /tmp/sing-proxy-routing-log.XXXXXX)"
PID_FILE="$(mktemp /tmp/sing-proxy-routing-pid.XXXXXX)"
PATTERN_FILE="$(mktemp /tmp/sing-proxy-routing-patterns.XXXXXX)"

cleanup() {
  if [[ -f "${PID_FILE}" ]]; then
    PROXY_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  fi

  if [[ -n "${PROXY_PID:-}" ]]; then
    python3 - "${PROXY_PID}" <<'PY' >/dev/null 2>&1 || true
import os
import signal
import sys
import time

pid = int(sys.argv[1])
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        break
    time.sleep(0.2)
PY
  fi

  rm -f "${PID_FILE}"
  rm -f "${PATTERN_FILE}"
  if [[ "${KEEP_LOG_FILE:-0}" != "1" ]]; then
    rm -f "${LOG_FILE}"
  fi
}
trap cleanup EXIT

echo "构建 debug-proxy..."
cargo build --manifest-path "${ROOT_DIR}/src-tauri/Cargo.toml" --bin debug-proxy >/dev/null

echo "启动 debug-proxy，日志输出到 ${LOG_FILE}"
python3 - "${ROOT_DIR}" "${DEBUG_PROXY_BIN}" "${LOG_FILE}" "${PID_FILE}" <<'PY'
import os
import subprocess
import sys

root_dir, debug_proxy_bin, log_path, pid_path = sys.argv[1:5]
with open(log_path, "ab", buffering=0) as log_file:
    proc = subprocess.Popen(
        [debug_proxy_bin, "start"],
        cwd=root_dir,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        preexec_fn=os.setsid,
    )

with open(pid_path, "w", encoding="utf-8") as handle:
    handle.write(str(proc.pid))
PY
PROXY_PID="$(cat "${PID_FILE}")"

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
  local code=""
  local attempt
  for attempt in 1 2 3; do
    code="$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 --proxy "${PROXY_URL}" "${url}" || true)"
    if [[ -n "${code}" && "${code}" != "000" ]]; then
      echo "${code}"
      return 0
    fi
    sleep 1
  done
  echo "${code}"
}

wait_for_expected_logs() {
  python3 - "${LOG_FILE}" "${PATTERN_FILE}" <<'PY'
import pathlib
import sys
import time

log_path = pathlib.Path(sys.argv[1])
pattern_path = pathlib.Path(sys.argv[2])
patterns = [line.strip() for line in pattern_path.read_text().splitlines() if line.strip()]

deadline = time.time() + 15
while time.time() < deadline:
    content = log_path.read_text(errors="ignore") if log_path.exists() else ""
    if all(pattern in content for pattern in patterns):
        sys.exit(0)
    time.sleep(1)

sys.exit(1)
PY
}

is_allowed_http_code() {
  local code="$1"
  local allowed_prefixes="$2"
  python3 - "${code}" "${allowed_prefixes}" <<'PY'
import sys

code = sys.argv[1]
allowed_prefixes = [item for item in sys.argv[2].split(",") if item]

if code and code != "000" and any(code.startswith(prefix) for prefix in allowed_prefixes):
    sys.exit(0)

sys.exit(1)
PY
}

echo "发起多目标分流验证..."
CASE_COUNT=0

while IFS=$'\t' read -r case_id case_label case_url case_host case_port expected_route allowed_prefixes case_source; do
  [[ -n "${case_id}" ]] || continue
  CASE_COUNT=$((CASE_COUNT + 1))
  code="$(request "${case_url}")"
  echo "${case_id} route=${expected_route} source=${case_source} url=${case_url} http_code=${code}"
  if ! is_allowed_http_code "${code}" "${allowed_prefixes}"; then
    KEEP_LOG_FILE=1
    echo "FAIL: ${case_label} 返回了非预期状态码 ${code}"
    echo "===== debug log ====="
    cat "${LOG_FILE}"
    exit 1
  fi

  if [[ "${expected_route}" == "direct" ]]; then
    echo "outbound/direct[direct]: outbound connection to ${case_host}:${case_port}" >> "${PATTERN_FILE}"
  else
    echo "outbound/vless[proxy]: outbound connection to ${case_host}:${case_port}" >> "${PATTERN_FILE}"
  fi
done < <(python3 "${ROOT_DIR}/scripts/routing_case_matrix.py" --format tsv)

if [[ "${CASE_COUNT}" -eq 0 ]]; then
  echo "FAIL: 未找到 routing 验证用例"
  exit 1
fi

echo "校验实际出站日志..."
if ! wait_for_expected_logs; then
  KEEP_LOG_FILE=1
  echo "FAIL: 日志中的实际出站与预期不一致"
  echo "log file kept at: ${LOG_FILE}"
  echo "===== debug log ====="
  cat "${LOG_FILE}"
  exit 1
fi

echo "PASS: 直连目标、代理目标与规则相关目标均可达，且日志确认 direct/proxy 出站符合预期。"
