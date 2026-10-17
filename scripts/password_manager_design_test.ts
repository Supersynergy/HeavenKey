import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { appearanceChecks } from "./password_manager_appearance_test";

// Runs inside the real encrypted-API acceptance, with one persisted synthetic login.
export async function designChecks(page: Page, master: string, check: (name: string, pass?: boolean) => void) {
  await page.locator("#main-navigation").waitFor({ state: "visible", timeout: 2000 });
  const pane = await Promise.all(["#main-navigation", "#list-pane", "#detail"].map(id => page.locator(id).boundingBox()));
  assert(pane.every(Boolean), "all three desktop panes are visible");
  assert(pane[0]!.x + pane[0]!.width <= pane[1]!.x + 1 && pane[1]!.x + pane[1]!.width <= pane[2]!.x + 1, "navigation, list and detail occupy separate columns");
  check("design: three-pane desktop navigation uses real decrypted login");
  await page.getByRole("button", { name: /Sicherheitscheck/ }).waitFor({ state: "visible", timeout: 2000 });

  await page.locator("#search").fill("Synthetic");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  assert.equal(await page.locator("#search").evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.locator('#detail [data-testid="edit-entry"]').waitFor();
  const originalTitle = await page.locator("#detail h2").textContent();
  check("design: keyboard search selects a real entry and exposes field actions");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await page.locator('#detail [data-testid="copy-password"]').click();
  await page.waitForFunction(() => document.querySelector("#status")!.textContent!.includes("Kopiert"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Synthetic-login-secret-6#X");
  check("design: selected field copies decrypted synthetic password through browser clipboard");

  await page.locator('#detail [data-testid="edit-entry"]').click();
  await page.locator("#editor[open]").waitFor();
  assert.equal(await page.locator("#entry-title").evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#editor").isVisible(), false);
  assert.equal(await page.locator("#search").inputValue(), "Synthetic");
  assert.equal(await page.locator("#detail h2").textContent(), originalTitle);
  assert.equal(await page.locator('#detail [data-testid="edit-entry"]').evaluate(el => el === document.activeElement), true);
  check("design: native editor Escape restores focus, selection and search");

  await page.locator("#search").fill("");
  await page.locator("#new-entry").click(); await page.locator("#entry-title").fill("Alpha design fixture");
  await page.locator("#entry-password").fill("Synthetic-design-secret"); await page.locator("#entry-tags").fill("design-only");
  await page.locator("#save-entry").click();
  await page.waitForFunction(() => document.querySelectorAll('#entries > li').length === 2 && document.querySelector('#workspace')!.getAttribute('aria-busy') === 'false');
  await page.locator("#sort").selectOption("name");
  assert.match((await page.locator('#entries > li').first().textContent())!, /Alpha design fixture/);
  await page.locator("#sort").selectOption("reverse");
  assert.match((await page.locator('#entries > li').first().textContent())!, /Synthetic/);
  await page.locator("#nav-favorites").click(); assert.equal(await page.locator('#entries > li').count(), 1);
  assert.match((await page.locator('#entries > li').textContent())!, /Synthetic/);
  await page.locator("#tag-navigation").getByRole("button", { name: /design-only/ }).click();
  assert.equal(await page.locator('#entries > li').count(), 1);
  assert.match((await page.locator('#entries > li').textContent())!, /Alpha design fixture/);
  check("design: A–Z/Z–A, favorites and tag navigation filter encrypted data");
  await page.locator('[data-testid="select-entry"]').click();
  await page.locator('#detail [data-testid="delete-entry"]').click(); await page.keyboard.press("Escape");
  assert.equal(await page.locator("#delete-dialog").isVisible(), false);
  await page.locator('#detail [data-testid="delete-entry"]').click(); await page.locator("#delete-confirm").click();
  await page.locator("#nav-all").click(); await page.locator("#sort").selectOption("name");
  await page.waitForFunction(() => document.querySelectorAll('#entries > li').length === 1 && document.querySelector('#workspace')!.getAttribute('aria-busy') === 'false');
  await healthChecks(page, master, check);

  await page.locator("#nav-settings").click(); await page.locator("#settings-view").waitFor({ state: "visible" });
  for (const id of ["import-file", "restore-file", "new-master"]) {
    await page.locator(`#${id}`).evaluate(el => (el.closest("details") as HTMLDetailsElement).open = true);
    assert(await page.locator(`#${id}`).isVisible(), `${id} reachable in real settings`);
  }
  assert(await page.locator("#export-backup").isVisible());
  await page.locator("#close-settings").click();
  check("design: import, encrypted backup, restore and rekey are reachable from settings");
  await page.screenshot({ path: "docs/evidence/password-manager/design-desktop.png", fullPage: true });

  await page.locator("#theme-toggle").click();
  const theme = await page.locator("html").getAttribute("data-theme"); assert(theme === "light" || theme === "dark");
  await page.reload(); await page.locator("#unlock:not([disabled])").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  await page.locator("#master").fill(master); await page.locator("#unlock").click(); await page.locator("#workspace:not([hidden])").waitFor();
  check("design: theme survives reload and encrypted vault unlock");
  await appearanceChecks(page, master, check);

  for (const width of [320, 375, 414, 768, 1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 560) {
      await page.locator("#search").fill("Synthetic"); await page.locator('[data-testid="select-entry"]').click();
      assert(await page.locator("#detail").isVisible()); await page.locator("#back-to-list").click();
      assert.equal(await page.locator("#search").inputValue(), "Synthetic");
      assert(await page.locator("#list-pane").isVisible());
      if (width === 375) await page.screenshot({ path: "docs/evidence/password-manager/design-mobile.png", fullPage: true });
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}`);
  }
  check("design: mobile detail/back preserves search at 320/375/414px; no overflow through 1440px");
  await page.locator("#search").fill(""); await page.locator('[data-testid="select-entry"]').click();
  await page.locator('#detail [data-testid="reveal-detail-password"]').click();
  await page.locator('#detail [data-testid="show-totp"]').click(); await page.locator('[data-testid="totp-code"]').waitFor();
  await page.locator("#lock").click(); await page.locator("#unlock:not([disabled])").waitFor();
  assert.equal(await page.locator("#detail").textContent(), "");
  assert.equal(await page.locator('[data-testid="totp-code"]').count(), 0);
  assert.equal(await page.locator("#entry-password").inputValue(), "");
  assert(!((await page.locator("body").textContent())!).includes("Synthetic-login-secret"));
  check("design: lock removes selected detail, revealed password and TOTP");
  await page.locator("#master").fill(master); await page.locator("#unlock").click(); await page.locator("#workspace:not([hidden])").waitFor();
}

async function healthChecks(page: Page, master: string, check: (name: string, pass?: boolean) => void) {
  const titles = ["Health duplicate one", "Health duplicate two", "Health empty one", "Health empty two"];
  for (let index = 0; index < titles.length; index++) {
    await page.locator("#new-entry").click(); await page.locator("#entry-title").fill(titles[index]);
    await page.locator("#entry-password").fill(index < 2 ? "short-dup" : ""); await page.locator("#save-entry").click();
    await page.locator("#editor").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("#workspace")!.getAttribute("aria-busy") === "false");
  }
  async function health(short: number, reused: number, affected: number) {
    const requests: string[] = []; const observe = (request: { url(): string }) => requests.push(request.url());
    page.on("request", observe); await page.locator("#nav-health").click();
    await page.locator("#health-view").waitFor({ state: "visible" }); page.off("request", observe);
    assert.deepEqual(requests, [], "local health view needs no network request");
    assert.deepEqual(await page.locator("#health-summary strong").allTextContents(), [String(short), String(reused)]);
    assert.equal(await page.locator("#health-count").textContent(), String(affected));
    assert.equal(await page.locator('[data-testid="health-finding"]').count(), affected);
    assert(!((await page.locator("#health-view").textContent())!).includes("short-dup"), "health findings never reveal passwords");
  }
  await health(4, 2, 4);
  check("design: local health computes 4 short/empty entries, 2 reused nonempty passwords and 4 distinct findings without network");
  const finding = page.locator('[data-testid="health-finding"]').filter({ hasText: titles[0] });
  const entryId = await finding.getAttribute("data-entry-id");
  await finding.locator('[data-testid="health-open-entry"]').click();
  assert.equal(await page.locator('[data-testid="detail-title"]').textContent(), titles[0]);
  assert.equal(await page.locator('[data-testid="select-entry"][aria-current="true"]').evaluate(el => el.parentElement!.dataset.entryId), entryId);
  await page.locator('[data-testid="edit-entry"]').click();
  await page.locator("#entry-password").fill("UniqueLongSyntheticPassword-14"); await page.locator("#save-entry").click();
  await page.locator("#editor").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#health-count").textContent(), "3"); await health(3, 0, 3);
  assert.equal(await page.locator('[data-testid="health-finding"]').filter({ hasText: titles[0] }).count(), 0);
  check("design: health opens the affected real entry and recomputes counts after encrypted password mutation");
  await page.screenshot({ path: "docs/evidence/password-manager/design-health.png", fullPage: true });
  await page.locator("#lock").click(); await page.locator("#unlock:not([disabled])").waitFor();
  assert.equal(await page.locator("#health-summary").textContent(), "");
  assert.equal(await page.locator("#health-findings").textContent(), "");
  assert.equal(await page.locator("#health-count").textContent(), "0"); assert(await page.locator("#health-view").isHidden());
  check("design: lock clears health findings, names, summary and counter");
  await page.locator("#master").fill(master); await page.locator("#unlock").click();
  await page.locator("#workspace:not([hidden])").waitFor(); await health(3, 0, 3);
  await page.locator("#close-health").click();
  for (const title of titles) {
    await page.locator('[data-testid="select-entry"]').filter({ hasText: title }).click();
    await page.locator('[data-testid="delete-entry"]').click(); await page.locator("#delete-confirm").click();
    await page.locator("#delete-dialog").waitFor({ state: "hidden" });
  }
  await health(0, 0, 0); await page.locator("#close-health").click();
  assert.equal(await page.locator("#entries > li").count(), 1);
  check("design: removing health fixtures restores the original encrypted vault and clears all findings");
}

if (import.meta.main) {
  const acceptance = Bun.spawn([process.execPath, "scripts/password_manager_e2e.mjs"], {
    env: { ...process.env, HEAVENKEY_PM_DESIGN: "1" }, stdout: "inherit", stderr: "inherit",
  });
  process.exitCode = await acceptance.exited;
}
