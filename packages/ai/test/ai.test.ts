import { describe, expect, it } from "vitest";
import {
  AIError,
  AIRouter,
  CostTracker,
  redact,
  type AIProvider,
  type ChatChunk,
} from "../src";

// IBAN FR de test valide et numéro de carte de test Visa (Luhn valide)
const IBAN = "FR1420041010050500013M02606";
const CARD = "4111 1111 1111 1111";

function fake(id: string, behavior: () => AsyncIterable<ChatChunk>): AIProvider {
  return {
    id,
    capabilities: { chat: true, tools: true, vision: false, embeddings: true, transcription: false },
    chat: behavior,
    embed: async (t) => t.map(() => [0]),
    transcribe: async () => ({ text: "" }),
    testConnection: async () => ({ ok: true }),
  };
}

async function collect(it: AsyncIterable<ChatChunk>) {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("redact", () => {
  it("masque IBAN, carte, mot de passe et clé API", () => {
    const r = redact(`Mon IBAN ${IBAN}, carte ${CARD}, mot de passe: hunter2, clé sk-abcdefghijklmnop1234`);
    expect(r.text).not.toContain(IBAN);
    expect(r.text).not.toContain("4111");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("sk-abcdef");
    expect(r.counts).toMatchObject({ iban: 1, card: 1, password: 1, api_key: 1 });
  });

  it("ne touche pas un nombre qui n'est pas une carte", () => {
    expect(redact("Facture 1234567890123").text).toBe("Facture 1234567890123");
  });
});

describe("CostTracker", () => {
  it("bloque au-delà du plafond journalier", () => {
    const t = new CostTracker({ dailyUsd: 1 });
    t.record(0.6);
    t.assertWithinBudget();
    t.record(0.5);
    expect(() => t.assertWithinBudget()).toThrow(AIError);
  });
});

describe("AIRouter", () => {
  const route = (p: string) => ({ provider: p, model: "m" });

  it("bascule sur le fallback si le primaire est en rate limit", async () => {
    const bad = fake("a", async function* () {
      throw new AIError("429", "rate_limit");
    });
    const good = fake("b", async function* () {
      yield { type: "text", text: "ok" };
    });
    const router = new AIRouter({
      providers: { a: bad, b: good },
      routes: { chat: { primary: route("a"), fallback: route("b") } },
    });
    const chunks = await collect(router.chat("chat", { messages: [{ role: "user", content: "x" }] }));
    expect(chunks).toEqual([{ type: "text", text: "ok" }]);
  });

  it("ne bascule pas sur une erreur d'authentification", async () => {
    const bad = fake("a", async function* () {
      throw new AIError("401", "auth");
    });
    const router = new AIRouter({
      providers: { a: bad, b: bad },
      routes: { chat: { primary: route("a"), fallback: route("b") } },
    });
    await expect(collect(router.chat("chat", { messages: [] }))).rejects.toThrow("401");
  });

  it("masque les données sensibles avant l'envoi, sauf le prompt système", async () => {
    let seen = "";
    const p = fake("a", async function* (this: unknown) {
      yield { type: "done" };
    });
    p.chat = async function* (req) {
      seen = req.messages.map((m) => m.content).join("|");
      yield { type: "done" };
    };
    const router = new AIRouter({
      providers: { a: p },
      routes: { triage: { primary: route("a") } },
      redactSensitive: true,
    });
    await collect(
      router.chat("triage", {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: `iban ${IBAN}` },
        ],
      }),
    );
    expect(seen).toContain("[IBAN]");
    expect(seen).not.toContain(IBAN);
  });

  it("enregistre le coût et l'audit", async () => {
    const p = fake("a", async function* () {
      yield { type: "usage", inputTokens: 1_000_000, outputTokens: 0 };
    });
    const tracker = new CostTracker();
    const audit: number[] = [];
    const router = new AIRouter({
      providers: { a: p },
      routes: { chat: { primary: route("a") } },
      prices: { "a/m": { inputPerM: 3, outputPerM: 15 } },
      tracker,
      audit: (e) => audit.push(e.usd),
    });
    await collect(router.chat("chat", { messages: [] }));
    expect(tracker.today()).toBe(3);
    expect(audit).toEqual([3]);
  });
});
