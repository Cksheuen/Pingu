"""VPS layer sources.

Layout mirrors the deployment targets:
- sbin/: scripts deployed to /usr/local/sbin/
- systemd/: units deployed to /etc/systemd/system/
- nftables/: firewall policy deployed to /etc/nftables.d/
- config/: configuration schemas and non-secret fragments
- tests/: unittest suite, runnable without Linux or the VPS
"""
