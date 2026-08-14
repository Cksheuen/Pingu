import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const width = 960;
const height = 420;
const raw = Buffer.alloc((width * 4 + 1) * height);

for (let y = 0; y < height; y += 1) {
  const row = y * (width * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < width; x += 1) {
    const offset = row + 1 + x * 4;
    const nx = x / width;
    const ny = y / height;
    const paper = 235 + Math.floor(14 * (1 - ny));
    const stripe = x > 80 && x < 220 ? 34 : 0;
    const arc = Math.hypot(nx - 0.78, ny - 0.34) < 0.28 ? 42 : 0;
    const note = x > 330 && x < 750 && y > 92 && y < 326 ? -18 : 0;
    const line = note && y % 38 < 4 ? -52 : 0;
    const dot = Math.hypot(nx - 0.25, ny - 0.72) < 0.08 ? 58 : 0;
    raw[offset] = clamp(paper + note + stripe + dot);
    raw[offset + 1] = clamp(226 + note + arc + line);
    raw[offset + 2] = clamp(206 + note + Math.floor(40 * nx) + line);
    raw[offset + 3] = 255;
  }
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr(width, height)),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0))
]);

await mkdir("public/assets", { recursive: true });
await writeFile("public/assets/blog-cover.png", png);
console.log("Generated public/assets/blog-cover.png");

function ihdr(w, h) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(w, 0);
  buffer.writeUInt32BE(h, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function clamp(value) {
  return Math.max(0, Math.min(255, value));
}
