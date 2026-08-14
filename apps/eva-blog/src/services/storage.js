export function createBrowserStorage(namespace) {
  return {
    read() {
      const raw = window.localStorage.getItem(namespace);
      return raw ? JSON.parse(raw) : null;
    },
    write(value) {
      window.localStorage.setItem(namespace, JSON.stringify(value));
    },
    clear() {
      window.localStorage.removeItem(namespace);
    }
  };
}

export function createMemoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    read() {
      return value ? structuredClone(value) : null;
    },
    write(nextValue) {
      value = structuredClone(nextValue);
    },
    clear() {
      value = null;
    }
  };
}
