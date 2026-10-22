import { test, expect } from "bun:test";
import { Window } from "happy-dom";
import { previewFileZilla, exportFileZilla } from "./import";
import { validateTransferProfile, validateTransfers, validateTransferPath, type TransferProfile } from "./schema";
const win = new Window(); Object.assign(globalThis, { DOMParser: win.DOMParser });
export const profile: TransferProfile = { id: "00000000-0000-4000-8000-000000000001", label: "Synthetic", provider: "custom", protocol: "sftp", host: "fixture.invalid", port: 22, username: "synthetic-user", root: "/", host_key: "SHA256:" + "a".repeat(43), password: "synthetic-secret", private_key: "", public_key: "" };
const xml = (code = "1") => '<FileZilla3><Servers><Server><Host>fixture.invalid</Host><Port>22</Port><Protocol>' + code + '</Protocol><User>synthetic-user</User><Pass encoding="base64">c3ludGhldGljLXNlY3JldA==</Pass><Keyfile>/private/key</Keyfile><Name>Fixture</Name><RemoteDir>1 0 7 uploads</RemoteDir></Server></Servers></FileZilla3>';
test("FileZilla preview retains server metadata and discards passwords and keyfiles", () => {
  const rows = previewFileZilla(xml()); expect(rows).toHaveLength(1); expect(rows[0].protocol).toBe("sftp"); expect(rows[0].root).toBe("/");
  expect(JSON.stringify(rows)).not.toContain("c3ludGhldGlj"); expect(JSON.stringify(rows)).not.toContain("/private/key"); expect(rows[0].warnings).toHaveLength(3);
  expect(previewFileZilla(xml("4"))[0].protocol).toBe("ftpes");
});
test("import fails atomically on insecure protocol, DTD, oversized data or malformed XML", () => {
  for (const source of [xml("0"), xml("3"), xml().replace("<FileZilla3>", '<!DOCTYPE x [<!ENTITY evil "x">]><FileZilla3>'), "x".repeat(1_000_001), "<invalid>"]) expect(() => previewFileZilla(source)).toThrow();
});
test("FileZilla export has no credentials or private keys, and escapes untrusted labels", () => {
  const result = exportFileZilla([{ ...profile, label: '<img src="x">&' }]);
  expect(result).toContain("<Logontype>2</Logontype>");
  expect(result).not.toContain(profile.password); expect(result).not.toContain(profile.username); expect(result).not.toContain("<User>"); expect(result).not.toContain("<Pass"); expect(result).not.toContain("<Keyfile>"); expect(result).toContain("&lt;img");
  expect(previewFileZilla(result)[0].username).toBe("");
});
test("transfer schema denies unknown fields, duplicates, invalid auth combinations and paths", () => {
  expect(validateTransferProfile(profile)).toEqual(profile); expect(validateTransfers([profile])).toHaveLength(1);
  for (const bad of [{ ...profile, evil: true }, { ...profile, protocol: "ftp" }, { ...profile, host: "https://fixture.invalid" }, { ...profile, root: "/../secret" }, { ...profile, password: "" }, { ...profile, host_key: "" }, { ...profile, protocol: "ftpes" }, { ...profile, port: 0 }]) expect(() => validateTransferProfile(bad)).toThrow();
  expect(() => validateTransfers([profile, profile])).toThrow();
  for (const path of ["../x", "/x", "a/../b", "a\\b", "a\0b", "a//b"]) expect(() => validateTransferPath(path, "get")).toThrow();
  expect(() => validateTransferPath("", "get")).toThrow(); expect(() => validateTransferPath("", "list")).not.toThrow();
});

const syntheticCA = "-----BEGIN CERTIFICATE-----\nMIIBPzCB8qADAgECAhRPEQxpKagnJOD5Tf/fRYP1tAekgDAFBgMrZXAwJjEkMCIG\nA1UEAwwbSGVhdmVuS2V5IFN5bnRoZXRpYyBDQSBUZXN0MB4XDTI2MTAyMjEzMTQx\nMloXDTI2MTAyMzEzMTQxMlowJjEkMCIGA1UEAwwbSGVhdmVuS2V5IFN5bnRoZXRp\nYyBDQSBUZXN0MCowBQYDK2VwAyEA8hI0zcL3AVTaqim7cLLO1DzpGTr8LNZ0cFOb\nVVZHBDCjMjAwMB0GA1UdDgQWBBR9IiGDLFycl0IIRWt0rH6baQ4yUzAPBgNVHRMB\nAf8EBTADAQH/MAUGAytlcANBACIlLdMwaM1WSr6r+7GG2R7ZyKtNEznazY7vpMEM\nxgk6UTr3vixY4xjVEZ8D3jib1x7wVfb4mTRrgw3v4XVJyA8=\n-----END CERTIFICATE-----\n";
test("optional CA remains backward-compatible, accepts public PEM only for FTPES and never exports it", () => {
  const ftpes = { ...profile, protocol: "ftpes" as const, host_key: "" };
  expect(validateTransferProfile(ftpes).ca_certificate).toBeUndefined();
  expect(validateTransferProfile({ ...ftpes, ca_certificate: "" }).ca_certificate).toBe("");
  expect(validateTransferProfile({ ...ftpes, ca_certificate: syntheticCA }).ca_certificate).toBe(syntheticCA);
  for (const ca_certificate of ["garbage", syntheticCA + "garbage", "garbage" + syntheticCA, syntheticCA.replaceAll("CERTIFICATE", "PRIVATE KEY"), "-----BEGIN CERTIFICATE-----\nZ2FyYmFnZQ==\n-----END CERTIFICATE-----\n", "x".repeat(16385)]) expect(() => validateTransferProfile({ ...ftpes, ca_certificate })).toThrow();
  expect(() => validateTransferProfile({ ...profile, ca_certificate: syntheticCA })).toThrow();
  expect(() => validateTransferProfile({ ...profile, ca_certificate: "" })).toThrow();
  expect(exportFileZilla([{ ...ftpes, ca_certificate: syntheticCA }])).not.toContain("CERTIFICATE");
});
