import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "@assistant/db";
import { describe, expect, it } from "vitest";
import { MemoryService, slug } from "../src";

function seed() {
  const db: Db = openDatabase(join(mkdtempSync(join(tmpdir(), "mem-")), "t.db"), { key: "k" });
  db.prepare("INSERT INTO accounts(id, provider, email, tokens, created_at) VALUES ('a','google','me@x.com','{}',1)").run();
  const mail = db.prepare("INSERT INTO mails(id, account_id, remote_id, subject, from_name, from_addr, to_addrs, date, snippet, body, created_at) VALUES (?, 'a', ?, ?, ?, ?, '', ?, '', '', 1)");
  mail.run("a:1", "1", "Devis mars", "Jean Dupont", "jean@dupont.fr", 2);
  mail.run("a:2", "2", "Newsletter", "", "news@shop.com", 1);
  db.prepare("INSERT INTO nodes(id, type, label) VALUES ('doc:d1','document','devis.pdf')").run();
  db.prepare(
    "INSERT INTO documents(id, node_id, name, path, ext, size, hash, status, entities, tags, created_at) VALUES ('d1','doc:d1','devis.pdf','/x','.pdf',1,'h','ready',?,?,1)",
  ).run(JSON.stringify([{ name: "Jean Dupont", type: "person" }, { name: "Dupont SARL", type: "org" }, { name: "Lyon", type: "place" }]), JSON.stringify(["Devis", "Mars 2026"]));
  db.prepare("INSERT INTO events(id, title, start_at, end_at, source, source_ref, created_at, updated_at) VALUES ('ai:e1','Livraison',1,2,'ai',?,1,1)").run(JSON.stringify({ type: "mail", id: "a:1" }));
  db.prepare("INSERT INTO tasks(id, title, source_ref, created_at, updated_at) VALUES ('task:t1','Envoyer le budget',?,1,1)").run(JSON.stringify({ type: "mail", id: "a:1" }));
  return { db, mem: new MemoryService(db) };
}

const ids = (db: Db, t: "nodes" | "edges") => db.prepare(t === "nodes" ? "SELECT id FROM nodes" : "SELECT src||'>'||dst||':'||rel AS id FROM edges").all().map((r: any) => r.id as string);

describe("mémoire en graphe", () => {
  it("dérive personnes, organisations, sujets, mails, événements et tâches, avec leurs liens", () => {
    const { db, mem } = seed();
    mem.rebuild();
    const n = ids(db, "nodes");
    expect(n).toEqual(expect.arrayContaining([
      "doc:d1", "mail:a:1", "person:jean@dupont.fr", "ent:person:jean-dupont", "ent:org:dupont-sarl", "ent:topic:lyon",
      "topic:devis", "topic:mars-2026", "event:ai:e1", "task:task:t1",
    ]));
    const e = ids(db, "edges");
    expect(e).toEqual(expect.arrayContaining([
      "person:jean@dupont.fr>mail:a:1:sent",
      "person:jean@dupont.fr>ent:person:jean-dupont:same_as", // même nom que dans le document
      "doc:d1>ent:org:dupont-sarl:mentions",
      "doc:d1>topic:devis:tagged",
      "mail:a:1>event:ai:e1:derived",
      "mail:a:1>task:task:t1:derived",
    ]));
  });

  it("est idempotent et retire ce dont la source a disparu", () => {
    const { db, mem } = seed();
    const first = mem.rebuild();
    expect(mem.rebuild()).toEqual(first);
    db.prepare("DELETE FROM events").run();
    db.prepare("DELETE FROM mails WHERE id='a:2'").run();
    mem.rebuild();
    expect(ids(db, "nodes")).not.toContain("event:ai:e1");
    expect(ids(db, "nodes")).not.toContain("person:news@shop.com");
    expect(ids(db, "nodes")).toContain("doc:d1"); // géré par le pipeline, jamais supprimé ici
  });

  it("l'édition manuelle survit à la reconstruction", () => {
    const { db, mem } = seed();
    mem.rebuild();
    const proj = mem.addNode({ type: "project", label: "Rénovation cuisine" });
    mem.addEdge(proj, "ent:org:dupont-sarl", "prestataire");
    mem.renameNode("ent:org:dupont-sarl", "Dupont & Fils");
    mem.rebuild();
    expect(ids(db, "nodes")).toContain(proj);
    expect(ids(db, "edges")).toContain(`${proj}>ent:org:dupont-sarl:prestataire`);
    expect((db.prepare("SELECT label FROM nodes WHERE id='ent:org:dupont-sarl'").get() as any).label).toBe("Dupont & Fils");
  });

  it("« oubli ciblé » : le nœud et le lien supprimés ne reviennent pas", () => {
    const { db, mem } = seed();
    mem.rebuild();
    mem.forget("topic:mars-2026");
    mem.deleteEdge("doc:d1", "topic:devis", "tagged");
    mem.rebuild();
    expect(ids(db, "nodes")).not.toContain("topic:mars-2026");
    expect(ids(db, "edges")).not.toContain("doc:d1>topic:devis:tagged");
    expect(ids(db, "nodes")).toContain("topic:devis");
  });

  it("valide les entrées d'édition", () => {
    const { mem } = seed();
    mem.rebuild();
    expect(() => mem.addNode({ type: "alien", label: "x" })).toThrow(/Type/);
    expect(() => mem.addNode({ type: "topic", label: "  " })).toThrow(/Libellé/);
    expect(() => mem.addEdge("doc:d1", "doc:d1", "x")).toThrow(/lui-même/);
    expect(() => mem.addEdge("doc:d1", "inexistant", "x")).toThrow(/introuvable/);
  });

  it("graph() : nœuds les plus connectés d'abord, arêtes cohérentes, filtre par type", () => {
    const { mem } = seed();
    mem.rebuild();
    const g = mem.graph();
    expect(g.nodes[0]!.degree).toBeGreaterThanOrEqual(g.nodes.at(-1)!.degree);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.src) && ids.has(e.dst))).toBe(true);
    const onlyPeople = mem.graph({ types: ["person"] });
    expect(onlyPeople.nodes.every((n) => n.type === "person")).toBe(true);
    expect(mem.neighbors("mail:a:1").map((n) => n.id)).toEqual(expect.arrayContaining(["person:jean@dupont.fr", "event:ai:e1"]));
  });

  it("slug", () => {
    expect(slug("Société Générale & Fils")).toBe("societe-generale-fils");
  });
});
