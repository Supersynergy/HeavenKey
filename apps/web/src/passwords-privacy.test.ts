import { afterEach, describe, expect, test } from "bun:test";
import { parsePrivacyPreferences, sanitizeActivity, recordActivity, readActivities, clearActivities, buildDiagnostics } from "./passwords-privacy";

afterEach(() => clearActivities());

describe("strict local privacy metadata", () => {
  test("malformed preferences fall back to bounded defaults", () => {
    const defaults = parsePrivacyPreferences(null);
    expect(defaults).toEqual({ discreet: false, strictBackground: false, revealSeconds: 15 });
    for (const raw of ["", "{", "null", "[]", '"true"', '{"revealSeconds":0}', '{"revealSeconds":900000000}', '{"revealSeconds":"10"}', '{"strictBackground":"false"}']) {
      expect(parsePrivacyPreferences(raw)).toEqual(defaults);
    }
    for (const revealSeconds of [10, 15, 30]) {
      expect(parsePrivacyPreferences(JSON.stringify({ discreet: true, strictBackground: true, revealSeconds, password: "Synthetic discarded secret", username: "discard@example.invalid" })))
        .toEqual({ discreet: true, strictBackground: true, revealSeconds });
    }
  });

  test("activity accepts only allowed action, state and bounded count", () => {
    const event = sanitizeActivity("unlock", "success", 4)!;
    expect(event.action).toBe("unlock"); expect(event.state).toBe("success"); expect(event.count).toBe(4);
    expect(Object.keys(event).every(key => ["action", "state", "timestamp", "count"].includes(key))).toBe(true);
    expect(Number.isFinite(Date.parse(event.timestamp))).toBe(true);
    for (const action of ["Synthetic title", "https://example.invalid/login", "copy-password-secret", "__proto__", { action: "unlock", password: "Synthetic secret" }]) {
      expect(sanitizeActivity(action, "success")).toBeNull();
    }
    for (const state of ["Failed to fetch synthetic@example.invalid", "Synthetic raw error", "__proto__", {}, null]) expect(sanitizeActivity("unlock", state)).toBeNull();
    for (const count of [-1, 1.5, Infinity, NaN, "synthetic@example.invalid", 1001]) {
      const bounded = sanitizeActivity("unlock", "success", count)!;
      expect(bounded.count === undefined || (Number.isInteger(bounded.count) && bounded.count >= 0 && bounded.count <= 1000)).toBe(true);
    }
  });

  test("session ring remains bounded, copies events and clears completely", () => {
    for (let index = 0; index < 65; index++) recordActivity("unlock", index % 2 ? "success" : "error", index);
    recordActivity("Synthetic private name", "success");
    const events = readActivities(); expect(events).toHaveLength(40);
    expect(events[0].count).toBe(25); expect(events[39].count).toBe(64);
    events[0].action = "Synthetic injected secret" as typeof events[0]["action"];
    events.splice(1);
    expect(readActivities()).toHaveLength(40);
    expect(JSON.stringify(readActivities())).not.toContain("Synthetic injected secret");
    clearActivities(); expect(readActivities()).toEqual([]);
  });

  test("diagnostics rebuild strict metadata and exclude caller extras", () => {
    recordActivity("unlock", "success", 1);
    const settings = { discreet: true, strictBackground: true, revealSeconds: 10, username: "private@example.invalid", password: "Synthetic password" };
    const report = buildDiagnostics(settings);
    expect(Object.keys(report).sort()).toEqual(["app", "events", "settings", "version"]);
    expect(report.app).toBe("HeavenKey"); expect(typeof report.version).toBe("string");
    expect(report.settings).toEqual({ discreet: true, strictBackground: true, revealSeconds: 10 });
    expect(report.events).toEqual(readActivities());
    expect(JSON.stringify(report)).not.toContain("private@example.invalid");
    expect(JSON.stringify(report)).not.toContain("Synthetic password");
    report.events.length = 0; expect(readActivities()).toHaveLength(1);
  });
});
