import { cp, mkdir } from "node:fs/promises";

await mkdir("public/assets", { recursive: true });
await cp("../eva-blog-admin/public/assets", "public/assets", { recursive: true, force: true });
console.log("Prepared local status assets.");
