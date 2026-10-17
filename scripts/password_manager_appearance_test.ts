import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export async function appearanceChecks(page: Page, master: string, check: (name: string) => void) {
  const original = await page.locator("html").getAttribute("data-theme");
  async function inspect(scope: string, theme?: string) {
    const result = await page.evaluate(({scope, theme}) => {
      if (theme && document.documentElement.dataset.theme !== theme) document.querySelector<HTMLButtonElement>("#theme-toggle")!.click();
      const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
      const background = (element: Element): number[] => {
        const color = rgb(getComputedStyle(element).backgroundColor);
        return color.length < 4 || color[3] > 0 ? color : element.parentElement ? background(element.parentElement) : [255, 255, 255];
      };
      const luminance = (color: number[]) => color.slice(0, 3).reduce((sum, value, index) => {
        const channel = value / 255;
        return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
      }, 0);
      const ratio = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
      const rows: { label: string; ratio: number }[] = [];
      const walker = document.createTreeWalker(document.querySelector(scope)!, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, element = node.parentElement!;
        if (!node.textContent?.trim() || !element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"], :disabled')) continue;
        rows.push({ label: node.textContent.trim().slice(0, 70), ratio: ratio(rgb(getComputedStyle(element).color), background(element)) });
      }
      const controls = [...document.querySelectorAll<HTMLElement>(`${scope} input, ${scope} select, ${scope} textarea, ${scope} kbd, ${scope} button.secondary`)].filter(el => el.getClientRects().length && !el.closest(':disabled, [hidden]'));
      for (const input of controls.filter(el => el.matches('input[placeholder], textarea[placeholder]'))) {
        rows.push({ label: `${input.id} placeholder`, ratio: ratio(rgb(getComputedStyle(input, "::placeholder").color), background(input)) });
      }
      const boundaries = controls.filter(el => el.matches(':not([type=checkbox])') && parseFloat(getComputedStyle(el).borderTopWidth) > 0 && rgb(getComputedStyle(el).borderTopColor)[3] !== 0).map(el => ({label: el.id || el.tagName, ratio: ratio(rgb(getComputedStyle(el).borderTopColor), background(el))}));
      return { samples: rows.length, failures: rows.filter(row => row.ratio < 4.5), boundaries: boundaries.filter(row => row.ratio < 3) };
    }, {scope, theme});
    assert(result.samples > 3, "contrast checks must inspect rendered text");
    assert.deepEqual(result.failures, [], `${scope} ${theme || ""}: text contrast must be at least 4.5:1`);
    assert.deepEqual(result.boundaries, [], `${scope}: control boundaries must be at least 3:1`);
  }
  for (const theme of ["light", "dark"]) {
    await inspect("#workspace", theme);
    await page.keyboard.press("F2"); await page.locator("#quick-access[open]").waitFor(); await inspect("#quick-access");
    await page.keyboard.press("Escape");
    await page.locator("#nav-settings").click(); await inspect("#settings-view");
    await page.locator("#new-profile").click(); await inspect("#profile-editor");
    await page.keyboard.press("Escape"); await page.locator("#close-settings").click();
  }
  check("design: both themes retain 4.5:1 visible vault text contrast immediately on switching");
  check("design: quick access, settings and profile editor have readable text and distinct controls in both themes");
  await page.locator("#lock").click(); await page.locator("#unlock:not([disabled])").waitFor();
  await page.locator(".gate-art").evaluate((image: HTMLImageElement) => image.decode());
  assert.equal(await page.locator(".gate-art").evaluate((image: HTMLImageElement) => image.naturalWidth), 1254);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator("#gate-theme-toggle").focus(); await page.keyboard.press("Space");
    await inspect("#gate");
    assert.equal(await page.locator("#gate-theme-toggle").evaluate(el => el === document.activeElement), true);
  }
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `locked screen fits ${width}px`);
    assert(await page.locator("#master").isVisible());
  }
  await page.evaluate(() => document.documentElement.style.zoom = "2");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "locked screen fits 200% CSS zoom");
  await page.evaluate(() => document.documentElement.style.zoom = "");
  check("design: original embedded cover, keyboard theme toggle and locked recovery layout work through 320px and 200% CSS zoom");
  await page.locator("#master").fill(master); await page.locator("#unlock").click(); await page.locator("#workspace:not([hidden])").waitFor();
  if (await page.locator("html").getAttribute("data-theme") !== original) await page.locator("#theme-toggle").click();
}
