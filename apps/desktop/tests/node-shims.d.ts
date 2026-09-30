declare module "node:test" {
  const test: any;
  export default test;
  export const beforeEach: any;
  export const afterEach: any;
}

declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
