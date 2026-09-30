import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./test.mjs', import.meta.url));

function command(cwd, command, args, env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
}

function fixture(scopeSource = `
export const scopes = {
  alpha: { kind: 'rust', sources: ['src-tauri/src/alpha.rs'], sharedSources: ['src-tauri/src/shared.rs'], tests: ['src-tauri/src/alpha/tests/'], filters: ['alpha::'], dependencies: [] },
  beta: { kind: 'rust', sources: ['src-tauri/src/beta.rs'], sharedSources: ['src-tauri/src/shared.rs'], tests: ['src-tauri/src/beta/tests/'], filters: ['beta::'], dependencies: [] },
  cli: { kind: 'rust-check', sources: ['src-tauri/src/main.rs'], tests: [], dependencies: ['alpha'] },
};
`) {
  const outer = mkdtempSync(join(tmpdir(), 'pingu-runner-'));
  const root = join(outer, 'repo');
  const bin = join(outer, 'bin');
  const log = join(outer, 'commands.log');
  const cache = join(outer, 'passed.json');
  const scopes = join(outer, 'scopes.mjs');
  const artifact = join(bin, 'fake-libtest');
  const gitTemplate = join(outer, 'empty-git-template');
  const gitConfig = join(outer, 'empty-gitconfig');
  mkdirSync(join(root, 'src-tauri/src/alpha/tests'), { recursive: true });
  mkdirSync(join(root, 'src-tauri/src/beta/tests'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(gitTemplate);
  writeFileSync(gitConfig, '');
  writeFileSync(join(root, 'src-tauri/src/alpha.rs'), 'pub fn alpha() {}\n');
  writeFileSync(join(root, 'src-tauri/src/beta.rs'), 'pub fn beta() {}\n');
  writeFileSync(join(root, 'src-tauri/src/main.rs'), 'fn main() {}\n');
  writeFileSync(join(root, 'src-tauri/src/shared.rs'), 'pub fn shared() {}\n');
  writeFileSync(scopes, scopeSource);
  writeFileSync(join(bin, 'rustc'), '#!/bin/sh\necho rustc-test\n');
  writeFileSync(join(bin, 'cargo'), `#!/bin/sh
echo "cargo:$*" >> "$PINGU_FAKE_LOG"
if [ "$1" = "test" ]; then
  printf '%s\n' '{"reason":"compiler-artifact","profile":{"test":true},"executable":"${artifact}","target":{"name":"pingu_lib"}}'
fi
if [ "$1" = "check" ]; then
  exit "\${PINGU_FAKE_CHECK_STATUS:-0}"
fi
`);
  writeFileSync(artifact, `#!/bin/sh
echo "test-invocation" >> "$PINGU_FAKE_LOG"
for filter in "$@"; do
  case "$filter" in
    alpha::) echo "observed:alpha" >> "$PINGU_FAKE_LOG" ;;
    beta::) echo "observed:beta" >> "$PINGU_FAKE_LOG" ;;
  esac
done
if [ -n "$PINGU_FAKE_MUTATE" ]; then
  echo mutation >> "$PINGU_FAKE_MUTATE"
fi
exit "\${PINGU_FAKE_TEST_STATUS:-0}"
`);
  for (const executable of ['rustc', 'cargo', 'fake-libtest']) chmodSync(join(bin, executable), 0o755);
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: gitTemplate,
  };
  command(root, 'git', ['init', '-q'], gitEnv);
  command(root, 'git', ['config', 'user.email', 'runner@example.test'], gitEnv);
  command(root, 'git', ['config', 'user.name', 'Runner Test'], gitEnv);
  command(root, 'git', ['add', '.'], gitEnv);
  command(root, 'git', ['commit', '-qm', 'fixture'], gitEnv);

  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PINGU_TEST_ROOT: root,
      PINGU_TEST_CACHE_PATH: cache,
      PINGU_TEST_SCOPES_MODULE: scopes,
      PINGU_FAKE_LOG: log,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: gitTemplate,
      ...extraEnv,
    },
  });
  return { outer, root, log, cache, gitEnv, run };
}

function cleanup(value) {
  rmSync(value.outer, { recursive: true, force: true });
}

test('planning selects unstamped scopes and rejects unowned source or test files', () => {
  const value = fixture();
  try {
    const fresh = value.run(['--plan']);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /"scopes":\["alpha","beta","cli"\]/);
    assert.equal(existsSync(value.cache), false);
    const unknown = ['src-tauri/src/unknown.rs', 'tests/unknown.test.mjs'];
    for (const path of unknown) {
      const absolute = join(value.root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'unknown\n');
    }
    const untracked = value.run(['--plan']);
    assert.notEqual(untracked.status, 0, `${untracked.stdout}\n${untracked.stderr}`);
    for (const path of unknown) assert.match(untracked.stderr, new RegExp(path.replaceAll('.', '\\.')));

    command(value.root, 'git', ['add', ...unknown], value.gitEnv);
    command(value.root, 'git', ['commit', '-qm', 'commit unknown inventory'], value.gitEnv);
    const committed = value.run(['--plan']);
    assert.notEqual(committed.status, 0, `${committed.stdout}\n${committed.stderr}`);
    for (const path of unknown) assert.match(committed.stderr, new RegExp(path.replaceAll('.', '\\.')));
  } finally {
    cleanup(value);
  }
});

test('execution unions filters, stamps transactionally, detects mutation, and skips warm scopes', () => {
  const value = fixture();
  try {
    const first = value.run(['--scope', 'alpha,beta']);
    assert.equal(first.status, 0, first.stderr);
    const log = readFileSync(value.log, 'utf8');
    assert.equal(log.match(/^cargo:test /gm)?.length, 1, log);
    assert.equal(log.match(/^test-invocation$/gm)?.length, 1, log);
    assert.match(log, /^observed:alpha$/m);
    assert.match(log, /^observed:beta$/m);

    const initialCache = readFileSync(value.cache, 'utf8');
    const failed = value.run(['--scope', 'alpha,cli'], { PINGU_FAKE_CHECK_STATUS: '9' });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(value.cache, 'utf8'), initialCache);

    const cli = value.run(['--scope', 'cli']);
    assert.equal(cli.status, 0, cli.stderr);

    const shared = join(value.root, 'src-tauri/src/shared.rs');
    const originalShared = readFileSync(shared, 'utf8');
    writeFileSync(shared, `${originalShared}// changed\n`);
    const sharedPlan = value.run(['--plan']);
    assert.equal(sharedPlan.status, 0, sharedPlan.stderr);
    assert.match(sharedPlan.stdout, /"scopes":\["alpha","beta","cli"\]/);
    writeFileSync(shared, originalShared);

    writeFileSync(value.log, '');
    const warm = value.run([]);
    assert.equal(warm.status, 0, warm.stderr);
    assert.match(warm.stdout, /"scopes":\[\]/);
    assert.equal(readFileSync(value.log, 'utf8'), '');

    const completeCache = readFileSync(value.cache, 'utf8');
    const source = join(value.root, 'src-tauri/src/alpha.rs');
    const mutated = value.run(['--scope', 'alpha'], { PINGU_FAKE_MUTATE: source });
    assert.notEqual(mutated.status, 0);
    assert.match(mutated.stderr, /alpha changed during verification/);
    assert.equal(readFileSync(value.cache, 'utf8'), completeCache);
  } finally {
    cleanup(value);
  }
});
