#!/usr/bin/env python3
import datetime as dt
import json
import os
import re
import smtplib
import socket
import subprocess
import sys
from email.message import EmailMessage
from pathlib import Path

CONFIG = {
    "EMAIL_TO": "",
    "WATCH_SERVICE": "xray",
    "WATCH_PORTS": "443,8443",
    "MONTHLY_PER_IP_LIMIT_BYTES": str(20 * 1024**3),
    "DAILY_TOTAL_LIMIT_BYTES": str(30 * 1024**3),
    "STATE_DIR": "/var/lib/pingu-traffic-guard",
    "ALERT_LOG": "/var/log/pingu-traffic-guard-alerts.log",
}


def load_shell_config(path="/etc/pingu-traffic-guard.conf"):
    if not os.path.exists(path):
        return
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        CONFIG[key.strip()] = value


def run(cmd, check=False):
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def write_json(path, data):
    tmp = f"{path}.tmp"
    Path(tmp).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


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


def nft_set_bytes(set_name, family):
    proc = run(["nft", "list", "set", "inet", "pingu_guard", set_name])
    if proc.returncode != 0:
        return {}
    result = {}
    if family == "ipv4":
        ip_re = r"(?P<ip>(?:\d{1,3}\.){3}\d{1,3})"
    else:
        ip_re = r"(?P<ip>[0-9a-fA-F:]{2,})"
    pattern = re.compile(ip_re + r"[^\n{}]*counter packets \d+ bytes (?P<bytes>\d+)")
    for line in proc.stdout.splitlines():
        for match in pattern.finditer(line):
            result[match.group("ip")] = int(match.group("bytes"))
    return result


def emergency_drop_exists():
    proc = run(["nft", "-a", "list", "chain", "inet", "pingu_guard", "input"])
    return "pingu emergency stop" in proc.stdout


def install_emergency_drop():
    if emergency_drop_exists():
        return
    ports = CONFIG["WATCH_PORTS"].replace(",", ", ")
    run(
        [
            "nft",
            "insert",
            "rule",
            "inet",
            "pingu_guard",
            "input",
            "tcp",
            "dport",
            "{",
            ports,
            "}",
            "counter",
            "drop",
            "comment",
            "pingu emergency stop",
        ]
    )


def ban_ip(ip, family):
    target = "banned4" if family == "ipv4" else "banned6"
    run(
        [
            "nft",
            "add",
            "element",
            "inet",
            "pingu_guard",
            target,
            "{",
            ip,
            "timeout",
            "31d",
            "}",
        ],
        check=False,
    )


def append_alert(subject, body):
    log = Path(CONFIG["ALERT_LOG"])
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as f:
        f.write(f"\n[{now_iso()}] {subject}\n{body}\n")


def send_via_mail(subject, body, to_addr):
    if not Path("/usr/bin/mail").exists() and not Path("/bin/mail").exists():
        return False, "mail command not installed"
    proc = subprocess.run(
        ["mail", "-s", subject, to_addr],
        input=body,
        text=True,
        capture_output=True,
        timeout=20,
    )
    return proc.returncode == 0, (proc.stderr or proc.stdout or "mail command failed")


def send_via_sendmail(subject, body, to_addr):
    candidates = ["/usr/sbin/sendmail", "/usr/lib/sendmail"]
    sendmail = next((p for p in candidates if Path(p).exists()), "")
    if not sendmail:
        return False, "sendmail not installed"
    msg = f"To: {to_addr}\nSubject: {subject}\nContent-Type: text/plain; charset=utf-8\n\n{body}\n"
    proc = subprocess.run(
        [sendmail, "-t"], input=msg, text=True, capture_output=True, timeout=20
    )
    return proc.returncode == 0, (proc.stderr or proc.stdout or "sendmail failed")


def mx_hosts(domain):
    proc = run(["dig", "+short", "mx", domain])
    hosts = []
    for line in proc.stdout.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2:
            hosts.append((int(parts[0]), parts[1].rstrip(".")))
    return [host for _, host in sorted(hosts)]


def send_direct_smtp(subject, body, to_addr):
    domain = to_addr.split("@", 1)[-1]
    hosts = mx_hosts(domain)
    if not hosts:
        return False, "no MX records"
    msg = EmailMessage()
    msg["From"] = "pingu-guard@cksheuen.site"
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body)
    last_error = ""
    for host in hosts[:3]:
        try:
            with smtplib.SMTP(host, 25, timeout=15) as smtp:
                smtp.ehlo_or_helo_if_needed()
                smtp.send_message(msg)
                return True, f"sent via MX {host}"
        except (OSError, smtplib.SMTPException, socket.timeout) as exc:
            last_error = f"{host}: {exc}"
    return False, last_error or "direct SMTP failed"


def alert(subject, body):
    append_alert(subject, body)
    to_addr = CONFIG["EMAIL_TO"]
    if not to_addr:
        append_alert(f"{subject} delivery skipped", "EMAIL_TO is not configured")
        return False
    attempts = []
    for sender in (send_via_mail, send_via_sendmail, send_direct_smtp):
        ok, detail = sender(subject, body, to_addr)
        attempts.append(f"{sender.__name__}: {'ok' if ok else detail}")
        if ok:
            append_alert(f"{subject} delivery", "\n".join(attempts))
            return True
    append_alert(f"{subject} delivery failed", "\n".join(attempts))
    return False


def enforce_daily_total(state_dir):
    today = dt.date.today().isoformat()
    path = state_dir / "daily-total.json"
    state = read_json(path, {})
    current = total_iface_bytes()
    if state.get("date") != today:
        state = {"date": today, "baseline_bytes": current, "tripped": False}
        write_json(path, state)
        return []
    growth = current - int(state.get("baseline_bytes", current))
    limit = int(CONFIG["DAILY_TOTAL_LIMIT_BYTES"])
    if growth > limit and not state.get("tripped"):
        state["tripped"] = True
        state["tripped_at"] = now_iso()
        state["growth_bytes"] = growth
        write_json(path, state)
        run(["systemctl", "stop", CONFIG["WATCH_SERVICE"]], check=False)
        install_emergency_drop()
        subject = "Pingu traffic emergency stop"
        body = (
            "Daily interface traffic growth exceeded limit.\n"
            f"Growth bytes: {growth}\n"
            f"Limit bytes: {limit}\n"
            f"Service stopped: {CONFIG['WATCH_SERVICE']}\n"
            f"Time: {now_iso()}\n"
        )
        alert(subject, body)
        return [body]
    write_json(path, state)
    return []


def enforce_monthly_ip(state_dir):
    month = dt.date.today().strftime("%Y-%m")
    path = state_dir / "monthly-ip.json"
    state = read_json(path, {})
    if state.get("month") != month:
        state = {"month": month, "acct4": {}, "acct6": {}, "banned": []}
    limit = int(CONFIG["MONTHLY_PER_IP_LIMIT_BYTES"])
    events = []
    for family, set_name, key in (
        ("ipv4", "acct4", "acct4"),
        ("ipv6", "acct6", "acct6"),
    ):
        counters = nft_set_bytes(set_name, family)
        baselines = state.setdefault(key, {})
        for ip, current in counters.items():
            base = int(baselines.setdefault(ip, current))
            used = max(0, current - base)
            if used > limit and f"{family}:{ip}" not in state.setdefault("banned", []):
                ban_ip(ip, family)
                state["banned"].append(f"{family}:{ip}")
                subject = "Pingu source IP banned"
                body = (
                    "Source IP exceeded monthly limit.\n"
                    f"Family: {family}\n"
                    f"IP: {ip}\n"
                    f"Used bytes: {used}\n"
                    f"Limit bytes: {limit}\n"
                    f"Time: {now_iso()}\n"
                )
                alert(subject, body)
                events.append(body)
    write_json(path, state)
    return events


def status(state_dir):
    data = {
        "time": now_iso(),
        "daily": read_json(state_dir / "daily-total.json", {}),
        "monthly": read_json(state_dir / "monthly-ip.json", {}),
        "acct4": nft_set_bytes("acct4", "ipv4"),
        "acct6": nft_set_bytes("acct6", "ipv6"),
        "emergency_drop": emergency_drop_exists(),
    }
    print(json.dumps(data, indent=2, sort_keys=True))


def main():
    load_shell_config()
    state_dir = Path(CONFIG["STATE_DIR"])
    state_dir.mkdir(parents=True, exist_ok=True)
    if "--status" in sys.argv:
        status(state_dir)
        return
    if "--test-alert" in sys.argv:
        ok = alert(
            "Pingu guard test alert",
            f"This is a test alert from {socket.gethostname()} at {now_iso()}.",
        )
        print(json.dumps({"test_alert_sent": ok, "log": CONFIG["ALERT_LOG"]}))
        return
    events = []
    events.extend(enforce_daily_total(state_dir))
    events.extend(enforce_monthly_ip(state_dir))
    print(
        json.dumps(
            {"time": now_iso(), "events": events, "alert_log": CONFIG["ALERT_LOG"]}
        )
    )


if __name__ == "__main__":
    main()
