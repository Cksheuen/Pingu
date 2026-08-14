import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createFileStorage(filePath, initialValue = null) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (!readExisting(filePath)) writeValue(filePath, initialValue);

  return {
    read() {
      return readExisting(filePath);
    },
    write(value) {
      writeValue(filePath, value);
    },
    clear() {
      writeValue(filePath, null);
    }
  };
}

function readExisting(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeValue(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value ?? null, null, 2));
  renameSync(tempPath, filePath);
}
