import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = "127.0.0.1";
const port = 62999;
const baseUrl = `http://${host}:${port}`;

async function main() {
  const stateDir = await mkdtemp(join(tmpdir(), "eva-blog-layout-"));
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

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server start timeout")), 10000);
    const check = async () => {
      try {
        const res = await fetch(baseUrl);
        if (res.ok) {
          clearTimeout(timer);
          resolve(null);
        } else {
          setTimeout(check, 100);
        }
      } catch {
        setTimeout(check, 100);
      }
    };
    check();
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // Collect console logs
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Inject script to log positions
  const positions = await page.evaluate(`(() => {
    const getPos = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        position: style.position,
        zIndex: style.zIndex,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
      };
    };

    const results = {};

    // Key elements
    results["topbar"] = getPos(document.querySelector(".topbar"));
    results["brand-slot"] = getPos(document.querySelector(".brand-slot"));
    results["brand-mark"] = getPos(document.querySelector(".brand-mark"));
    results["public-nav"] = getPos(document.querySelector(".public-nav"));
    results["home-hero"] = getPos(document.querySelector(".home-hero"));
    results["hero-copy"] = getPos(document.querySelector(".hero-copy"));
    results["hero-bg"] = getPos(document.querySelector(".hero-bg"));
    results["hero-tabs"] = getPos(document.querySelector(".hero-tabs"));
    results["artwork-canvas"] = getPos(document.querySelector(".artwork-canvas"));
    results["flying-tab"] = getPos(document.querySelector(".flying-tab"));
    results["page-main"] = getPos(document.querySelector(".page-main"));
    results["app-footer"] = getPos(document.querySelector(".app-footer"));

    // Text elements
    const eyebrow = document.querySelector(".eyebrow");
    const h1Lines = document.querySelectorAll(".h1-line");
    const heroIntro = document.querySelector(".hero-intro");
    const heroActions = document.querySelector(".hero-actions");

    results["eyebrow"] = getPos(eyebrow);
    results["h1-line-1"] = getPos(h1Lines[0] || null);
    results["h1-line-2"] = getPos(h1Lines[1] || null);
    results["hero-intro"] = getPos(heroIntro);
    results["hero-actions"] = getPos(heroActions);

    // Nav links
    const navLinks = document.querySelectorAll(".public-nav a");
    navLinks.forEach((link, i) => {
      results["nav-link-" + i] = getPos(link);
    });

    // Hero tabs
    const heroTabLinks = document.querySelectorAll(".hero-tabs a");
    heroTabLinks.forEach((link, i) => {
      results["hero-tab-" + i] = getPos(link);
    });

    return results;
  })()`);

  console.log("\n=== Layout Positions (viewport: 1440x900) ===\n");
  for (const [name, pos] of Object.entries(positions as Record<string, unknown>)) {
    if (pos) {
      console.log(`${name}:`, JSON.stringify(pos));
    } else {
      console.log(`${name}: NOT FOUND`);
    }
  }

  console.log("\n=== Console Logs ===\n");
  logs.forEach((log) => console.log(log));

  // Take screenshot
  await page.screenshot({ path: "/tmp/eva-blog-layout.png", fullPage: false });
  console.log("\nScreenshot saved to /tmp/eva-blog-layout.png");

  await browser.close();
  child.kill();
  await rm(stateDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
