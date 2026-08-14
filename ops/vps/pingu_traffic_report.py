#!/usr/bin/env python3
import argparse
import datetime as dt
import gzip
import json
import os
import re
import subprocess
from collections import Counter
from pathlib import Path

GUARD_CONFIG = Path("/etc/pingu-traffic-guard.conf")
GUARD_STATE_DIR = Path("/var/lib/pingu-traffic-guard")
GUARD_ALERT_LOG = Path("/var/log/pingu-traffic-guard-alerts.log")
XRAY_LOG_DIR = Path("/var/log/xray")

XRAY_RE = re.compile(
    r"^(?P<date>\d{4}/\d{2}/\d{2})\s+\S+\s+from\s+"
    r"(?P<src>\[[^\]]+\]|[^: ]+):\d+\s+accepted\s+"
    r"(?P<proto>\w+):(?P<dst>\[[^\]]+\]:\d+|[^ ]+)\s+"
    r"\[(?P<route>[^\]]+)\](?:\s+email:\s*(?P<email>\S+))?"
)


def run(cmd, timeout=15):
    try:
        return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)
    except Exception as exc:

        class Result:
            returncode = 1
            stdout = ""
            stderr = str(exc)

        return Result()


def human_bytes(value):
    try:
        value = float(value)
    except Exception:
        return "n/a"
    units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]
    idx = 0
    while value >= 1024 and idx < len(units) - 1:
        value /= 1024
        idx += 1
    if idx == 0:
        return f"{int(value)} {units[idx]}"
    return f"{value:.2f} {units[idx]}"


def pct(part, total):
    if not total:
        return "n/a"
    return f"{part / total * 100:.1f}%"


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def load_guard_config():
    cfg = {
        "WATCH_SERVICE": "xray",
        "WATCH_PORTS": "443,8443",
        "DAILY_TOTAL_LIMIT_BYTES": str(30 * 1024**3),
        "MONTHLY_PER_IP_LIMIT_BYTES": str(20 * 1024**3),
        "STATE_DIR": str(GUARD_STATE_DIR),
        "ALERT_LOG": str(GUARD_ALERT_LOG),
    }
    if not GUARD_CONFIG.exists():
        return cfg
    for raw in GUARD_CONFIG.read_text(errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        cfg[key.strip()] = value.strip().strip('"').strip("'")
    return cfg


def service_active(name):
    proc = run(["systemctl", "is-active", name], timeout=5)
    text = (proc.stdout or proc.stderr).strip()
    return text or "unknown"


def total_iface_bytes():
    total = 0
    for dev in Path("/sys/class/net").iterdir():
        if dev.name == "lo":
            continue
        for leaf in ("rx_bytes", "tx_bytes"):
            try:
                total += int((dev / "statistics" / leaf).read_text().strip())
            except Exception:
                pass
    return total


def emergency_drop_exists():
    proc = run(
        ["nft", "-a", "list", "chain", "inet", "pingu_guard", "input"], timeout=8
    )
    return "pingu emergency stop" in proc.stdout


def vnstat_json(mode):
    proc = run(["vnstat", "--json", mode], timeout=10)
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip()
    try:
        return json.loads(proc.stdout), ""
    except Exception as exc:
        return None, str(exc)


def date_from_obj(obj):
    return dt.date(int(obj["year"]), int(obj["month"]), int(obj["day"]))


def summarize_vnstat(days):
    today = dt.date.today()
    start = today - dt.timedelta(days=max(days, 1) - 1)
    daily_rows = []
    hourly_rows = []

    data, err = vnstat_json("d")
    if data:
        for iface in data.get("interfaces", []):
            name = iface.get("name", "unknown")
            for row in iface.get("traffic", {}).get("day", []):
                day = date_from_obj(row["date"])
                if day < start:
                    continue
                rx = int(row.get("rx", 0))
                tx = int(row.get("tx", 0))
                daily_rows.append((day.isoformat(), name, rx, tx, rx + tx))

    hdata, herr = vnstat_json("h")
    if hdata:
        for iface in hdata.get("interfaces", []):
            name = iface.get("name", "unknown")
            for row in iface.get("traffic", {}).get("hour", []):
                day = date_from_obj(row["date"])
                if day < start:
                    continue
                hour = int(row.get("time", {}).get("hour", 0))
                rx = int(row.get("rx", 0))
                tx = int(row.get("tx", 0))
                hourly_rows.append(
                    (rx + tx, f"{day.isoformat()} {hour:02d}:00", name, rx, tx)
                )
    hourly_rows.sort(reverse=True)
    return daily_rows, hourly_rows[:10], err or herr


def xray_log_paths():
    if not XRAY_LOG_DIR.exists():
        return []
    paths = [path for path in XRAY_LOG_DIR.glob("access.log*") if path.is_file()]
    return sorted(paths, key=lambda p: p.stat().st_mtime)


def open_log(path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", errors="ignore")
    return path.open("r", errors="ignore")


def summarize_xray(days):
    today = dt.date.today()
    start = today - dt.timedelta(days=max(days, 1) - 1)
    by_date = Counter()
    by_source = Counter()
    by_dest = Counter()
    by_route = Counter()
    by_email = Counter()
    total = 0
    matched = 0
    for path in xray_log_paths():
        try:
            fh = open_log(path)
        except Exception:
            continue
        with fh:
            for line in fh:
                total += 1
                match = XRAY_RE.search(line)
                if not match:
                    continue
                try:
                    day = dt.datetime.strptime(match.group("date"), "%Y/%m/%d").date()
                except Exception:
                    continue
                if day < start:
                    continue
                matched += 1
                source = match.group("src").strip("[]")
                dest = match.group("dst")
                route = match.group("route")
                email = match.group("email") or "-"
                by_date[day.isoformat()] += 1
                by_source[source] += 1
                by_dest[dest] += 1
                by_route[route] += 1
                by_email[email] += 1
    return {
        "files": [str(path) for path in xray_log_paths()],
        "total_lines": total,
        "matched_recent": matched,
        "by_date": by_date,
        "by_source": by_source,
        "by_dest": by_dest,
        "by_route": by_route,
        "by_email": by_email,
    }


def summarize_ssh(days):
    proc = run(
        ["journalctl", "-u", "ssh", "--since", f"{max(days, 1)} days ago", "--no-pager"],
        timeout=15,
    )
    accepted_ip = Counter()
    accepted_user = Counter()
    failed_ip = Counter()
    failed_user = Counter()
    invalid_ip = Counter()
    invalid_user = Counter()
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip()
    for line in proc.stdout.splitlines():
        match = re.search(r"Accepted \S+ for (\S+) from ([0-9a-fA-F:.]+)", line)
        if match:
            accepted_user[match.group(1)] += 1
            accepted_ip[match.group(2)] += 1
            continue
        match = re.search(r"Invalid user (\S+) from ([0-9a-fA-F:.]+)", line)
        if match:
            invalid_user[match.group(1)] += 1
            invalid_ip[match.group(2)] += 1
            continue
        match = re.search(
            r"Failed password for(?: invalid user)? (\S+) from ([0-9a-fA-F:.]+)",
            line,
        )
        if match:
            failed_user[match.group(1)] += 1
            failed_ip[match.group(2)] += 1
    return {
        "accepted_ip": accepted_ip,
        "accepted_user": accepted_user,
        "failed_ip": failed_ip,
        "failed_user": failed_user,
        "invalid_ip": invalid_ip,
        "invalid_user": invalid_user,
    }, ""


def top_lines(counter, limit=10, value_suffix=""):
    if not counter:
        return ["  - none"]
    return [
        f"  - {value}{value_suffix}  {key}"
        for key, value in counter.most_common(limit)
    ]


def recent_alert_lines(limit=40):
    if not GUARD_ALERT_LOG.exists():
        return ["  - no alert log"]
    proc = run(["tail", "-n", str(limit), str(GUARD_ALERT_LOG)], timeout=5)
    text = proc.stdout.strip()
    if not text:
        return ["  - alert log is empty"]
    return ["  " + line for line in text.splitlines()]


def build_report(days):
    cfg = load_guard_config()
    now = dt.datetime.now(dt.timezone.utc).astimezone()
    host = run(["hostname"], timeout=5).stdout.strip() or "unknown"
    uname = run(["uname", "-srmo"], timeout=5).stdout.strip() or "unknown"
    daily_limit = int(cfg.get("DAILY_TOTAL_LIMIT_BYTES", "0") or 0)
    monthly_limit = int(cfg.get("MONTHLY_PER_IP_LIMIT_BYTES", "0") or 0)
    state_dir = Path(cfg.get("STATE_DIR", str(GUARD_STATE_DIR)))
    daily_state = read_json(state_dir / "daily-total.json", {})
    current_total = total_iface_bytes()
    baseline = int(daily_state.get("baseline_bytes", current_total) or current_total)
    growth = max(0, current_total - baseline)

    daily_rows, peak_hours, vnstat_err = summarize_vnstat(days)
    xray = summarize_xray(days)
    ssh, ssh_err = summarize_ssh(days)

    lines = []
    lines.append("Pingu Traffic Report")
    lines.append("====================")
    lines.append(f"Generated: {now.isoformat(timespec='seconds')}")
    lines.append(f"Host: {host}")
    lines.append(f"Kernel: {uname}")
    lines.append(f"Window: last {days} day(s)")
    lines.append("")

    lines.append("Services")
    lines.append("--------")
    lines.append(f"xray: {service_active('xray')}")
    lines.append(
        f"pingu-traffic-guard.timer: {service_active('pingu-traffic-guard.timer')}"
    )
    lines.append(
        f"pingu-traffic-report.timer: {service_active('pingu-traffic-report.timer')}"
    )
    lines.append(f"watch ports: {cfg.get('WATCH_PORTS', 'unknown')}")
    lines.append("")

    lines.append("Guard State")
    lines.append("-----------")
    lines.append(f"daily limit: {human_bytes(daily_limit)}")
    lines.append(f"monthly per-source limit: {human_bytes(monthly_limit)}")
    lines.append(f"guard baseline date: {daily_state.get('date', 'unknown')}")
    lines.append(
        f"guard growth since baseline: {human_bytes(growth)} "
        f"({pct(growth, daily_limit)} of daily limit)"
    )
    lines.append("full-day bandwidth source: vnstat daily rows below")
    lines.append(f"daily tripped: {daily_state.get('tripped', False)}")
    lines.append(f"emergency drop installed: {emergency_drop_exists()}")
    lines.append("")

    lines.append("Bandwidth By Day (vnstat)")
    lines.append("-------------------------")
    if vnstat_err and not daily_rows:
        lines.append(f"  - vnstat unavailable: {vnstat_err}")
    elif not daily_rows:
        lines.append("  - no vnstat daily rows in window")
    else:
        for day, iface, rx, tx, total in sorted(daily_rows):
            lines.append(
                f"  - {day} {iface}: rx {human_bytes(rx)}, "
                f"tx {human_bytes(tx)}, total {human_bytes(total)}"
            )
    lines.append("")

    lines.append("Peak Hours (vnstat)")
    lines.append("--------------------")
    if not peak_hours:
        lines.append("  - no vnstat hourly rows in window")
    else:
        for total, hour, iface, rx, tx in peak_hours:
            lines.append(
                f"  - {hour} {iface}: total {human_bytes(total)} "
                f"(rx {human_bytes(rx)}, tx {human_bytes(tx)})"
            )
    lines.append("")

    lines.append("Xray Access Connections")
    lines.append("-----------------------")
    lines.append(
        "Note: xray access logs count accepted connections; byte volume comes "
        "from vnstat/nft counters."
    )
    lines.append(f"files: {', '.join(xray['files']) if xray['files'] else 'none'}")
    lines.append(f"matched connections in window: {xray['matched_recent']}")
    lines.append("by date:")
    lines.extend(top_lines(xray["by_date"], limit=14))
    lines.append("top source IPs:")
    lines.extend(top_lines(xray["by_source"], limit=10))
    lines.append("top destinations:")
    lines.extend(top_lines(xray["by_dest"], limit=10))
    lines.append("routes:")
    lines.extend(top_lines(xray["by_route"], limit=10))
    lines.append("users:")
    lines.extend(top_lines(xray["by_email"], limit=10))
    lines.append("")

    lines.append("SSH Auth")
    lines.append("--------")
    if ssh_err and not ssh:
        lines.append(f"  - ssh journal unavailable: {ssh_err}")
    else:
        accepted_total = sum(ssh["accepted_ip"].values())
        failed_total = sum(ssh["failed_ip"].values())
        invalid_total = sum(ssh["invalid_ip"].values())
        lines.append(
            f"accepted: {accepted_total}; failed password: {failed_total}; "
            f"invalid user: {invalid_total}"
        )
        lines.append("accepted by IP:")
        lines.extend(top_lines(ssh["accepted_ip"], limit=10))
        lines.append("invalid-user scan by IP:")
        lines.extend(top_lines(ssh["invalid_ip"], limit=10))
        lines.append("invalid usernames:")
        lines.extend(top_lines(ssh["invalid_user"], limit=10))
    lines.append("")

    lines.append("Recent Guard Alerts")
    lines.append("-------------------")
    lines.extend(recent_alert_lines())
    lines.append("")

    lines.append("Maintenance Commands")
    lines.append("--------------------")
    lines.append("  pingu-traffic-report --days 7")
    lines.append(
        "  pingu-traffic-report --days 7 --output-dir /var/log/pingu-traffic-reports"
    )
    lines.append("  tail -n +1 /var/log/pingu-traffic-reports/latest.txt")
    lines.append("  /usr/local/sbin/pingu-traffic-guard --status")
    lines.append(
        "  systemctl status pingu-traffic-guard.timer "
        "pingu-traffic-report.timer --no-pager"
    )
    lines.append(
        "  journalctl -u pingu-traffic-guard.service "
        "-u pingu-traffic-report.service --since today --no-pager"
    )
    lines.append("")
    return "\n".join(lines)


def cleanup_reports(output_dir, retention_days):
    if retention_days <= 0:
        return
    cutoff = dt.datetime.now().timestamp() - retention_days * 86400
    for path in output_dir.glob("traffic-report-*.txt"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(
        description="Generate a readable Pingu traffic maintenance report."
    )
    parser.add_argument(
        "--days", type=int, default=7, help="Lookback window in days. Default: 7"
    )
    parser.add_argument(
        "--output-dir", help="Write report into this directory instead of stdout."
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=45,
        help="Delete generated reports older than this when --output-dir is used.",
    )
    args = parser.parse_args()

    report = build_report(max(1, args.days))
    if not args.output_dir:
        print(report)
        return

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).astimezone().strftime("%Y%m%dT%H%M%S%z")
    path = output_dir / f"traffic-report-{stamp}.txt"
    tmp = output_dir / f".{path.name}.tmp"
    tmp.write_text(report + "\n")
    os.replace(tmp, path)
    latest = output_dir / "latest.txt"
    try:
        latest.unlink()
    except FileNotFoundError:
        pass
    latest.symlink_to(path.name)
    cleanup_reports(output_dir, args.retention_days)
    print(path)


if __name__ == "__main__":
    main()
