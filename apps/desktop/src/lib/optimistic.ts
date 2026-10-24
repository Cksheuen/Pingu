export interface OptimisticOptions<T> {
  apply: () => void;
  commit: () => Promise<T>;
  rollback: () => void;
}

export async function runOptimistic<T>({ apply, commit, rollback }: OptimisticOptions<T>): Promise<T> {
  apply();
  try {
    return await commit();
  } catch (error) {
    rollback();
    throw error;
  }
}

// Call next() per mutation; its returned isLatest() guards stale success and rollback callbacks.
export function createLatest(): () => () => boolean {
  let latest = 0;
  return () => {
    const token = ++latest;
    return () => token === latest;
  };
}
