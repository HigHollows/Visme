#!/usr/bin/env node
// Test de fumée du moteur EMPAQUETÉ : lance le binaire Node embarqué sur sidecar.mjs, comme le fait l'application,
// et vérifie base chiffrée + sqlite-vec, extraction de tous les formats, recherche et bac à sable des plugins.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "apps/desktop/src-tauri");
const sidecarDir = join(tauri, "resources/sidecar");
const exe = process.platform === "win32" ? ".exe" : "";
const triple = process.env.TAURI_TARGET_TRIPLE ?? (await import("node:child_process")).execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (.+)/)[1].trim();
const node = join(tauri, "binaries", `node-${triple}${exe}`);

const child = spawn(node, [join(sidecarDir, "sidecar.mjs")], { cwd: tmpdir(), stdio: ["pipe", "pipe", "inherit"] }); // cwd quelconque : rien ne doit dépendre du dépôt
const pending = new Map();
let id = 0;
createInterface({ input: child.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined) pending.get(m.id)?.(m);
});
const call = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});

const req = createRequire(join(root, "packages/core/package.json"));
const { zipSync, strToU8 } = req("fflate");
const ExcelJS = req("exceljs");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "✔" : "✘"} ${name}${ok ? "" : " — " + detail}`); if (!ok) failed++; };

try {
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  check("ping", (await call("ping")) === "pong");
  await call("init", { dataDir: join(dir, "data"), key: "cle-de-test", profile: "smoke", bundledPluginsDir: join(tauri, "resources/plugins") });
  check("base chiffrée + sqlite-vec chargés", true);

  // Fichiers de tous les formats
  const files = {
    "note.txt": "Le devis Dupont de mars s'élève à 4200 euros.",
    "contrat.docx": Buffer.from(zipSync({
      "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Clause de préavis docxmarqueur</w:t></w:r></w:p></w:body></w:document>'),
    })),
    "slides.pptx": Buffer.from(zipSync({ "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>pptxmarqueur</a:t></p:sld>") })),
  };
  const wb = new ExcelJS.Workbook(); wb.addWorksheet("Budget").addRow(["xlsxmarqueur", 900]);
  files["budget.xlsx"] = Buffer.from(await wb.xlsx.writeBuffer());
  const pdfContent = "BT /F1 18 Tf 20 100 Td (pdfmarqueur) Tj ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${pdfContent.length} >>\nstream\n${pdfContent}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  files["doc.pdf"] = Buffer.from(pdf);

  const paths = [];
  for (const [n, c] of Object.entries(files)) { const p = join(dir, n); writeFileSync(p, c); paths.push(p); }
  const added = await call("documents.add", { paths });
  check("import de 5 formats", added.every((a) => a.id), JSON.stringify(added));
  for (let i = 0; i < 100; i++) {
    const docs = await call("documents.list");
    if (docs.every((d) => d.status !== "indexing")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const docs = await call("documents.list");
  check("tous indexés sans erreur", docs.length === 5 && docs.every((d) => d.status === "ready"), JSON.stringify(docs.map((d) => [d.name, d.status, d.error])));
  for (const w of ["devis dupont", "docxmarqueur", "pptxmarqueur", "xlsxmarqueur", "pdfmarqueur"]) {
    const hits = await call("search.query", { q: w });
    check(`recherche « ${w} »`, hits.length === 1, JSON.stringify(hits));
  }

  // Plugins : bac à sable via le binaire Node embarqué
  const plugins = await call("plugins.available");
  check("plugins officiels trouvés", plugins.length === 2, JSON.stringify(plugins.map((p) => p.id)));
  const inst = await call("plugins.installBundled", { id: "example-hello" });
  await call("plugins.enable", { id: "example-hello", permissions: inst.permissions });
  const r = await call("plugins.callTool", { name: "plugin:example-hello:hello", args: { name: "Test" } });
  check("outil de plugin exécuté dans le bac à sable", /Bonjour Test/.test(r.result), JSON.stringify(r));

  // Réglages & journal
  const s = await call("settings.get");
  check("réglages par défaut", s.agent.enabled === false && s.agent.autonomy === "propose");
} catch (e) {
  console.error("✘ échec :", e.message);
  failed++;
} finally {
  child.kill();
}
console.log(failed ? `\n${failed} vérification(s) en échec` : "\nTout est OK");
process.exit(failed ? 1 : 0);
