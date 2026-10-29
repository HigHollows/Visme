/** Découpe un texte en passages d'environ `size` caractères, en respectant les paragraphes quand c'est possible. */
export function chunkText(text: string, size = 1000, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n/).flatMap((p) => {
    if (p.length <= size) return [p];
    // Paragraphe trop long : coupe sur les phrases, puis en dur.
    const out: string[] = [];
    let cur = "";
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + s.length + 1 > size) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${s}` : s;
      while (cur.length > size) {
        out.push(cur.slice(0, size));
        cur = cur.slice(size);
      }
    }
    if (cur) out.push(cur);
    return out;
  });

  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur);
      // Chevauchement : on reprend la fin du passage précédent pour garder le contexte.
      cur = cur.slice(-overlap).replace(/^\S*\s/, "");
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
