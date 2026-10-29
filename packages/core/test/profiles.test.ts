import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src";

const mk = () => {
  const rpc = createApp();
  const call = async (method: string, params?: unknown) => JSON.parse((await rpc.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })))!);
  return call;
};

describe("profils : étanchéité et vue combinée", () => {
  it("deux profils = deux bases chiffrées distinctes, sans donnée commune", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prof-"));
    const pro = mk();
    await pro("init", { dataDir, key: "cle-pro", profile: "pro" });
    await pro("tasks.create", { title: "Tâche confidentielle PRO" });
    const perso = mk();
    await perso("init", { dataDir, key: "cle-perso", profile: "perso" });
    expect((await perso("tasks.list")).result).toEqual([]);
    await perso("tasks.create", { title: "Tâche perso" });
    expect((await pro("tasks.list")).result.map((t: any) => t.title)).toEqual(["Tâche confidentielle PRO"]);
    // la clé d'un profil n'ouvre pas la base de l'autre
    expect((await mk()("init", { dataDir, key: "cle-perso", profile: "pro" })).error.message).toMatch(/Clé incorrecte/);
  });

  it("lecture seule : aperçu du jour seulement, tout le reste est refusé", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "prof-"));
    const rw = mk();
    await rw("init", { dataDir, key: "k", profile: "asso" });
    const now = Date.now();
    await rw("calendar.create", { title: "Assemblée", start: now, end: now + 3600_000 });
    await rw("tasks.create", { title: "Envoyer la convocation", due: now });
    await rw("tasks.create", { title: "Plus tard", due: now + 10 * 86_400_000 });

    const ro = mk();
    await ro("init", { dataDir, key: "k", profile: "asso", readOnly: true });
    const o = (await ro("overview")).result;
    expect(o.events.map((e: any) => e.title)).toEqual(["Assemblée"]);
    expect(o.tasks.map((t: any) => t.title)).toEqual(["Envoyer la convocation"]);
    for (const m of ["tasks.create", "settings.set", "chat.send", "documents.add", "agent.runNow", "ai.setKeys", "accounts.connectGoogle"])
      expect((await ro(m, {})).error.code).toBe(-32003);
    expect((await ro("ping")).result).toBe("pong");
  });
});
