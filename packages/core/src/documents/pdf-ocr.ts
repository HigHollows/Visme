import { PDFDocument } from "pdf-lib";

/** Une page est considérée comme un scan quand elle ne contient (presque) aucun texte extractible (un simple numéro de page compte comme vide). */
export const SCAN_MIN_CHARS = 5;
export const PAGES_PER_REQUEST = 10;
export const MAX_OCR_PAGES = 60;

export interface PdfPlan {
  /** Groupes de pages (indices) à envoyer à l'OCR, dans l'ordre du document. */
  runs: number[][];
  /** Pages scannées au-delà de la limite : non traitées. */
  skipped: number;
  /** Nombre de pages scannées détectées. */
  scanned: number;
}

/** Décide quelles pages passent par l'OCR : les pages sans texte, regroupées par blocs contigus de 10 pages maximum, 60 pages au plus. */
export function planOcr(pages: string[]): PdfPlan {
  const scannedIdx = pages.map((t, i) => (t.trim().length < SCAN_MIN_CHARS ? i : -1)).filter((i) => i >= 0);
  const kept = scannedIdx.slice(0, MAX_OCR_PAGES);
  const runs: number[][] = [];
  for (const i of kept) {
    const last = runs.at(-1);
    if (last && i === last.at(-1)! + 1 && last.length < PAGES_PER_REQUEST) last.push(i);
    else runs.push([i]);
  }
  return { runs, skipped: scannedIdx.length - kept.length, scanned: scannedIdx.length };
}

/** Extrait un sous-ensemble de pages dans un nouveau PDF (base64). */
export async function pdfSubset(data: Buffer, indices: number[]): Promise<string> {
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(data);
  } catch (e) {
    throw new Error(`PDF illisible ou protégé par mot de passe (${e instanceof Error ? e.message.slice(0, 80) : e})`);
  }
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  return Buffer.from(await out.save()).toString("base64");
}

export const PDF_OCR_PROMPT = "Transcris fidèlement tout le texte de ces pages de document scanné, dans l'ordre de lecture, sans commentaire. Conserve les tableaux sous forme de lignes de texte. Si une page est vide, ignore-la.";
