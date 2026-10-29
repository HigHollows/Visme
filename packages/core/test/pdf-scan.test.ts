import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src";
import { PAGES_PER_REQUEST, planOcr } from "../src/documents/pdf-ocr";

const sse = (t: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`);

/** PDF de test : `layout[i]` = texte de la page i, ou null pour une page « scannée » (vide). */
async function makePdf(layout: (string | null)[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of layout) {
    const page = doc.addPage([300, 200]);
    if (t) page.drawText(t, { x: 20, y: 100, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

async function setup(opts: { ocr?: boolean; fail?: number } = {}) {
  const requests: { pages: number }[] = [];
  const rpc = createApp({
    fetch: (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const part = body.messages[0].content.find?.((c: any) => c.type === "file");
      if (!part) return sse("{}");
      if (opts.fail) return new Response("PDF non supporté", { status: opts.fail });
      const bytes = Buffer.from(part.file.file_data.split(",")[1], "base64");
      const pages = (await PDFDocument.load(bytes)).getPageCount();
      requests.push({ pages });
      return sse(`TEXTE-OCR-BLOC-${requests.length} (${pages} pages)`);
    }) as never,
  });
  const call = async (method: string, params?: unknown) => JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  await call("init", { dataDir: mkdtempSync(join(tmpdir(), "scan-")), key: "k" });
  if (opts.ocr !== false) {
    const s = (await call("settings.get")).result;
    s.ai.providers = { oa: { kind: "openai" } };
    s.ai.routes = { ocr: { primary: { provider: "oa", model: "m" } } };
    await call("settings.set", { settings: s });
    await call("ai.setKeys", { keys: { oa: "k" } });
  }
  const add = async (layout: (string | null)[]) => {
    const f = join(mkdtempSync(join(tmpdir(), "pdf-")), "scan.pdf");
    writeFileSync(f, await makePdf(layout));
    const [a] = (await call("documents.add", { paths: [f] })).result;
    let d: any;
    await vi.waitFor(async () => { d = (await call("documents.get", { id: a.id })).result; expect(d.status).not.toBe("indexing"); }, { timeout: 15_000 });
    return { d, call, id: a.id as string };
  };
  return { add, requests, call };
}

describe("planOcr", () => {
  it("regroupe les pages scannées contiguës par blocs de 10, plafonne à 60", () => {
    const pages = ["Texte natif de la première page", "", "", "Texte natif de la quatrième page", "", ...Array(12).fill("")];
    const plan = planOcr(pages);
    expect(plan.runs[0]).toEqual([1, 2]);
    expect(plan.runs[1]).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // 10 pages
    expect(plan.runs[2]).toEqual([14, 15, 16]);
    expect(plan.scanned).toBe(15);
    const big = planOcr(Array(75).fill(""));
    expect(big.runs.flat()).toHaveLength(60);
    expect(big.skipped).toBe(15);
    expect(planOcr(["Assez de texte pour ne pas être un scan."]).runs).toEqual([]);
    expect(PAGES_PER_REQUEST).toBe(10);
  });
});

describe("PDF scannés", () => {
  it("PDF entièrement scanné : lu par le modèle via le PDF natif, texte indexé et cherchable", async () => {
    const t = await setup();
    const { d } = await t.add([null, null, null]);
    expect(d.status).toBe("ready");
    expect(t.requests).toEqual([{ pages: 3 }]);
    expect((await t.call("search.query", { q: "TEXTE-OCR-BLOC-1" })).result).toHaveLength(1);
  });

  it("PDF mixte : texte natif conservé, seules les pages scannées partent à l'OCR, dans l'ordre", async () => {
    const t = await setup();
    const { d } = await t.add(["Première page avec du vrai texte extractible.", null, null, "Quatrième page avec du texte natif aussi."]);
    expect(d.status).toBe("ready");
    expect(t.requests).toEqual([{ pages: 2 }]); // pages 2 et 3 uniquement
    const hit = (await t.call("search.query", { q: "Quatrième texte natif" })).result;
    expect(hit).toHaveLength(1);
  });

  it("long scan : blocs de 10 pages ; au-delà de 60 pages, avertissement", async () => {
    const t = await setup();
    const { d } = await t.add(Array(25).fill(null));
    expect(t.requests.map((r) => r.pages)).toEqual([10, 10, 5]);
    expect(d.status).toBe("ready");

    const t2 = await setup();
    const { d: d2 } = await t2.add(Array(70).fill(null));
    expect(t2.requests.reduce((n, r) => n + r.pages, 0)).toBe(60);
    expect(d2.warnings.join(" ")).toContain("10 page(s) scannée(s) au-delà");
  });

  it("sans route OCR : scan pur = erreur claire ; PDF mixte = indexé avec avertissement", async () => {
    const t = await setup({ ocr: false });
    const { d } = await t.add([null, null]);
    expect(d.status).toBe("error");
    expect(d.error).toContain("route « OCR »");
    const { d: m } = await t.add(["Du texte natif suffisamment long pour compter.", null]);
    expect(m.status).toBe("ready");
    expect(m.warnings.join(" ")).toContain("1 page(s) scannée(s) non lues");
  });

  it("fournisseur qui refuse les PDF : message explicite, aucun plantage", async () => {
    const t = await setup({ fail: 400 });
    const { d } = await t.add([null]);
    expect(d.status).toBe("error");
    expect(d.error).toContain("doit accepter les PDF");
  });

  it("PDF sans page scannée : aucun appel IA", async () => {
    const t = await setup();
    const { d } = await t.add(["Page un avec du texte natif en quantité suffisante.", "Page deux avec encore du texte natif suffisant."]);
    expect(d.status).toBe("ready");
    expect(t.requests).toEqual([]);
  });
});
