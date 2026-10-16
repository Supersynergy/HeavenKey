/** Local machine identity example. Never imports or drives a person's passkey. */
import { generateKeyPairSync, createPrivateKey, createHash, sign, timingSafeEqual } from "node:crypto";
import { writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const args = process.argv.slice(2);
let origin = "http://localhost:18240";
const flag = args.indexOf("--origin");
if (flag !== -1) { origin = args[flag + 1]; args.splice(flag, 2); }
const [command, file, task, ...extra] = args;
if (command === "keygen" && file) {
  const keys = generateKeyPairSync("ed25519"); const path = resolve(file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, keys.privateKey.export({ format: "pem", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  console.log(JSON.stringify({ private_key_file: path, public_key: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") }, null, 2));
} else if (["read", "note"].includes(command) && file && task) {
  const parsed = new URL(origin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || !(parsed.protocol === "https:" || parsed.protocol === "http:" && parsed.hostname === "localhost")) throw new Error("Use a configured HTTPS origin or localhost.");
  origin = parsed.origin;
  const payload = { id: task, resource: command === "note" ? "crm.contacts" : (extra[0] || "crm.contacts"), action: command === "note" ? "Write" : "Read", arguments: command === "note" ? { id: "demo-contact", note: extra.join(" ") } : {} };
  const post = async (path, body) => {
    const response = await fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
  };
  const challenge = await post("/api/agents/challenge", payload);
  const message = Buffer.from(challenge.message, "base64url"), prefix = Buffer.from("HEAVENKEY-AGENT-INVOKE-v1\0");
  const expected = createHash("sha256").update(JSON.stringify(payload)).digest();
  if (message.length !== prefix.length + 96 || !timingSafeEqual(message.subarray(prefix.length, prefix.length + 32), createHash("sha256").update(origin).digest()) || !message.subarray(0, prefix.length).equals(prefix) || !timingSafeEqual(message.subarray(-32), expected)) throw new Error("Server challenge does not match the requested operation.");
  const privateKey = createPrivateKey(await readFile(resolve(file)));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 agent key is required.");
  const result = await post("/api/agents/invoke", { challenge_id: challenge.challenge_id, signature: sign(null, message, privateKey).toString("base64url") });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("node scripts/agent.mjs keygen /private/path/agent.pem\nnode scripts/agent.mjs read /private/path/agent.pem TASK_ID [document|crm.contacts] [--origin https://your-service]\nnode scripts/agent.mjs note /private/path/agent.pem TASK_ID New contact note [--origin https://your-service]");
  process.exitCode = command ? 1 : 0;
}
