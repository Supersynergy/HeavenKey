import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
const window = new Window({ url: "https://synthetic-extension.invalid", settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
window.document.write((await readFile("apps/extension/popup.html", "utf8")).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""));
const opened: string[] = [];
const globals = {
  document: window.document,
  localStorage: window.localStorage,
  chrome: { tabs: { create: async ({ url }: { url: string }) => { opened.push(url); } } },
};
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeAll(async () => {
  for (const [key, value] of Object.entries(globals)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  window.localStorage.setItem("heavenkey.connection.v1", JSON.stringify({ mode: "https", endpoint: "https://example.test/?session=bad", destination: "keys" }));
  await import("./popup.js");
});
const element = (id: string) => window.document.getElementById(id)!;
afterAll(async () => {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.abort();
});
async function submit() { element("open-form").dispatchEvent(new window.Event("submit", { cancelable: true })); await new Promise(resolve => setTimeout(resolve, 5)); }
test("popup discards unsafe saved settings, opens the exact destination and stores no session", async () => {
  expect(window.localStorage.length).toBe(0);
  (element("port") as unknown as HTMLInputElement).value = "18245";
  (element("destination") as unknown as HTMLSelectElement).value = "recovery";
  await submit(); expect(opened).toEqual(["http://localhost:18245/#recovery"]);
  const saved = JSON.parse(window.localStorage.getItem("heavenkey.connection.v1")!);
  expect(Object.keys(saved).sort()).toEqual(["destination", "endpoint", "mode", "port"]);
  (element("mode") as unknown as HTMLSelectElement).value = "https"; element("mode").dispatchEvent(new window.Event("change"));
  (element("endpoint") as unknown as HTMLInputElement).value = "https://heaven.example.test/?secret=blocked";
  await submit(); expect(opened.length).toBe(1);
  (element("endpoint") as unknown as HTMLInputElement).value = "https://heaven.example.test";
  await submit(); expect(opened[1]).toBe("https://heaven.example.test/#recovery");
});
