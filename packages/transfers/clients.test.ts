import { describe, expect, test } from "bun:test";
import { clients, providers } from "./catalog";
import { exportClientProfile } from "./clients";
import type { TransferProfile } from "./schema";
const profile: TransferProfile = {id:"00000000-0000-4000-8000-000000000001",label:"Test",provider:"netcup",protocol:"sftp",host:"files.example.com",port:22,username:"deploy",root:"/",host_key:"SHA256:"+"A".repeat(43),password:"synthetic-password-must-not-export",private_key:"",public_key:""};
describe("transfer client handoffs", () => {
  test("ten clients and ten source-linked providers including netcup", () => {
    expect(clients).toHaveLength(10); expect(providers).toHaveLength(10);
    expect(new Set(clients.map(c=>c.id)).size).toBe(10);
    expect(new Set(providers.map(c=>c.id)).size).toBe(10);
    expect(providers.some(p=>p.id==="netcup")).toBe(true);
    for (const c of [...clients,...providers]) expect(new URL(c.docs).protocol).toBe("https:");
  });
  test("all ten handoffs exclude credential fields and password", () => {
    for (const c of clients) {
      const out=exportClientProfile(c.id,profile);
      expect(out.content).not.toContain(profile.password);
      expect(out.content).not.toContain("PRIVATE KEY");
      expect(out.filename).not.toMatch(/[\\/]/);
      expect(out.notice).toContain("außerhalb");
    }
  });
  test("unsupported protocol fails rather than downgrades", () => {
    expect(()=>exportClientProfile("openssh",{...profile,protocol:"ftpes",port:21,host_key:""})).toThrow();
    expect(()=>exportClientProfile("unknown",profile)).toThrow();
  });
  test("TLS and host verification remain enabled", () => {
    expect(exportClientProfile("openssh",profile).content).toContain("StrictHostKeyChecking yes");
    expect(exportClientProfile("rclone",profile).content).toContain("known_hosts_file");
    const ftpes={...profile,protocol:"ftpes" as const,port:21,host_key:""};
    expect(exportClientProfile("rclone",ftpes).content).toContain("explicit_tls = true");
    expect(exportClientProfile("lftp",ftpes).content).toContain("set ftp:ssl-force yes");
    expect(exportClientProfile("lftp",ftpes).content).toContain("set ftp:ssl-protect-data yes");
  });
  test("lftp export rejects executable interpolation", () => {
    expect(()=>exportClientProfile("lftp",{...profile,root:"/$(touch /tmp/no)"})).toThrow();
    expect(()=>exportClientProfile("lftp",{...profile,username:"user`command`"})).toThrow();
  });
});
