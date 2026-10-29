import { describe, expect, it } from "vitest";
import { AIError, AnthropicProvider, OpenAIProvider, type ChatChunk } from "../src";

const sse = (events: object[], done = false) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

async function collect(it: AsyncIterable<ChatChunk>) {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("AnthropicProvider", () => {
  it("diffuse le texte, assemble un appel d'outil et renvoie l'usage", async () => {
    let sent: any;
    const p = new AnthropicProvider({
      apiKey: "k",
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, headers: init.headers, body: JSON.parse(init.body as string) };
        return sse([
          { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sal" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ut" } },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "cree_tache" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"titre":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"X"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", usage: { output_tokens: 7 } },
        ]);
      }) as never,
    });
    const chunks = await collect(
      p.chat({
        model: "m",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(chunks.filter((c) => c.type === "text").map((c: any) => c.text).join("")).toBe("Salut");
    expect(chunks).toContainEqual({ type: "tool_call", id: "t1", name: "cree_tache", args: { titre: "X" } });
    expect(chunks).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 7 });
    expect(sent.body.system).toBe("sys");
    expect(sent.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.headers["x-api-key"]).toBe("k");
  });

  it("classe les erreurs HTTP", async () => {
    const mk = (status: number) =>
      new AnthropicProvider({ apiKey: "k", fetch: (async () => new Response("no", { status })) as never });
    await expect(collect(mk(429).chat({ model: "m", messages: [] }))).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(collect(mk(401).chat({ model: "m", messages: [] }))).rejects.toMatchObject({ kind: "auth" });
    await expect(collect(mk(529).chat({ model: "m", messages: [] }))).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("testConnection : ok / refus / réseau", async () => {
    const ok = new AnthropicProvider({ apiKey: "k", fetch: (async () => new Response("{}")) as never });
    expect(await ok.testConnection()).toEqual({ ok: true });
    const bad = new AnthropicProvider({ apiKey: "k", fetch: (async () => new Response("x", { status: 401 })) as never });
    expect((await bad.testConnection()).ok).toBe(false);
    const down = new AnthropicProvider({ apiKey: "k", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as never });
    expect((await down.testConnection()).error).toContain("ECONNREFUSED");
  });

  it("ne propose pas d'embeddings", async () => {
    await expect(new AnthropicProvider({ apiKey: "k" }).embed()).rejects.toBeInstanceOf(AIError);
  });
});

describe("OpenAIProvider", () => {
  it("diffuse, assemble les appels d'outils fragmentés et lit l'usage", async () => {
    const p = new OpenAIProvider({
      apiKey: "k",
      fetch: (async () =>
        sse(
          [
            { choices: [{ delta: { content: "Bon" } }] },
            { choices: [{ delta: { content: "jour" } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "agenda", arguments: '{"a"' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
            { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
          ],
          true,
        )) as never,
    });
    const chunks = await collect(p.chat({ model: "m", messages: [{ role: "user", content: "x" }] }));
    expect(chunks.filter((c) => c.type === "text").map((c: any) => c.text).join("")).toBe("Bonjour");
    expect(chunks).toContainEqual({ type: "tool_call", id: "c1", name: "agenda", args: { a: 1 } });
    expect(chunks).toContainEqual({ type: "usage", inputTokens: 5, outputTokens: 3 });
  });

  it("embeddings : remet les vecteurs dans l'ordre", async () => {
    const p = new OpenAIProvider({
      apiKey: "k",
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }))) as never,
    });
    expect(await p.embed(["a", "b"], "m")).toEqual([[1], [2]]);
  });

  it("utilise la baseUrl d'un endpoint compatible", async () => {
    let url = "";
    const p = new OpenAIProvider({
      apiKey: "k",
      baseUrl: "https://exemple.test/v1/",
      id: "mistral",
      fetch: (async (u: string) => { url = u; return new Response("{}"); }) as never,
    });
    await p.testConnection();
    expect(url).toBe("https://exemple.test/v1/models");
    expect(p.id).toBe("mistral");
  });
});

describe("vision", () => {
  const img = { mime: "image/png", data: "AAAA" };
  it("Anthropic : image en bloc base64 avant le texte", async () => {
    let body: any;
    const p = new AnthropicProvider({ apiKey: "k", fetch: (async (_u: string, i: RequestInit) => { body = JSON.parse(i.body as string); return sse([]); }) as never });
    await collect(p.chat({ model: "m", messages: [{ role: "user", content: "lis", images: [img] }] }));
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "lis" },
    ]);
  });
  it("OpenAI : image en data URL", async () => {
    let body: any;
    const p = new OpenAIProvider({ apiKey: "k", fetch: (async (_u: string, i: RequestInit) => { body = JSON.parse(i.body as string); return sse([], true); }) as never });
    await collect(p.chat({ model: "m", messages: [{ role: "user", content: "lis", images: [img] }] }));
    expect(body.messages[0].content[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });
});

describe("transcription", () => {
  const ok = (body: object, calls: any[] = []) =>
    new OpenAIProvider({ apiKey: "k", fetch: (async (_u: string, init: RequestInit) => { calls.push(init.body as FormData); return new Response(JSON.stringify(body)); }) as never });

  it("whisper-1 : segments horodatés ; fichier nommé avec son extension", async () => {
    const calls: FormData[] = [];
    const p = ok({ text: "Bonjour tout le monde", segments: [{ start: 0, end: 2.5, text: " Bonjour " }, { start: 2.5, end: 4, text: "tout le monde" }, { start: 4, end: 5, text: "  " }] }, calls);
    const t = await p.transcribe(new Uint8Array([1, 2, 3]), { model: "whisper-1", language: "fr", filename: "reunion.m4a", mime: "audio/mp4" });
    expect(t.segments).toEqual([{ start: 0, end: 2.5, speaker: undefined, text: "Bonjour" }, { start: 2.5, end: 4, speaker: undefined, text: "tout le monde" }]);
    const f = calls[0]!;
    expect(f.get("response_format")).toBe("verbose_json");
    expect(f.get("language")).toBe("fr");
    expect((f.get("file") as File).name).toBe("reunion.m4a");
  });

  it("modèle diarize : interlocuteurs conservés", async () => {
    const calls: FormData[] = [];
    const p = ok({ segments: [{ start: 0, end: 1, speaker: "A", text: "Salut" }, { start: 1, end: 2, speaker: "B", text: "Hello" }] }, calls);
    const t = await p.transcribe(new Uint8Array([1]), { model: "gpt-4o-transcribe-diarize" });
    expect(t.text).toBe("Salut Hello");
    expect(t.segments?.map((s) => s.speaker)).toEqual(["A", "B"]);
    expect(calls[0]!.get("response_format")).toBe("diarized_json");
  });

  it("modèle simple : texte seul ; erreurs HTTP classées", async () => {
    expect(await ok({ text: " ok " }).transcribe(new Uint8Array([1]), { model: "gpt-4o-mini-transcribe" })).toEqual({ text: "ok" });
    const bad = new OpenAIProvider({ apiKey: "k", fetch: (async () => new Response("quota", { status: 429 })) as never });
    await expect(bad.transcribe(new Uint8Array([1]), { model: "whisper-1" })).rejects.toMatchObject({ kind: "rate_limit" });
  });
});
