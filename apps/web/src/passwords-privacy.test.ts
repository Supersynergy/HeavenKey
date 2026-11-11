/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { parsePrivacyPreferences, sanitizeActivity, recordActivity, readActivities, clearActivities, buildDiagnostics } from "./passwords-privacy";

afterEach(() => clearActivities());

// Execute the production listener block with suspended timers, not a copy of its logic.
function sessionFixture(extension = false, strictBackground = false) {
  const source = readFileSync(new URL(extension ? "../../extension/smart-popup.ts" : "./passwords.ts", import.meta.url), "utf8");
  const start = source.indexOf(extension ? "for (const type of ['pointerdown','keydown'" : 'for (const name of ["pointerdown", "keydown", "input"');
  const end = source.indexOf(extension ? "\nvoid (async ()" : "\ninitPrivacy(", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  const handlers = new Map<string, (event: Event) => void>();
  const windows = new Map<string, (event: Event) => void>();
  const locks: string[] = [], intervals: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  let now = 1000, timer = 0;
  const document = { visibilityState: "visible", addEventListener: (name: string, handler: (event: Event) => void) => handlers.set(name, handler) };
  const context = createContext({
    document, window: { addEventListener: (name: string, handler: (event: Event) => void) => windows.set(name, handler) },
    addEventListener: (name: string, handler: (event: Event) => void) => windows.set(name, handler),
    Date: { now: () => now }, getPrivacyPreferences: () => ({ strictBackground }),
    lock: (message: string) => locks.push(message),
    setInterval: (handler: () => void) => intervals.push(handler),
    setTimeout: (handler: () => void) => { timers.set(++timer, handler); return timer; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  runInContext('let vault = {}, key = {}, busy = false, lastActivity = 1000, hiddenTimer, hiddenSince = null;\n' + new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end)), context);
  return {
    locks, intervals, timers, advance: (ms: number) => { now += ms; },
    loading: () => runInContext("vault = null; key = null; busy = true;", context),
    input: (name: string) => { const event = new Event(name, { cancelable: true }); handlers.get(name)?.(event); return event; },
    visibility: (value: string) => { document.visibilityState = value; handlers.get("visibilitychange")?.(new Event("visibilitychange")); },
    focus: () => windows.get("focus")?.(new Event("focus")),
  };
}

describe("session deadlines survive suspended browser timers", () => {
  for (const extension of [false, true]) {
    test(`${extension ? "extension" : "web"} checks expiry before refreshing input activity`, () => {
      for (const event of ["pointerdown", "keydown", "input", "click"]) {
        const session = sessionFixture(extension);
        session.advance(extension ? 120_000 : 300_000);
        expect(session.input(event).defaultPrevented).toBe(true);
        expect(session.locks).toHaveLength(1);
      }
    });
    test(`${extension ? "extension" : "web"} preserves activity before expiry and fails closed on clock rollback`, () => {
      const session = sessionFixture(extension);
      session.advance((extension ? 120_000 : 300_000) - 1);
      expect(session.input("input").defaultPrevented).toBe(false);
      session.advance(1); session.intervals[0](); expect(session.locks).toHaveLength(0);
      session.advance(-2); session.focus(); expect(session.locks).toHaveLength(1);
    });
    test(`${extension ? "extension" : "web"} checks expiry immediately on focus`, () => {
      const session = sessionFixture(extension);
      session.advance(extension ? 120_000 : 300_000); session.focus();
      expect(session.locks).toHaveLength(1);
    });
  }
  test("locked metadata loading cannot retrigger idle lock and start another load", () => {
    const session = sessionFixture(); session.loading(); session.advance(300_000);
    session.intervals[0](); session.focus();
    expect(session.locks).toHaveLength(0);
  });
  test("pending unlock still expires at the original background deadline", () => {
    const session = sessionFixture(); session.loading(); session.visibility("hidden");
    session.advance(30_000); session.visibility("visible");
    expect(session.locks).toHaveLength(1);
  });
  test("returning from a suspended background tab checks its original deadline", () => {
    const session = sessionFixture();
    session.visibility("hidden"); session.advance(30_000); session.visibility("visible");
    expect(session.locks).toHaveLength(1);
  });
  test("strict background mode still locks immediately", () => {
    const session = sessionFixture(false, true); session.visibility("hidden");
    expect(session.locks).toHaveLength(1); expect(session.timers.size).toBe(0);
  });
  test("a short background visit cancels its timer without locking", () => {
    const session = sessionFixture();
    session.visibility("hidden"); session.advance(29_999); session.visibility("visible");
    expect(session.locks).toHaveLength(0); expect(session.timers.size).toBe(0);
  });
  test("repeated hidden events cannot extend the background deadline", () => {
    const session = sessionFixture();
    session.visibility("hidden"); session.advance(29_000); session.visibility("hidden");
    session.advance(1000); session.visibility("visible");
    expect(session.locks).toHaveLength(1);
  });
});

describe("strict local privacy metadata", () => {
  test("malformed preferences fall back to bounded defaults", () => {
    const defaults = parsePrivacyPreferences(null);
    expect(defaults).toEqual({ discreet: false, strictBackground: false, revealSeconds: 15 });
    for (const raw of ["", "{", "null", "[]", '"true"', '{"revealSeconds":0}', '{"revealSeconds":900000000}', '{"revealSeconds":"10"}', '{"strictBackground":"false"}']) {
      expect(parsePrivacyPreferences(raw)).toEqual(defaults);
    }
    for (const revealSeconds of [10, 15, 30] as const) {
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
