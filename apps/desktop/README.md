# Pingu Desktop

Pingu validates the saved route before enabling the macOS system proxy. Rule and node changes keep the public proxy listener on `127.0.0.1:2080`.

For an unattended launch, quit any existing Pingu instance, then run:

```sh
/Applications/Pingu.app/Contents/MacOS/pingu --connect
```

The flag uses the same connection, content-verification, rollback and shutdown lifecycle as the Connect button. A failed startup does not publish a connected state or take over the system proxy. Launching without the flag keeps the normal manual-connect behavior.

Run `pnpm test --plan` before verification. See [AGENTS.md](AGENTS.md) for the scoped test workflow.
