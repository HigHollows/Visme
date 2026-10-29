import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
const root = process.argv[2];
const files = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/(i18n|vite-env|\ben)\.ts$/.test(f) ? [p] : []; });
const FR = /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|des|du|de|un|une|et|ou|pour|avec|sans|dans|sur|vous|votre|vos|ce|cette|aucun|aucune|tous|toutes|pas|est|sont|ajouter|supprimer|enregistr|retirer|annuler|valider|nouveau|nouvelle|erreur|mail|mails)\b/i;
for (const file of files(root)) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) ) {
      const text = ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => s.literal.text).join(" ") : n.text;
      const inTr = n.parent && ts.isCallExpression(n.parent) && ts.isIdentifier(n.parent.expression) && n.parent.expression.text === "tr";
      const inImport = n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isLiteralTypeNode(n.parent));
      if (!inTr && !inImport && FR.test(text) && /[A-Za-zÀ-ÿ]{3}/.test(text) && !/^(bg|text|border|flex|grid|w-|h-|px|py|mt|mb|ml|mr|rounded|hover|dark|min|max|space|gap|ring|font|cursor|sr-)/.test(text.trim()) && text.length > 2) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        console.log(`${file.replace(root + "/", "")}:${line + 1}: ${JSON.stringify(text.slice(0, 90))}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
