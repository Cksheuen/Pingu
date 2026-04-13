declare module "node:test" {
  const test: any;
  export default test;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}

declare module "node:child_process" {
  export const spawnSync: any;
}

declare module "node:fs" {
  export const mkdtempSync: any;
  export const rmSync: any;
}

declare module "node:os" {
  export const tmpdir: any;
}

declare module "node:path" {
  export const join: any;
}

declare const process: any;
