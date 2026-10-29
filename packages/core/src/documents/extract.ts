import { extname } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRY = 30 * 1024 * 1024;
const MAX_SHEET_ROWS = 5000;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv"]);
const OFFICE_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

export const SUPPORTED_EXTENSIONS = [...TEXT_EXT, ...OFFICE_EXT, ...Object.keys(IMAGE_MIME)];

export type Extracted =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; data: Buffer };

export function isSupported(name: string) {
  return SUPPORTED_EXTENSIONS.includes(extname(name).toLowerCase());
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeUnzip(buf: Buffer, wanted: (name: string) => boolean) {
  return unzipSync(new Uint8Array(buf), {
    // Garde-fou contre les "zip bombs" : on ne décompresse que les entrées utiles et bornées.
    filter: (f) => wanted(f.name) && f.originalSize <= MAX_ZIP_ENTRY,
  });
}

async function pdfText(buf: Buffer) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function docxText(buf: Buffer) {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

async function xlsxText(buf: Buffer) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  const parts: string[] = [];
  wb.eachSheet((sheet) => {
    parts.push(`# Feuille : ${sheet.name}`);
    let n = 0;
    sheet.eachRow((row) => {
      if (n++ >= MAX_SHEET_ROWS) return;
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object" && "text" in (v as object)) return String((v as { text: unknown }).text);
        if (typeof v === "object" && "result" in (v as object)) return String((v as { result: unknown }).result);
        return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      });
      parts.push(cells.join(" | "));
    });
  });
  return parts.join("\n");
}

function pptxText(buf: Buffer) {
  const files = safeUnzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(files).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return slides
    .map((name, i) => {
      const xml = strFromU8(files[name]!);
      const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]!));
      return `# Diapositive ${i + 1}\n${runs.join("\n")}`;
    })
    .join("\n\n");
}

export async function extract(name: string, buf: Buffer): Promise<Extracted> {
  if (buf.length > MAX_FILE_BYTES) throw new Error("Fichier trop volumineux (max 50 Mo)");
  const ext = extname(name).toLowerCase();
  if (IMAGE_MIME[ext]) return { kind: "image", mime: IMAGE_MIME[ext]!, data: buf };
  if (TEXT_EXT.has(ext)) return { kind: "text", text: buf.toString("utf8") };
  switch (ext) {
    case ".pdf":
      return { kind: "text", text: await pdfText(buf) };
    case ".docx":
      return { kind: "text", text: await docxText(buf) };
    case ".xlsx":
      return { kind: "text", text: await xlsxText(buf) };
    case ".pptx":
      return { kind: "text", text: pptxText(buf) };
    default:
      throw new Error(`Format non pris en charge : ${ext || name}`);
  }
}
