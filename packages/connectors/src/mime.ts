import MailComposer from "nodemailer/lib/mail-composer/index.js";

export interface OutgoingMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** Pour une réponse : Message-ID RFC du mail d'origine (conserve le fil de discussion). */
  inReplyTo?: string;
  references?: string[];
}

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** Valide et assainit un message sortant (pas d'injection d'en-têtes, destinataires bornés). */
export function sanitizeOutgoing(m: OutgoingMail): OutgoingMail {
  const addrs = (l: string[] | undefined) => (l ?? []).map((a) => oneLine(a).toLowerCase());
  const to = addrs(m.to);
  const cc = addrs(m.cc);
  if (!to.length) throw new Error("Destinataire requis");
  if (to.length + cc.length > 50) throw new Error("Trop de destinataires (50 max)");
  for (const a of [...to, ...cc, oneLine(m.from).toLowerCase()]) if (!EMAIL.test(a)) throw new Error(`Adresse invalide : ${a}`);
  const subject = oneLine(m.subject).slice(0, 300);
  if (!subject) throw new Error("Objet requis");
  if (!m.text.trim()) throw new Error("Message vide");
  return {
    from: oneLine(m.from), to, cc, subject, text: m.text.slice(0, 200_000),
    inReplyTo: m.inReplyTo ? oneLine(m.inReplyTo).slice(0, 998) : undefined,
    references: m.references?.map((r) => oneLine(r).slice(0, 998)).slice(0, 20),
  };
}

export async function buildRfc822(raw: OutgoingMail): Promise<Buffer> {
  const m = sanitizeOutgoing(raw);
  return new Promise((resolve, reject) => {
    new MailComposer({
      from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text,
      inReplyTo: m.inReplyTo, references: m.references,
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}
