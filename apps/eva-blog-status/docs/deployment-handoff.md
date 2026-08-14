# Deployment boundary

This app is a local author tool and must not be deployed under the public Eva
Blog output. If hosted temporarily, restrict it to a private network and keep
the author API origin and OAuth redirect origin allowlisted.

The local bridge endpoint is `GET /api/local/signals`. It is intentionally
served only by the local dev server; it is not part of the public Worker or
author API deployment. The dev server enforces a loopback bind and refuses
network hosts. The endpoint may execute AppleScript media probes and read
either the explicit local token snapshot or the current Codex session's latest
`token_count` counters, so keep the process on the author device. The signal
payload contains only the safe summary needed by the UI; transcript content,
credentials, and raw session lines are not sent to the author API.

The recommended unattended deployment is the `scripts/daemon.mjs` CLI. It has
no HTTP listener and uses one serialized 60-second timer. Configure its
short-lived `status:auto` bearer token through stdin or `STATUS_DAEMON_TOKEN`;
the local config file is mode `0600`. Run it under the author's user account,
not as a public service, and stop it with `SIGTERM` when the author signs out.
