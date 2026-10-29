#!/usr/bin/env node
// Usage : node scripts/bump-version.mjs 1.2.3
// Aligne la version dans tauri.conf.json, Cargo.toml et apps/desktop/package.json (le tag de release doit valoir « v<version> »).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("Usage : node scripts/bump-version.mjs <x.y.z>");
  process.exit(1);
}

const edit = (file, fn) => {
  const p = join(root, file);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (before === after) console.warn(`(inchangé) ${file}`);
  writeFileSync(p, after);
  console.log(`✔ ${file} → ${v}`);
};

edit("apps/desktop/src-tauri/tauri.conf.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`));
edit("apps/desktop/src-tauri/Cargo.toml", (s) => s.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$1${v}$2`));
edit("apps/desktop/package.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`));

console.log(`\nEnsuite :\n  git commit -am "Version ${v}"\n  git tag v${v} && git push --follow-tags`);
