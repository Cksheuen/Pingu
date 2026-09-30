const rust = (files, filters, dependencies = []) => ({
  kind: 'rust', sources: files.map(file => `src-tauri/src/${file}`),
  filters, dependencies,
});

// Dependencies are production inputs only: changing one module's tests does
// not invalidate its consumers. Add a new module here with its real consumers.
export const scopes = {
  traffic: rust(['traffic_monitor.rs', 'commands/traffic.rs'], ['traffic_monitor::']),
  logs: rust(['mihomo/log_writer.rs', 'mihomo/process.rs', 'commands/logs.rs'], ['mihomo::log_writer::', 'mihomo::process::']),
  nodes: {
    ...rust(['mihomo/uri_parser.rs', 'mihomo/subscription.rs'], ['mihomo::uri_parser::', 'mihomo::subscription::']),
    // subscription.rs reuses the fetch security boundary implemented here;
    // this is a shared production input, not a scope dependency cycle.
    sharedSources: ['src-tauri/src/mihomo/profiles.rs'],
  },
  chain: {
    ...rust(['chain.rs', 'chain/probe.rs', 'chain/latency.rs', 'commands/chain.rs'], ['chain::'], ['nodes', 'gate']),
    sharedSources: ['src-tauri/src/storage/app_config.rs', 'src-tauri/src/mihomo/config_gen.rs', 'src-tauri/src/mihomo/profiles.rs', 'src-tauri/src/mihomo/controller.rs'],
  },
  config: rust(['storage/app_config.rs', 'storage/byted_internal.rs', 'storage/host_overrides.rs', 'commands/config.rs', 'commands/rules.rs', 'commands/host_overrides.rs', 'commands/settings.rs'], ['storage::app_config::'], ['nodes']),
  subscriptions: rust(['mihomo/profiles.rs', 'mihomo/controller.rs', 'commands/network.rs'], ['mihomo::profiles::', 'mihomo::controller::'], ['nodes']),
  routing: rust(['mihomo/config_gen.rs'], ['mihomo::config_gen::'], ['config', 'subscriptions', 'chain']),
  runtime: rust(['proxy_runtime.rs'], ['proxy_runtime::'], ['routing']),
  gate: rust(['gate.rs', 'storage/gate_config.rs', 'commands/gate.rs'], ['gate::', 'storage::gate_config::']),
  system: rust(['system/mod.rs', 'system/proxy_macos.rs'], ['system::proxy_macos::']),
  lifecycle: rust(['lifecycle.rs', 'commands/proxy.rs'], ['lifecycle::'], ['runtime', 'traffic', 'logs', 'system', 'gate']),
  quit: rust(['lib.rs', 'tray.rs', 'commands/mod.rs', 'mihomo/mod.rs', 'storage/mod.rs'], ['exit_coordination_tests::']),
  cli: {
    kind: 'rust-check',
    sources: ['src-tauri/src/main.rs', 'src-tauri/src/bin/'],
    tests: [],
    dependencies: ['quit', 'runtime', 'logs', 'gate'],
  },
  frontend: {
    kind: 'frontend', dependencies: [],
    sources: ['src/lib/connection-store.ts', 'src/lib/connection-api.ts', 'src/lib/nodes-api.ts', 'src/lib/proxy-api.ts', 'src/lib/tauri-invoke.ts', 'src/lib/types.ts', 'src/lib/mihomo-api.ts', 'src/lib/chain-api.ts', 'src/lib/network-view.ts', 'src/lib/subscription-store.ts'],
    tests: ['tests/chain-api.test.ts', 'tests/connection-store.test.ts', 'tests/network-view.test.ts', 'tests/subscription-store.test.ts', 'tests/node-shims.d.ts'],
  },
  ui: { kind: 'typecheck', sources: ['src/'], tests: [], dependencies: [] },
  runner: {
    kind: 'node', dependencies: [],
    sources: ['scripts/test.mjs', 'scripts/test-scopes.mjs'],
    tests: ['scripts/test-runner.test.mjs'],
  },
};

for (const scope of Object.values(scopes)) {
  if (scope.kind !== 'rust') continue;
  scope.tests = scope.sources.filter(file => file.endsWith('.rs') && !file.endsWith('/lib.rs'))
    .map(file => `${file.slice(0, -3)}/`);
}
scopes.quit.tests.push('src-tauri/src/exit_coordination_tests.rs');
