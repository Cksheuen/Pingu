#!/usr/bin/env bash
set -euo pipefail

cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- start
