import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderConfig, RouteRule } from "./config/config.js";

type ConfigDocument = Record<string, unknown> & {
  providers?: Record<string, ProviderConfig>;
  routes?: RouteRule[];
  disabledModels?: string[];
};

export const modelHelp = `pcpa models list
pcpa models add <name> --provider <provider-id> [--target <upstream-name>]
pcpa models remove <name>
Changes apply after: pcpa restart`;

// Edit the raw document to preserve credentials and unrelated configuration.
export function runModelCommand(appRoot: string, args: string[]): void {
  if (args.includes("--help") || args[0] === "help") { console.log(modelHelp); return; }
  const [action = "list", name, ...flags] = args;
  const path = resolve(appRoot, "config.json");
  const original = readFileSync(path, "utf8");
  const config = JSON.parse(original) as ConfigDocument;
  const providers = config.providers ?? {};
  const routes = config.routes ?? [];
  if (action === "list") {
    if (args.length > 1) throw new Error(modelHelp);
    console.log("Configured models (pending until restart; discovery may expose additional models):");
    const rows = new Set<string>();
    for (const [id, p] of Object.entries(providers)) {
      console.log(`Provider: ${id}${p.autoDiscoverModels ? " (auto-discovery enabled)" : ""}`);
      for (const m of p.models ?? []) rows.add(`${m}\t${id}\t${m}`);
    }
    for (const r of routes) {
      for (const m of typeof r.match === "string" ? [r.match] : r.match ?? []) rows.add(`${m}\t${r.provider}\t${r.targetModel ?? m}`);
      if (r.modelPrefix) rows.add(`${r.modelPrefix}*\t${r.provider}\t${r.targetModel ?? (r.stripPrefix ? "strip prefix" : "unchanged")}`);
    }
    const table = [["MODEL", "PROVIDER", "UPSTREAM"], ...Array.from(rows, (row) => row.split("\t"))];
    const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
    for (const [index, row] of table.entries()) {
      const line = row.map((cell, column) => column < row.length - 1 ? cell.padEnd(widths[column]) : cell).join("  ");
      console.log(`${line}${index > 0 && config.disabledModels?.includes(row[0]) ? "  DISABLED" : ""}`);
    }
    for (const m of config.disabledModels ?? []) console.log(`Disabled: ${m}`);
    return;
  }
  if (!["add", "remove"].includes(action) || !name?.trim() || name.startsWith("-")) throw new Error(modelHelp);
  if (action === "add") {
    const options: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!["--provider", "--target"].includes(flags[i]) || !flags[i + 1]?.trim() || flags[i + 1].startsWith("--") || options[flags[i]]) throw new Error(modelHelp);
      options[flags[i]] = flags[i + 1];
    }
    const provider = options["--provider"];
    if (!provider || !Object.hasOwn(providers, provider)) throw new Error(`Unknown provider. Available: ${Object.keys(providers).join(", ")}`);
    removeExact(name);
    config.routes!.unshift({ match: name, provider, targetModel: options["--target"] ?? name });
    config.disabledModels = (config.disabledModels ?? []).filter((m) => m !== name);
  } else {
    if (flags.length) throw new Error(modelHelp);
    removeExact(name);
    config.disabledModels = [...new Set([...(config.disabledModels ?? []), name])];
  }
  function removeExact(model: string): void {
    for (const p of Object.values(providers)) if (p.models) p.models = p.models.filter((m) => m !== model);
    config.routes = routes.flatMap((r) => {
      if (r.match === model) return [];
      if (Array.isArray(r.match)) {
        const match = r.match.filter((m) => m !== model);
        return match.length ? [{ ...r, match }] : [];
      }
      return [r];
    });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (readFileSync(path, "utf8") !== original) throw new Error("Config changed concurrently; retry the command");
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  console.log(`${action === "add" ? "Configured" : "Disabled"}: ${name}. Run pcpa restart to apply.`);
}
