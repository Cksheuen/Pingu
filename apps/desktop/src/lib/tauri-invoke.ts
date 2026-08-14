type InvokeArgs = Record<string, unknown> | undefined;
type InvokeFn = <T>(command: string, args?: InvokeArgs) => Promise<T>;

declare global {
  var __PINGU_TEST_INVOKE__: InvokeFn | undefined;
}

export async function tauriInvoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (globalThis.__PINGU_TEST_INVOKE__) {
    return globalThis.__PINGU_TEST_INVOKE__<T>(command, args);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}
