import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StorageAdapter } from "../src/types";

export function createFileStorage(filePath: string, initialValue: unknown = null): StorageAdapter {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!readExisting(filePath)) writeValue(filePath, initialValue);

  return {
    read() {
      return readExisting(filePath);
    },
    write(value: unknown) {
      writeValue(filePath, value);
    },
    clear() {
      writeValue(filePath, null);
    }
  };
}

function readExisting(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

function writeValue(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value ?? null, null, 2));
  renameSync(tempPath, filePath);
}
