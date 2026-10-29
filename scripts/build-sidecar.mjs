#!/usr/bin/env node
// Prépare le moteur (sidecar) pour l'empaquetage :
//   1. bundle JS unique (esbuild) de apps/sidecar + tout le code TypeScript du monorepo ;
//   2. modules natifs (SQLCipher, sqlite-vec) installés pour la plateforme courante dans un dossier node_modules à part ;
//   3. binaire Node embarqué, nommé selon la cible Rust (convention des « sidecars » Tauri) ;
//   4. plugins officiels.
// Résultat dans apps/desktop/src-tauri/{binaries,resources}, consommé par `tauri build`.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "apps/desktop/src-tauri");
const out = join(tauri, "resources/sidecar");
const NATIVE = ["better-sqlite3-multiple-ciphers", "sqlite-vec"];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });

function targetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  const v = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /host: (.+)/.exec(v)[1].trim();
}

rmSync(join(tauri, "resources"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(join(tauri, "binaries"), { recursive: true });

// 1. Bundle ---------------------------------------------------------------
console.log("▸ bundle du moteur");
await build({
  entryPoints: [join(root, "apps/sidecar/src/main.ts")],
  outfile: join(out, "sidecar.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: NATIVE,
  minify: false, // lisible dans les rapports d'erreur ; la taille n'est pas dominée par le JS
  sourcemap: false,
  logLevel: "warning",
  // Certains paquets CJS embarqués utilisent require() : on le fournit dans le bundle ESM.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
// Le bac à sable des plugins lance runner.mjs à côté du bundle.
cpSync(join(root, "packages/core/src/plugins/runner.mjs"), join(out, "runner.mjs"));

// 2. Modules natifs --------------------------------------------------------
console.log("▸ modules natifs pour", process.platform, process.arch);
const dbPkg = JSON.parse(readFileSync(join(root, "packages/db/package.json"), "utf8")).dependencies;
const lockedVersion = (name) => String(dbPkg[name]).replace(/^[\^~]/, "");
writeFileSync(
  join(out, "package.json"),
  JSON.stringify({ name: "assistant-sidecar-natives", private: true, type: "module", dependencies: Object.fromEntries(NATIVE.map((n) => [n, lockedVersion(n)])) }, null, 2),
);
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts=false"], { cwd: out });

// 3. Node embarqué -----------------------------------------------------------
const triple = targetTriple();
const exe = process.platform === "win32" ? ".exe" : "";
const nodeDest = join(tauri, "binaries", `node-${triple}${exe}`);
console.log("▸ binaire Node →", nodeDest);
cpSync(process.execPath, nodeDest);
if (!exe) chmodSync(nodeDest, 0o755);

// 4. Plugins officiels --------------------------------------------------------
cpSync(join(root, "plugins"), join(tauri, "resources/plugins"), { recursive: true, filter: (s) => !/node_modules|\.git/.test(s) });

console.log("✔ moteur prêt :", existsSync(join(out, "sidecar.mjs")) ? "ok" : "MANQUANT");
