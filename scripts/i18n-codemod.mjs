#!/usr/bin/env node
// Outil à usage unique : enveloppe les textes français de l'interface dans t("…") (voir apps/desktop/src/i18n.ts).
// Usage : node scripts/i18n-codemod.mjs [--dry]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(new URL("..", import.meta.url).pathname, "apps/desktop/src");
const dry = process.argv.includes("--dry");
const LETTER = /[A-Za-zÀ-ÿ]/;
const TEXT_ATTRS = new Set(["placeholder", "title", "aria-label", "alt", "aria-description"]);
const SETTERS = /^set(Msg|Err|Error|Message|DigestMsg|AttMsg|RecErr|Status|Info)$/;
const keys = new Set();
const skipped = [];

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/(i18n|vite-env|en)\.ts$/.test(f) ? [p] : [];
  });
}

const q = (s) => JSON.stringify(s);

for (const file of files(root)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];

  /** Remplace un littéral (chaîne ou gabarit) par t("clé", args…). */
  const wrap = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (!LETTER.test(text)) return;
      keys.add(text);
      edits.push([node.getStart(sf), node.getEnd(), `t(${q(text)})`]);
    } else if (ts.isTemplateExpression(node)) {
      let key = node.head.text;
      const args = [];
      node.templateSpans.forEach((s, i) => { key += `{${i}}` + s.literal.text; args.push(src.slice(s.expression.getStart(sf), s.expression.getEnd())); });
      if (!LETTER.test(key.replace(/\{\d+\}/g, ""))) return;
      keys.add(key);
      edits.push([node.getStart(sf), node.getEnd(), `t(${q(key)}, ${args.join(", ")})`]);
    }
  };

  /** Descend dans une expression et enveloppe les littéraux « texte » (branches de ternaires, && …). */
  const wrapExpr = (e) => {
    if (ts.isParenthesizedExpression(e)) return wrapExpr(e.expression);
    if (ts.isConditionalExpression(e)) { wrapExpr(e.whenTrue); wrapExpr(e.whenFalse); return; }
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (k === ts.SyntaxKind.AmpersandAmpersandToken) return wrapExpr(e.right);
      if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) { wrapExpr(e.left); wrapExpr(e.right); return; }
      return;
    }
    wrap(e);
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const raw = node.text;
      const core = raw.trim();
      if (core && LETTER.test(core)) {
        if (/&[a-z#0-9]+;/i.test(core)) skipped.push(`${file}: entité HTML ${core.slice(0, 40)}`);
        else {
          const lead = raw.slice(0, raw.indexOf(core));
          const trail = raw.slice(raw.indexOf(core) + core.length);
          const key = core.replace(/\s+/g, " ");
          keys.add(key);
          edits.push([node.getStart(sf, true) === node.pos ? node.pos : node.getFullStart(), node.getEnd(), `${lead}{t(${q(key)})}${trail}`]);
        }
      }
    } else if (ts.isJsxAttribute(node) && TEXT_ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) && LETTER.test(init.text)) {
        keys.add(init.text);
        edits.push([init.getStart(sf), init.getEnd(), `{t(${q(init.text)})}`]);
      } else if (ts.isJsxExpression(init) && init.expression) wrapExpr(init.expression);
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && node.expression) {
      wrapExpr(node.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if ((["confirm", "prompt", "alert"].includes(name) || SETTERS.test(name)) && node.arguments[0]) wrapExpr(node.arguments[0]);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error" && node.arguments?.[0]) {
      wrapExpr(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!edits.length) continue;
  // Applique de la fin vers le début ; un même intervalle n'est jamais édité deux fois.
  edits.sort((a, b) => b[0] - a[0]);
  let out = src;
  let lastStart = Infinity;
  for (const [s, e, r] of edits) {
    if (e > lastStart) continue;
    out = out.slice(0, s) + r + out.slice(e);
    lastStart = s;
  }
  if (!/from "\.\.?\/i18n"/.test(out) && !file.endsWith("i18n.ts")) {
    const rel = file.includes("/pages/") ? "../i18n" : "./i18n";
    out = out.replace(/^(import [^\n]*\n)/, `$1import { t } from "${rel}";\n`);
  }
  if (!dry) writeFileSync(file, out);
  console.log(`${dry ? "(essai) " : ""}${file.replace(root + "/", "")}: ${edits.length} remplacements`);
}
writeFileSync("/tmp/i18n/keys.json", JSON.stringify([...keys].sort(), null, 1));
console.log(`\n${keys.size} chaînes distinctes → /tmp/i18n/keys.json`);
if (skipped.length) console.log("Ignorées :\n" + skipped.join("\n"));
