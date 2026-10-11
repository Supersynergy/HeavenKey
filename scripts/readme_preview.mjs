import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

const html = await readFile("docs/evidence/readme-rendered.html", "utf8");
const square = await readFile("docs/assets/heavenkey-hero-square.png");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"),
  headless: true,
});
const results = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  await page.setContent(`<style>body{margin:0;padding:24px;background:#f6f8fa;font:16px/1.55 system-ui;color:#1f2328}article{max-width:880px;margin:auto;padding:32px;background:white;border:1px solid #d1d9e0;border-radius:8px}img{max-width:100%;height:auto}h1{font-size:36px}a{color:#0969da}pre{overflow:auto}table{display:block;overflow:auto}</style><article>${html}</article>`);
  const hero = page.locator('img[alt="HeavenKey: ein schwebender Schlüssel vor dem Himmelstor"]');
  await hero.evaluate((node, data) => { node.src = data; }, `data:image/png;base64,${square.toString("base64")}`);
  await hero.evaluate(node => node.decode());
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const image = await hero.boundingBox();
    const article = await page.locator("article").boundingBox();
    assert.ok(image && article);
    assert.ok(Math.abs(image.width-image.height)<1, "image must remain square");
    assert.ok(Math.abs((image.x+image.width/2)-(article.x+article.width/2))<1, "image must be centered");
    assert.ok(image.x>=0 && image.x+image.width<=width, "image must fit viewport");
    results.push({ viewport_width:width, width:image.width, height:image.height, centered:true });
    await page.screenshot({ path:`docs/evidence/readme-square-${width}.png` });
  }
  await writeFile("docs/evidence/readme-square.json", JSON.stringify({ renderer:"GitHub GFM HTML with representative local stylesheet; not live GitHub UI", passed:true, cases:results }, null, 2)+"\n");
  console.log(JSON.stringify({ passed:true, cases:results }));
} finally {
  await browser.close();
}
