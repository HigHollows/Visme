import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { chunkText, createApp, extract, ftsQuery, parseSummary } from "../src";

const dir = () => mkdtempSync(join(tmpdir(), "docs-"));

function minimalDocx(text: string) {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    }),
  );
}

function minimalPdf(text: string) {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe("extraction", () => {
  it("texte, markdown et csv", async () => {
    expect(await extract("a.txt", Buffer.from("bonjour"))).toEqual({ kind: "text", text: "bonjour" });
    expect((await extract("a.csv", Buffer.from("a,b\n1,2")) as any).text).toContain("1,2");
  });

  it("docx", async () => {
    const r: any = await extract("a.docx", minimalDocx("Contrat Dupont"));
    expect(r.text).toContain("Contrat Dupont");
  });

  it("pdf", async () => {
    const r: any = await extract("a.pdf", minimalPdf("Facture 42"));
    expect(r.text).toContain("Facture 42");
  });

  it("xlsx", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Budget");
    ws.addRow(["Poste", "Montant"]);
    ws.addRow(["Loyer", 900]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r: any = await extract("a.xlsx", buf);
    expect(r.text).toContain("Feuille : Budget");
    expect(r.text).toContain("Loyer | 900");
  });

  it("pptx", async () => {
    const slide = (t: string) => strToU8(`<p:sld><a:t>${t}</a:t><a:t>&amp; suite</a:t></p:sld>`);
    const buf = Buffer.from(zipSync({ "ppt/slides/slide2.xml": slide("Deux"), "ppt/slides/slide1.xml": slide("Un") }));
    const r: any = await extract("a.pptx", buf);
    expect(r.text.indexOf("Un")).toBeLessThan(r.text.indexOf("Deux"));
    expect(r.text).toContain("& suite");
  });

  it("image : renvoyée telle quelle pour l'OCR", async () => {
    expect(await extract("a.png", Buffer.from([1, 2]))).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("refuse un format inconnu", async () => {
    await expect(extract("a.exe", Buffer.from("x"))).rejects.toThrow(/non pris en charge/);
  });
});

describe("chunkText / ftsQuery / parseSummary", () => {
  it("découpe sans perdre de texte et borne la taille", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Phrase numéro ${i} du document.`).join(" ");
    const chunks = chunkText(text, 300, 40);
    expect(chunks.length).toBeGreaterThan(3);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(400);
    expect(chunks.join(" ")).toContain("numéro 79");
    expect(chunkText("   ")).toEqual([]);
  });

  it("neutralise les opérateurs FTS", () => {
    expect(ftsQuery('devis "mars" OR NEAR(')).toBe('"devis" AND "mars" AND "OR" AND "NEAR"*');
    expect(ftsQuery("!!")).toBeNull();
  });

  it("parseSummary : tolère le bruit et rejette les dates invalides", () => {
    const r = parseSummary('Voici:\n{"summary":"ok","tags":["a",3],"dates":[{"date":"2026-03-01","label":"x"},{"date":"demain","label":"y"}]}');
    expect(r?.tags).toEqual(["a"]);
    expect(r?.dates).toEqual([{ date: "2026-03-01", label: "x" }]);
    expect(parseSummary("pas de json")).toBeNull();
  });
});

describe("pipeline + recherche", () => {
  async function call(rpc: ReturnType<typeof createApp>, method: string, params?: unknown) {
    return JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  }

  // Faux fournisseur compatible OpenAI : embeddings déterministes (sac de mots hashés), résumé JSON.
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/embeddings")) {
      const emb = (t: string) => {
        const v = new Array(16).fill(0);
        for (const w of t.toLowerCase().match(/\p{L}+/gu) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 16;
          v[h] += 1;
        }
        return v;
      };
      return new Response(JSON.stringify({ data: body.input.map((t: string, index: number) => ({ index, embedding: emb(t) })) }));
    }
    const content = JSON.stringify({ summary: "Un devis.", tags: ["devis"], entities: [{ name: "Dupont", type: "org" }], dates: [{ date: "2026-03-15", label: "validité" }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  }) as never;

  async function setup(withAi: boolean) {
    const events: any[] = [];
    const rpc = createApp({ fetch: fakeFetch, notify: (m, p) => events.push({ m, ...(p as object) }) });
    await call(rpc, "init", { dataDir: dir(), key: "k" });
    if (withAi) {
      const s = (await call(rpc, "settings.get")).result;
      s.ai.providers = { oa: { kind: "openai" } };
      const r = { primary: { provider: "oa", model: "m" } };
      s.ai.routes = { embedding: r, summary: r };
      await call(rpc, "settings.set", { settings: s });
      await call(rpc, "ai.setKeys", { keys: { oa: "k" } });
    }
    const waitReady = async (id: string) => {
      for (let i = 0; i < 400; i++) {
        const d = (await call(rpc, "documents.get", { id })).result;
        if (d.status !== "indexing") return d;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout");
    };
    return { rpc, events, waitReady };
  }

  it("indexe un document : résumé, tags, dates, recherche hybride", async () => {
    const { rpc, waitReady } = await setup(true);
    const f = join(dir(), "devis-dupont.txt");
    writeFileSync(f, "Devis de mars pour la société Dupont. Montant total : 4 200 euros. Validité jusqu'au 15 mars 2026.");
    const [added] = (await call(rpc, "documents.add", { paths: [f] })).result;
    const doc = await waitReady(added.id);
    expect(doc.status).toBe("ready");
    expect(doc.summary).toBe("Un devis.");
    expect(doc.tags).toEqual(["devis"]);
    expect(doc.dates).toEqual([{ date: "2026-03-15", label: "validité" }]);

    const hit = (await call(rpc, "search.query", { q: "devis Dupont" })).result;
    expect(hit[0]).toMatchObject({ type: "document", id: added.id });
    expect(hit[0].snippet).toContain("«");
    // Recherche sémantique seule : aucun mot commun avec la requête FTS "AND", le vectoriel/OR doit suffire
    expect((await call(rpc, "search.query", { q: "montant euros société" })).result[0].id).toBe(added.id);
  });

  it("dédoublonne et supprime proprement (chunks et vecteurs)", async () => {
    const { rpc, waitReady } = await setup(true);
    const f = join(dir(), "a.md");
    writeFileSync(f, "# Titre\nContenu unique et mémorable.");
    const [a] = (await call(rpc, "documents.add", { paths: [f] })).result;
    await waitReady(a.id);
    const [b] = (await call(rpc, "documents.add", { paths: [f] })).result;
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    await call(rpc, "documents.delete", { id: a.id });
    expect((await call(rpc, "documents.list")).result).toEqual([]);
    expect((await call(rpc, "search.query", { q: "mémorable" })).result).toEqual([]);
  });

  it("fonctionne sans IA : recherche par mots-clés et avertissements", async () => {
    const { rpc, waitReady } = await setup(false);
    const f = join(dir(), "note.txt");
    writeFileSync(f, "Rendez-vous chez le notaire le 3 juin.");
    const [a] = (await call(rpc, "documents.add", { paths: [f] })).result;
    const doc = await waitReady(a.id);
    expect(doc.status).toBe("ready");
    expect(doc.warnings.length).toBe(2);
    expect((await call(rpc, "search.query", { q: "notaire" })).result[0].id).toBe(a.id);
  });

  it("signale les fichiers refusés sans bloquer les autres", async () => {
    const { rpc } = await setup(false);
    const bad = join(dir(), "x.exe");
    writeFileSync(bad, "MZ");
    const r = (await call(rpc, "documents.add", { paths: [bad, "/inexistant/fichier.txt"] })).result;
    expect(r[0].error).toMatch(/non pris en charge/);
    expect(r[1].error).toBeDefined();
  });

  it("image sans route OCR : erreur explicite", async () => {
    const { rpc, waitReady } = await setup(false);
    const f = join(dir(), "scan.png");
    writeFileSync(f, Buffer.from([137, 80, 78, 71]));
    const [a] = (await call(rpc, "documents.add", { paths: [f] })).result;
    const d = await waitReady(a.id);
    expect(d.status).toBe("error");
    expect(d.error).toContain("OCR");
  });
});
