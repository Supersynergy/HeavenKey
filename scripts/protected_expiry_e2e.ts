import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ProtectedHarness, delay, until } from "./protected_delivery_e2e";

const report = resolve(process.env.HEAVENKEY_EXPIRY_REPORT || "docs/evidence/protected-expiry.json"), h = new ProtectedHarness(18358, 18359, report);
let passed = false, cleaned = false, elapsed = 0, wallElapsed = 0;
try {
 const client = await h.start(), intentWall = Date.now(), workspace = await h.compose(client.client_id);
 const publishedAt = performance.now(), publishedWall = Date.now();
 const request = await h.approve(client.token, workspace); await h.ready(workspace);
 const draft = h.draft(workspace); assert.equal((await h.agent("protected-draft", client.token, { workspace_id: workspace.workspace_id, text: draft })).status, 200);
 const ownerState = (await h.owner("/api/password-broker")).value; assert(ownerState.unlocked); assert(ownerState.sessions.length > 0); assert((await h.profiles()).length > 0); assert(h.privatePids().length > 0);
 const expiresAt = (await h.ownerWorkspace(workspace.workspace_id)).expires_at; assert(expiresAt * 1000 - intentWall >= 299000); assert(expiresAt * 1000 - publishedWall <= 300000);
 h.check("Actual approved workspace has an active private Chromium job/profile and normal 300-second TTL; no clock or TTL override");
 while (performance.now() - publishedAt < 301000) {
  await h.page.bringToFront(); await h.page.keyboard.press("Shift"); h.heartbeatKeys++;
  assert(await h.page.locator("#workspace:not([hidden])").isVisible()); assert.equal((await h.owner("/api/password-broker")).value.unlocked, true);
  const age = performance.now() - publishedAt;
  if (age < 285000) { assert.equal((await h.agent("protected-list", client.token)).value.workspaces.length, 1); assert.deepEqual((await h.agent("status", client.token, { request_id: request })).value, { status: "approved" }); }
  console.log(JSON.stringify({ phase: "real-clock-expiry", elapsed_seconds: Math.round(age / 1000), owner_unlocked: true }));
  await delay(Math.min(30000, Math.max(1, 301000 - age)));
 }
 elapsed = performance.now() - publishedAt; wallElapsed = Date.now() - publishedWall; assert(elapsed >= 300000); assert(wallElapsed >= 300000);
 await h.page.keyboard.press("Shift"); h.heartbeatKeys++;
 assert.equal((await h.agent("protected-list", client.token)).value.workspaces.length, 0);
 const status = await h.agent("status", client.token, { request_id: request }); assert.equal(status.status, 200); assert.deepEqual(Object.keys(status.value), ["status"]); assert(["closed", "expired"].includes(status.value.status));
 assert.notEqual((await h.agent("protected-draft", client.token, { workspace_id: workspace.workspace_id, text: draft })).status, 200);
 assert.notEqual((await h.agent("protected-login", client.token, { workspace_id: workspace.workspace_id })).status, 200);
 const after = await h.owner("/api/password-broker"); assert.equal(after.value.unlocked, true); assert.equal(after.value.sessions.length, 0); assert(after.value.clients.some((item: any) => item.id === client.client_id));
 await until(() => h.profiles(), value => value.length === 0, 15); assert.equal(h.privatePids().length, 0); assert(h.heartbeatKeys >= 11);
 h.check("After at least 300 real seconds workspace list excludes grant, approval/status is closed or expired, draft/login replay denied, private job/profile/process removed while owner remains unlocked and same client survives");
 await h.screenshot("expiry-owner-still-unlocked"); h.noLeaks(); await h.verifyBinding(); h.check("No private canaries in agent/owner transport, no clipboard writes/page errors, immutable source/binary binding"); passed = true;
} catch (error) { h.errors.push(error instanceof Error ? error.message : String(error)); console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }
finally {
 try { await h.cleanup(); cleaned = true; } catch (error) { passed = false; h.errors.push(String(error)); process.exitCode = 1; }
 await h.report(passed, { elapsed_real_monotonic_ms: elapsed, elapsed_wall_ms: wallElapsed, production_workspace_ttl_seconds: 300, owner_actual_keyboard_heartbeats: h.heartbeatKeys, owner_unlocked_at_expiry: passed, private_profiles_cleaned: cleaned, scope: "Unshortened real-clock local browser workspace expiry; owner activity deliberately remains live" }); console.log(JSON.stringify({ pass: passed, report }));
}
