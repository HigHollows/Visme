#!/usr/bin/env node
// Vérifie la couverture de la traduction anglaise de l'interface.
//   node scripts/i18n-check.mjs          → échoue si un texte tr("…") n'a pas d'entrée dans src/en.ts
//   node scripts/i18n-check.mjs --dump   → écrit les textes manquants dans /tmp/i18n/missing.json
// Les clés de traduction SONT les textes français tels qu'écrits dans tr("…") ; {0}, {1}… sont des paramètres.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(new URL("..", import.meta.url).pathname, "apps/desktop/src");
const files = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/(i18n|vite-env|\ben)\.ts$/.test(f) ? [p] : []; });

const used = new Map(); // clé → fichiers
for (const file of files(root)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "tr" && n.arguments[0]) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) used.set(a.text, [...(used.get(a.text) ?? []), file.replace(root + "/", "")]);
      else if (!(ts.isIdentifier(a))) console.warn(`⚠ tr() avec une clé non littérale : ${file.replace(root + "/", "")}`);
    }
    // Listes de libellés traduits à l'affichage (tr(s) sur une variable) : SECTIONS, SETTINGS_TABS.
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^(SECTIONS|SETTINGS_TABS)$/.test(n.name.text) && n.initializer) {
      const arr = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (ts.isArrayLiteralExpression(arr)) for (const e of arr.elements) if (ts.isStringLiteral(e)) used.set(e.text, [...(used.get(e.text) ?? []), file.replace(root + "/", "")]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const enSrc = readFileSync(join(root, "en.ts"), "utf8");
const js = ts.transpileModule(enSrc, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { en } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const missing = [...used.keys()].filter((k) => !(k in en) || !String(en[k]).trim()).sort();
const unused = Object.keys(en).filter((k) => !used.has(k));
// Les paramètres {n} doivent être les mêmes dans les deux langues.
const badParams = Object.keys(en).filter((k) => used.has(k) && [...k.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join() !== [...String(en[k]).matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join());

if (process.argv.includes("--dump")) { writeFileSync("/tmp/i18n/missing.json", JSON.stringify(missing, null, 1)); console.log(`${missing.length} manquants → /tmp/i18n/missing.json`); }
console.log(`${used.size} textes utilisés, ${Object.keys(en).length} traduits.`);
if (unused.length) console.log(`ℹ ${unused.length} traduction(s) inutilisée(s) :\n  ${unused.slice(0, 15).join("\n  ")}${unused.length > 15 ? "\n  …" : ""}`);
if (badParams.length) console.log(`✘ paramètres {n} incohérents :\n  ${badParams.join("\n  ")}`);
if (missing.length) console.log(`✘ ${missing.length} texte(s) sans traduction anglaise :\n  ${missing.slice(0, 20).join("\n  ")}${missing.length > 20 ? "\n  …" : ""}`);
process.exit(missing.length || badParams.length ? 1 : 0);
