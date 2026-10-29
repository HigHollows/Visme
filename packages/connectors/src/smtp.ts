import nodemailer from "nodemailer";
import { buildRfc822, sanitizeOutgoing, type OutgoingMail } from "./mime";

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS implicite (465). Sinon STARTTLS est exigé. */
  secure: boolean;
  user: string;
  pass: string;
  /** Réservé aux tests sur la machine locale. */
  insecure?: boolean;
}

const LOCAL = /^(localhost|127\.0\.0\.1|::1)$/;

function transport(c: SmtpConfig) {
  if (c.insecure && !LOCAL.test(c.host)) throw new Error("Connexion non chiffrée refusée (hôte distant)");
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass },
    requireTLS: !c.secure && !c.insecure, // STARTTLS obligatoire : on ne laisse jamais partir un mot de passe en clair
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    ignoreTLS: !!c.insecure,
  });
}

export async function testSmtp(c: SmtpConfig): Promise<void> {
  const t = transport(c);
  try { await t.verify(); } finally { t.close(); }
}

/** Envoie un message (action sensible : à n'appeler qu'après validation explicite de l'utilisateur). */
export async function sendSmtp(c: SmtpConfig, mail: OutgoingMail): Promise<void> {
  const m = sanitizeOutgoing(mail);
  const raw = await buildRfc822(m);
  const t = transport(c);
  try {
    await t.sendMail({ envelope: { from: m.from, to: [...m.to, ...(m.cc ?? [])] }, raw });
  } finally {
    t.close();
  }
}
