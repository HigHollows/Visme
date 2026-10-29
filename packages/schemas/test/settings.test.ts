import { describe, expect, it } from "vitest";
import { SETTINGS_VERSION, exportSettings, migrateSettings } from "../src";

describe("settings", () => {
  it("applique les valeurs par défaut sur un objet vide", () => {
    const s = migrateSettings({});
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.agent.autonomy).toBe("propose");
    expect(s.agent.draftOnly).toBe(true);
    expect(s.ai.redactSensitive).toBe(true);
  });

  it("migre la v1 vers la v2", () => {
    const s = migrateSettings({ version: 1, ai: { dailyLimit: 2 } });
    expect(s.ai.limits.dailyUsd).toBe(2);
  });

  it("refuse des settings venant du futur", () => {
    expect(() => migrateSettings({ version: 99 })).toThrow();
  });

  it("rejette une valeur invalide", () => {
    expect(() => migrateSettings({ agent: { syncIntervalMinutes: 0 } })).toThrow();
  });

  it("n'exporte aucun secret", () => {
    const s = migrateSettings({});
    const withSecret = { ...s, ai: { ...s.ai, apiKey: "sk-secret" } };
    expect(exportSettings(withSecret as never)).not.toContain("sk-secret");
  });
});
