#!/usr/bin/env node
// Downloads the phstudy BEYBLADE X database JSON into data/raw/.
// Usage: node tools/fetch-parts.mjs [--force]
// Skips files fetched less than 1h ago unless --force.

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://beyblade.phstudy.org/data/";
const FILES = [
  "main.json",
  "hardcoded.json",
  "part_weights.json",
  "part_code_names.json",
  "part_colors.json",
  "ui_i18n.json",
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "data", "raw");
const force = process.argv.includes("--force");

await mkdir(rawDir, { recursive: true });

for (const name of FILES) {
  const dest = join(rawDir, name);
  if (!force) {
    try {
      const s = await stat(dest);
      if (Date.now() - s.mtimeMs < 3600_000) {
        console.log(`skip  ${name} (fresh, ${(s.size / 1024).toFixed(0)} KB)`);
        continue;
      }
    } catch {
      /* not downloaded yet */
    }
  }
  const url = BASE + name;
  const res = await fetch(url, {
    headers: { "User-Agent": "beyblade-sim-dev/0.1 (personal fan project)" },
  });
  if (!res.ok) {
    console.error(`FAIL  ${name}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  JSON.parse(buf.toString("utf8")); // validate before writing
  await writeFile(dest, buf);
  console.log(`fetch ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
}
