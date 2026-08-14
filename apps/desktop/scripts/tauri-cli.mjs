import { copyFileSync, existsSync, mkdtempSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcTauriDir = join(rootDir, "src-tauri");
const args = process.argv.slice(2);
const target = resolveTargetTriple(args);
const suffix = target.includes("windows") ? ".exe" : "";

const override = resolveTauriOverride(target, suffix);
const env = { ...process.env };
const tauriArgs = override ? [...args, "--config", JSON.stringify(override)] : args;

const result = spawnSync("tauri", tauriArgs, {
  cwd: rootDir,
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function resolveTauriOverride(targetTriple, executableSuffix) {
  const bundledBinary = join(
    srcTauriDir,
    "binaries",
    `sing-box-${targetTriple}${executableSuffix}`,
  );

  if (existsSync(bundledBinary)) {
    return null;
  }

  const sourceBinary =
    process.env.PINGU_SING_BOX_BIN ||
    process.env.SING_BOX_BIN ||
    findOnPath(`sing-box${executableSuffix}`);

  if (!sourceBinary) {
    console.warn(
      "[pingu] sing-box sidecar not found; building without bundled sing-box. Install sing-box on PATH or set PINGU_SING_BOX_BIN to bundle it.",
    );
    return {
      bundle: {
        externalBin: null,
      },
    };
  }

  const stageDir = mkdtempSync(join(tmpdir(), "pingu-tauri-"));
  mkdirSync(stageDir, { recursive: true });

  const stagedBinary = join(stageDir, `sing-box-${targetTriple}${executableSuffix}`);
  copyFileSync(sourceBinary, stagedBinary);

  if (!targetTriple.includes("windows")) {
    chmodSync(stagedBinary, 0o755);
  }

  return {
    bundle: {
      externalBin: [join(stageDir, "sing-box")],
    },
  };
}

function resolveTargetTriple(cliArgs) {
  const explicitTarget = findArgValue(cliArgs, "--target");
  if (explicitTarget) {
    return explicitTarget;
  }

  const archMap = {
    arm64: "aarch64",
    x64: "x86_64",
  };

  const platformMap = {
    darwin: "apple-darwin",
    linux: "unknown-linux-gnu",
    win32: "pc-windows-msvc",
  };

  const arch = archMap[process.arch];
  const platform = platformMap[process.platform];

  if (!arch || !platform) {
    throw new Error(
      `Unsupported local target resolution for ${process.arch}-${process.platform}; pass --target explicitly.`,
    );
  }

  return `${arch}-${platform}`;
}

function findArgValue(cliArgs, flag) {
  const flagIndex = cliArgs.indexOf(flag);
  if (flagIndex !== -1 && cliArgs[flagIndex + 1]) {
    return cliArgs[flagIndex + 1];
  }

  const inline = cliArgs.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function findOnPath(executableName) {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return null;
  }

  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, executableName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
