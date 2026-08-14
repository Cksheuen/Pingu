# Pingu traffic maintenance

The VPS has two complementary tools:

- `pingu-traffic-guard`: enforces daily and per-source limits, can stop Xray,
  installs an emergency nftables drop, and records delivery attempts.
- `pingu-traffic-report`: produces a read-only summary of vnstat bandwidth,
  Xray accepted connections, SSH authentication activity, guard state, and
  recent alerts.

Common commands on the VPS:

```bash
pingu-traffic-report --days 7
pingu-traffic-report --days 7 --output-dir /var/log/pingu-traffic-reports
tail -n +1 /var/log/pingu-traffic-reports/latest.txt
/usr/local/sbin/pingu-traffic-guard --status
systemctl list-timers pingu-traffic-report.timer --no-pager
systemctl status pingu-traffic-guard.timer pingu-traffic-report.timer --no-pager
```

Reports are generated daily at 00:10 UTC and retained for 45 days by the
report script.
