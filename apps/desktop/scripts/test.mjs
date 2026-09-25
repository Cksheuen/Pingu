import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = realpathSync(resolve(process.env.PINGU_TEST_ROOT ?? defaultRoot));
const cachePath = resolve(process.env.PINGU_TEST_CACHE_PATH ?? root, process.env.PINGU_TEST_CACHE_PATH ? '' : '.test-dist/passed-scopes.json');
const scopesModule = process.env.PINGU_TEST_SCOPES_MODULE
  ? pathToFileURL(resolve(process.env.PINGU_TEST_SCOPES_MODULE)).href
  : new URL('./test-scopes.mjs', import.meta.url).href;
const { scopes } = await import(scopesModule);
const args = process.argv.slice(2).filter(arg => arg !== '--');
let requested = [], all = false, plan = false;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--all') all = true;
  else if (arg === '--plan') plan = true;
  else if (arg === '--scope') requested.push(...(args[++index] ?? '').split(','));
  else if (arg === '--help') {
    console.log('test [--plan] [--scope traffic,logs,... | --all]\nDefault: only changed/unverified scopes. --scope/--all force execution.\nScopes: ' + Object.keys(scopes).join(', '));
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
for (const name of requested) if (!scopes[name]) throw new Error(`Unknown scope: ${name}`);

function filesAt(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [path]; // Deletions also invalidate a stamp.
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute).sort().flatMap(name => filesAt(`${path.replace(/\/$/, '')}/${name}`));
}
function productionInputs(name) {
  const scope = scopes[name];
  return [...scope.sources, ...(scope.sharedSources ?? []), ...scope.dependencies.flatMap(productionInputs)];
}
function inputs(name) {
  const scope = scopes[name];
  const common = ['scripts/test.mjs', 'scripts/test-scopes.mjs'];
  const toolchain = scope.kind.startsWith('rust')
    ? ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json']
    : ['package.json', '../../pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.tests.json'];
  return [...new Set([...productionInputs(name), ...scope.tests, ...common, ...toolchain].flatMap(filesAt))].sort();
}
const rustVersion = spawnSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' });
function fingerprint(paths, name) {
  const runtime = scopes[name].kind.startsWith('rust')
    ? `${rustVersion.stdout ?? 'unavailable'}:${process.env.RUSTFLAGS ?? ''}:${process.env.CARGO_ENCODED_RUSTFLAGS ?? ''}`
    : process.version;
  const hash = createHash('sha256').update(`${process.platform}:${process.arch}:${runtime}`);
  for (const path of paths) {
    hash.update(path).update('\0');
    const full = resolve(root, path);
    hash.update(existsSync(full) && statSync(full).isFile() ? readFileSync(full) : '<missing>');
  }
  return hash.digest('hex');
}
function run(command, argv, capture = false) {
  console.log(`> ${command} ${argv.join(' ')}`);
  const result = spawnSync(command, argv, { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}); no pass stamp recorded`);
  return result.stdout;
}

const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const inputMap = Object.fromEntries(Object.keys(scopes).map(name => [name, inputs(name)]));
const hashes = Object.fromEntries(Object.entries(inputMap).map(([name, paths]) => [name, fingerprint(paths, name)]));
function covers(name, path) {
  return inputMap[name].includes(path) || [...productionInputs(name), ...scopes[name].tests]
    .some(input => input.endsWith('/') && path.startsWith(input));
}
function ownershipInventory() {
  const defaultTestScripts = filesAt('scripts').filter(path => /\.test\.[cm]?[jt]sx?$/.test(path));
  return [...new Set([
    ...filesAt('src'),
    ...filesAt('src-tauri/src'),
    ...filesAt('tests').filter(path => path !== 'tests/README.md'),
    // Cargo integration tests are default-runner inventory. The fake core is
    // feature-gated and opt-in, so its fixture subtree is intentionally excluded.
    ...filesAt('src-tauri/tests').filter(path => !path.startsWith('src-tauri/tests/fixtures/')),
    // Manual routing/debug scripts (including test-routing.py) are explicit
    // package commands, not default runner tests. Only runner tests belong here.
    ...defaultTestScripts,
  ])].filter(path => existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile());
}
const unmapped = ownershipInventory().filter(path =>
  !Object.keys(scopes).some(name => covers(name, path)));
if (!requested.length && unmapped.length) throw new Error(`Add module ownership in test-scopes.mjs for: ${unmapped.join(', ')}`);
const selected = Object.keys(scopes).filter(name => all || requested.includes(name) || (!requested.length && (
  cache[name] ? cache[name] !== hashes[name] : true
)));
console.log(JSON.stringify({ scopes: selected, mode: all ? 'all' : requested.length ? 'explicit' : 'changed' }));
if (plan || selected.length === 0) {
  if (!selected.length) console.log('No changed scopes require execution; this is a skip, not a new test pass.');
  process.exit(0);
}
mkdirSync(dirname(cachePath), { recursive: true });
function recordPasses(names) {
  for (const name of names) {
    if (fingerprint(inputs(name), name) !== hashes[name]) throw new Error(`${name} changed during verification; rerun it`);
    cache[name] = hashes[name];
  }
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
}

const rust = selected.filter(name => scopes[name].kind === 'rust');
if (rust.length) {
  // Cargo compiles the crate once; libtest runs only the selected module filters.
  const output = run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-run', '--message-format=json'], true);
  const artifact = output.trim().split('\n').map(line => JSON.parse(line))
    .find(item => item.reason === 'compiler-artifact' && item.profile.test && item.executable && item.target.name === 'pingu_lib');
  if (!artifact) throw new Error('Cargo did not return the library test executable');
  const filters = [...new Set(rust.flatMap(name => scopes[name].filters))];
  // Current libtest accepts multiple positional filters and ORs them. Keep one
  // process per runner invocation so module scopes share setup and teardown.
  run(artifact.executable, filters);
}
if (selected.includes('frontend')) {
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.tests.json']);
  run(process.execPath, ['--test', ...scopes.frontend.tests.filter(path => path.endsWith('.test.ts')).map(path => `.test-dist/${path.replace(/\.ts$/, '.js')}`)]);
}
if (selected.includes('cli')) {
  run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml', '--bins']);
}
if (selected.includes('ui')) {
  run('pnpm', ['exec', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
  console.log('UI typecheck passed. Rendering and native interactions require a separate focused UI check.');
}
if (selected.includes('runner')) {
  run(process.execPath, ['--test', ...scopes.runner.tests]);
}

// Commit pass stamps once, after every selected phase succeeds. A later failure
// or any input mutation leaves the prior cache byte-for-byte untouched.
recordPasses(selected);
