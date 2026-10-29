// Exécuté dans un processus Node isolé : `node --permission --allow-fs-read=<runner> --allow-fs-read=<dossier du plugin>`.
// Le permission model de Node interdit déjà : lecture/écriture de fichiers hors liste, child_process, worker, addons natifs.
// Ici on retire en plus le réseau (fetch, WebSocket, modules net/http/dns/tls…) et process.kill.
// Limite connue : ce n'est pas une frontière de sécurité contre du code hostile déterminé (pas de sandbox OS) ;
// les plugins sont vérifiés (empreinte), explicitement autorisés par l'utilisateur et toutes leurs actions sont journalisées.
import Module from "node:module";
import { pathToFileURL } from "node:url";

const BLOCKED = new Set([
  "net", "http", "https", "http2", "tls", "dgram", "dns", "dns/promises", "child_process", "cluster",
  "worker_threads", "inspector", "inspector/promises", "repl", "vm", "v8", "wasi", "diagnostics_channel", "trace_events", "perf_hooks",
]);
Module.registerHooks({
  resolve(specifier, context, next) {
    if (BLOCKED.has(specifier.replace(/^node:/, ""))) throw new Error(`Module « ${specifier} » interdit dans un plugin`);
    return next(specifier, context);
  },
});
for (const g of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "WebTransport"]) {
  try { delete globalThis[g]; } catch {}
}
process.kill = () => { throw new Error("process.kill interdit dans un plugin"); };

const [, , , entry] = process.argv;
const pending = new Map();
let nextId = 1;
let apiCalls = 0;

/** Appel de l'API hôte (soumis aux permissions accordées côté hôte). */
function api(method, params) {
  if (++apiCalls > 300) return Promise.reject(new Error("Trop d'appels d'API dans une exécution"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: "api", id, method, params });
  });
}

const ctx = {
  ai: { complete: (p) => api("ai.complete", p) },
  documents: { list: (p) => api("documents.list", p ?? {}), get: (id) => api("documents.get", { id }) },
  mail: { search: (p) => api("mail.search", p), get: (id) => api("mail.get", { id }) },
  calendar: { list: (p) => api("calendar.list", p) },
  memory: { neighbors: (id) => api("memory.neighbors", { id }), link: (p) => api("memory.link", p) },
  proposals: { create: (p) => api("proposals.create", p) },
  net: { fetch: (url, init) => api("net.fetch", { url, init }) },
  storage: { get: (key) => api("storage.get", { key }), set: (key, value) => api("storage.set", { key, value }), delete: (key) => api("storage.delete", { key }) },
  log: (...args) => { api("log", { args: args.map((a) => String(a).slice(0, 500)) }).catch(() => {}); },
};

let mod;
try {
  mod = (await import(pathToFileURL(entry).href)).default ?? {};
} catch (e) {
  process.send({ type: "fatal", error: String(e?.message ?? e) });
  process.exit(1);
}

process.on("message", async (m) => {
  if (m.type === "api-result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  } else if (m.type === "invoke") {
    try {
      let result = null;
      if (m.kind === "event") await mod.on?.[m.name]?.(ctx, m.payload);
      else if (m.kind === "tool") {
        const fn = mod.tools?.[m.name];
        if (!fn) throw new Error(`Outil inconnu : ${m.name}`);
        result = String(await fn(ctx, m.payload));
      }
      process.send({ type: "result", result });
    } catch (e) {
      process.send({ type: "result", error: String(e?.message ?? e) });
    }
  }
});
process.send({ type: "ready" });
