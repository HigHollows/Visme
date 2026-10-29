/** Masque les données sensibles avant tout envoi à une API externe. */

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let text = input;

  text = text.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g, (m) => {
    if (!ibanValid(m)) return m;
    bump("iban");
    return "[IBAN]";
  });

  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    bump("card");
    return "[CARTE]";
  });

  text = text.replace(
    /((?:mot de passe|mdp|password|passwd|pwd)\s*(?:est|is|[:=])?\s*)(\S+)/gi,
    (_m, prefix: string) => {
      bump("password");
      return `${prefix}[SECRET]`;
    },
  );

  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})\b/g, () => {
    bump("api_key");
    return "[CLE_API]";
  });

  return { text, counts };
}
