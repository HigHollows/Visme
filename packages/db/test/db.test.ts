import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, openDatabase } from "../src";

const tmp = () => join(mkdtempSync(join(tmpdir(), "db-")), "t.db");

describe("db", () => {
  it("chiffre le fichier et refuse une mauvaise clé", () => {
    const p = tmp();
    const db = openDatabase(p, { key: "bonne-cle" });
    db.prepare("INSERT INTO kv VALUES ('secret','CONTENU_CONFIDENTIEL')").run();
    db.close();
    expect(readFileSync(p).includes("CONTENU_CONFIDENTIEL")).toBe(false);
    expect(() => openDatabase(p, { key: "mauvaise" })).toThrow(/Clé incorrecte/);
    const again = openDatabase(p, { key: "bonne-cle" });
    expect(again.prepare("SELECT value FROM kv").get()).toEqual({ value: "CONTENU_CONFIDENTIEL" });
  });

  it("applique les migrations une seule fois", () => {
    const p = tmp();
    openDatabase(p, { key: "k" }).close();
    const db = openDatabase(p, { key: "k" });
    expect(db.pragma("user_version", { simple: true })).toBe(3);
  });

  it("recherche plein texte et vectorielle", () => {
    const db = openDatabase(tmp(), { key: "k", vectorDim: 3 });
    db.prepare("INSERT INTO nodes(id,type,label) VALUES ('d1','document','Devis')").run();
    db.prepare("INSERT INTO chunks(node_id,text) VALUES ('d1','devis de mars pour Dupont')").run();
    const hit = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'dupont'").all();
    expect(hit).toHaveLength(1);
    const buf = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    db.prepare("INSERT INTO chunk_vec(rowid, embedding) VALUES (1, ?)").run(buf([1, 0, 0]));
    db.prepare("INSERT INTO chunk_vec(rowid, embedding) VALUES (2, ?)").run(buf([0, 1, 0]));
    const nn = db
      .prepare("SELECT rowid FROM chunk_vec WHERE embedding MATCH ? AND k = 1")
      .get(buf([0.9, 0.1, 0]));
    expect(nn).toEqual({ rowid: 1 });
  });

  it("journalise les actions", () => {
    const db = openDatabase(tmp(), { key: "k" });
    audit(db, "ai", "event.create", { id: 1 }, { delete: 1 });
    expect(db.prepare("SELECT actor, action FROM audit_log").get()).toEqual({ actor: "ai", action: "event.create" });
  });
});
