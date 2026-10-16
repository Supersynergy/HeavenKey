import assert from "node:assert/strict";
import { target, destinations } from "../apps/extension/settings.js";
for (const destination of destinations) {
  const url = target({ mode: "local", port: "18240", destination });
  assert.equal(new URL(url).origin, "http://localhost:18240");
  assert.equal(new URL(url).search, "");
}
for (const port of ["0", "65536", "-1", "1.5", "NaN", "18240/evil", "1e3", " 80"]) assert.throws(() => target({ mode: "local", port, destination: "overview" }));
for (const endpoint of ["http://example.test", "javascript:alert(1)", "https://user:password@example.test", "https://example.test/path", "https://example.test/?session=secret", "https://example.test/#secret"]) assert.throws(() => target({ mode: "https", endpoint, destination: "keys" }));
assert.equal(target({ mode: "https", endpoint: "https://heaven.example.test", destination: "keys" }), "https://heaven.example.test/#keys");
assert.throws(() => target({ mode: "local", port: "18240", destination: "//evil.test" }));
console.log("Extension connection and destination validation passed.");
