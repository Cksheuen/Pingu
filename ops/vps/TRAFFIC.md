# Pingu traffic maintenance

The VPS has two complementary tools:

- `pingu-traffic-guard`: enforces daily and per-source limits, can stop the
  watched proxy service, installs an emergency nftables drop, and records
  delivery attempts.
- `pingu-traffic-report`: produces a read-only summary of vnstat bandwidth,
  proxy-core accepted connections, SSH authentication activity, guard state,
  and recent alerts.

`pingu-traffic-report` reads the proxy core's journal from a **hardcoded**
`mihomo.service` unit. `WATCH_SERVICE` in the guard config controls what the
guard stops and what the report shows as service state — it does not redirect
the report's journal read. Both tools were updated for the Mihomo runtime, and
the migration contract changes only that one key in the live config, leaving the
rest of the guard implementation — which differs from this repository's
baseline — untouched. `WATCH_PORTS` stays `443,8443`, and the default limits
remain 30 GiB/day total and 20 GiB/month per source.

## What the report actually reads

- **Bandwidth** comes from `vnstat --json`, daily and hourly, for the requested
  window. Daily rows are the full-day source of truth; peak hours are derived
  from the hourly rows. When vnstat has no rows for the window, the report says
  so explicitly rather than reporting zero.
- **Accepted connections** come from the proxy core's systemd journal
  (`journalctl -u mihomo.service -o json`), parsed with a bounded read of the
  most recent 20000 journal entries. Each entry is matched against the core's
  access-log line shape
  (`[TCP|UDP] <src>:<port> --> <dst> match <rule> using <route>`) and counted by
  date, source, destination and route. When nothing matches, the report shows a
  matched count of 0 with no entries listed; when the 20000-entry cap is reached
  it says the window was limited, rather than implying the counts are complete.
  A failed journal read is reported as an error line.
- **SSH activity** comes from `journalctl -u ssh`, split into accepted, failed
  and invalid attempts by source IP and by user.
- **Guard state** is read from the guard's own state directory
  (`/var/lib/pingu-traffic-guard/daily-total.json`) for the baseline date,
  tripped flag and growth, with the current total summed from the non-loopback
  interface counters under `/sys/class/net`. The report also prints the
  configured watch ports, the daily and monthly limits, whether the emergency
  drop is present in the `inet pingu_guard` input chain, and whether the core
  service and both timers are active. (The guard itself, not the report, is what
  reads the live `acct4`/`acct6` nft counters.)

The report never queries the core's own API and never writes to it.

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

The timers themselves are unchanged by the core migration: the guard runs every
5 minutes (after a 2-minute boot delay), and the daily report runs
`pingu-traffic-report --days 7 --output-dir /var/log/pingu-traffic-reports`,
which writes a timestamped file, repoints `latest.txt` at it, and prunes
reports older than the retention window.
