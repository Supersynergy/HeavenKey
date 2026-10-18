import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, ".."), args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
 assert(["--binary", "--platform", "--sha256", "--report"].includes(args[i]) && args[i + 1] && !options.has(args[i]), "Usage: bun scripts/build_agent_sandbox.ts --binary PATH --platform linux/arm64|linux/amd64 [--sha256 HEX] [--report PATH]");
 options.set(args[i], args[i + 1]);
}
assert(options.has("--binary") && options.has("--platform"), "--binary and --platform are required");
const binary = resolve(options.get("--binary")!), platform = options.get("--platform")!;
assert(["linux/arm64", "linux/amd64"].includes(platform), "Unsupported Linux architecture");
const report = resolve(options.get("--report") || "docs/evidence/password-broker/sandbox-image.json");
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
async function command(args: string[], timeout = 10000) {
 const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
 const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
 async function bounded(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { child.kill("SIGKILL"); throw Error("Build command output exceeded bound"); } chunks.push(value); }
  return Buffer.concat(chunks).toString();
 }
 try { const [out, err, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]); assert.equal(code, 0, "Command failed: " + args[0] + " " + args[1] + ": " + err.slice(-4000)); return out; }
 finally { clearTimeout(timer); }
}
const input = await readFile(binary), binaryHash = sha(input), metadata = await stat(binary);
assert(metadata.isFile() && (metadata.mode & 0o111), "Binary must be a regular executable");
assert.equal(input.subarray(0, 4).toString("hex"), "7f454c46", "A portable Linux ELF executable is required");
assert.equal(input[4], 2, "64-bit ELF required"); assert.equal(input[5], 1, "Little endian ELF required");
assert.equal(input.readUInt16LE(18), platform === "linux/arm64" ? 183 : 62, "ELF architecture differs from requested platform");
const phoff = Number(input.readBigUInt64LE(32)), phsize = input.readUInt16LE(54), phcount = input.readUInt16LE(56);
assert(phsize >= 56 && phcount > 0 && phoff + phcount * phsize <= input.length, "Malformed ELF program headers");
for (let i = 0; i < phcount; i++) assert.notEqual(input.readUInt32LE(phoff + i * phsize), 3, "Binary has an interpreter: supply the portable static Linux build");
if (options.has("--sha256")) assert.equal(binaryHash, options.get("--sha256"), "Binary provenance hash mismatch");
const cargo = await readFile(join(root, "Cargo.toml"), "utf8"), version = /^version\s*=\s*"([^\"]+)"/m.exec(cargo)?.[1];
assert(version, "Workspace source version is missing");
const base = JSON.parse(await command(["docker", "image", "inspect", "python:3.13-alpine"]))[0];
assert.equal(base.Os + "/" + base.Architecture, platform, "Cached Python image architecture differs; downloading is disabled");
const baseDigest = base.RepoDigests?.find((value: string) => /^python@sha256:[a-f0-9]{64}$/.test(value));
assert(baseDigest, "Existing official Python repository digest required; tags alone are insufficient");
const pinned = JSON.parse(await command(["docker", "image", "inspect", baseDigest]))[0]; assert.equal(pinned.Id, base.Id);
const dockerfile = await readFile(join(root, "scripts/sandbox/Dockerfile"));
const context = await mkdtemp(join(tmpdir(), "heavenkey-sandbox-image-"));
try {
 await writeFile(join(context, "Dockerfile"), dockerfile); await copyFile(binary, join(context, "heavenkey")); await chmod(join(context, "heavenkey"), 0o555);
 assert.equal(sha(await readFile(join(context, "heavenkey"))), binaryHash);
 const output = await command(["docker", "build", "--network=none", "--pull=false", "--platform", platform, "--build-arg", "BASE_IMAGE=" + baseDigest, "--iidfile", join(context, "image-id"), context], 120000);
 const image = (await readFile(join(context, "image-id"), "utf8")).trim(); assert.match(image, /^sha256:[a-f0-9]{64}$/);
 const built = JSON.parse(await command(["docker", "image", "inspect", image]))[0]; assert.equal(built.Os + "/" + built.Architecture, platform);
 assert.equal(built.Config.User, "65532:65532"); assert(!built.Config.Volumes && !built.Config.OnBuild?.length);
 assert.deepEqual(built.Config.Env.slice().sort(), ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"].sort(), "Image must not inherit Python signing/environment metadata");
 const probeId = (await command(["docker", "create", "--pull=never", "--user=65532:65532", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none", "--ipc=private", "--read-only", "--pids-limit=32", "--memory=128m", "--cpus=1", "--ulimit=core=0", "--ulimit=nofile=64:64", "--entrypoint=python3", image, "-c", "import subprocess,hashlib,json,platform; version=subprocess.run(['/usr/local/bin/heavenkey','--version'],check=True,capture_output=True,text=True,timeout=3).stdout.strip(); print(json.dumps({'version':version,'sha256':hashlib.sha256(open('/usr/local/bin/heavenkey','rb').read()).hexdigest(),'machine':platform.machine(),'python':platform.python_version(),'kernel':platform.release()}))"])).trim();
 assert.match(probeId, /^[a-f0-9]{64}$/); let probe: any;
 try { probe = JSON.parse(await command(["docker", "start", "-a", probeId])); }
 finally { await command(["docker", "rm", "-f", probeId]); }
 assert.equal(probe.sha256, binaryHash, "Image binary differs from supplied executable"); assert.equal(probe.version, "HeavenKey " + version, "Executable version differs from workspace source");
 assert.equal(probe.machine, platform === "linux/arm64" ? "aarch64" : "x86_64"); assert.match(probe.python, /^3\.13\./);
 assert.equal(sha(await readFile(binary)), binaryHash, "Input changed during image build");
 const receipt = { pass: true, image, platform, base_image: baseDigest, base_image_id: base.Id, binary, binary_sha256: binaryHash, elf_static: true, workspace_source_version: version, binary_version_runtime_verified: true, image_binary_runtime_verified: true, probe, expected_hash_supplied: options.has("--sha256"), dockerfile_sha256: sha(dockerfile), builder_sha256: sha(await readFile(import.meta.path)), context_files: ["Dockerfile", "heavenkey"], network: "none", pull: false, output_tail: output.slice(-2000) };
 await mkdir(dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify({ image, report, binary_sha256: binaryHash, platform }));
} finally { await rm(context, { recursive: true, force: true }); }
