import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = "127.0.0.1";
const port = 63001;
const baseUrl = `http://${host}:${port}`;

async function main() {
  const stateDir = await mkdtemp(join(tmpdir(), "eva-blog-scroll-"));
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts", `--host=${host}`, `--port=${port}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      EVA_BLOG_LOCAL_STATE: join(stateDir, "state.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server start timeout")), 10000);
    const check = async () => {
      try {
        const res = await fetch(baseUrl);
        if (res.ok) { clearTimeout(timer); resolve(null); }
        else setTimeout(check, 100);
      } catch { setTimeout(check, 100); }
    };
    check();
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 注入诊断：监听 scroll 事件
  await page.evaluate(`
    window.__scrollLog = [];
    let lastScroll = -1;
    const tick = () => {
      const y = window.scrollY;
      if (y !== lastScroll) {
        lastScroll = y;
        window.__scrollLog.push(y);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  `);

  // 获取 canvas 初始像素指纹
  const fp0 = await page.evaluate(`
    (() => {
      const c = document.querySelector('.artwork-canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 997) sum += d[i];
      return sum;
    })()
  `);

  const maxScroll = await page.evaluate(`document.documentElement.scrollHeight - window.innerHeight`);
  console.log(`maxScroll: ${maxScroll}, vh: 900, vh*0.85: ${900 * 0.85}`);

  // 逐步滚动
  const steps = [0.15, 0.35, 0.55, 0.75, 0.95];
  const fingerprints: Array<{ pos: string; fp: number | null }> = [{ pos: "0%", fp: fp0 as number | null }];

  for (const pct of steps) {
    const target = Math.round(maxScroll * pct);
    await page.evaluate(`window.scrollTo(0, ${target})`);
    await page.waitForTimeout(600);

    const actualScroll = await page.evaluate(`window.scrollY`);
    const fp = await page.evaluate(`
      (() => {
        const c = document.querySelector('.artwork-canvas');
        if (!c) return null;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 997) sum += d[i];
        return sum;
      })()
    `);
    fingerprints.push({ pos: `${pct * 100}% (scrollY=${actualScroll})`, fp: fp as number | null });
    await page.screenshot({ path: `/tmp/eva-blog-scroll-${pct}.png` });
  }

  console.log("\n=== Canvas 像素指纹（不同滚动位置）===");
  for (const f of fingerprints) {
    console.log(`  ${f.pos}: fp=${f.fp}`);
  }

  // 检查指纹是否有变化
  const uniqueFps = new Set(fingerprints.map((f) => f.fp));
  console.log(`\n唯一指纹数: ${uniqueFps.size}/${fingerprints.length}`);
  if (uniqueFps.size === 1) {
    console.log("⚠️ Canvas 在滚动过程中完全没有变化！");
  } else {
    console.log("✓ Canvas 在滚动过程中有变化");
  }

  console.log("\n=== Scroll 事件日志 ===");
  const scrollLog = await page.evaluate(`window.__scrollLog`);
  console.log(`捕获到 ${scrollLog.length} 次 scrollY 变化:`, JSON.stringify(scrollLog.slice(0, 20)));

  console.log("\n=== Console 错误 ===");
  const errors = logs.filter((l) => l.includes("error") || l.includes("pageerror"));
  if (errors.length === 0) console.log("无错误");
  else errors.forEach((l) => console.log(l));

  await browser.close();
  child.kill();
  await rm(stateDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
