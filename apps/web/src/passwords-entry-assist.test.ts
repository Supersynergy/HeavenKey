import { describe, expect, test } from "bun:test";
import { normalizeWebsite, suggestedUsernames } from "./passwords-entry-assist";

describe("first-login suggestions", () => {
  test("accepts a pasted website and preserves exact host, port and path", () => {
    expect(normalizeWebsite(" example.com:8443/login ")).toEqual({ url: "https://example.com:8443/login", title: "example.com" });
    expect(normalizeWebsite("https://accounts.example.com/login?q=1")?.url).toBe("https://accounts.example.com/login?q=1");
    expect(normalizeWebsite("http://localhost:8080/login")?.url).toBe("http://localhost:8080/login");
    expect(normalizeWebsite("")).toEqual({ url: "", title: "" });
  });
  test("never converts unsafe schemes or embedded credentials into suggestions", () => {
    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com", "just words", "example", "//example.com", "https://"]) expect(normalizeWebsite(value)).toBeNull();
  });
  test("offers only bounded local usernames, without copying other entry fields", () => {
    expect(suggestedUsernames([{ username: "alice" }, { username: "" }, { username: "alice" }, { username: "bob" }])).toEqual(["alice", "bob"]);
    expect(suggestedUsernames(Array.from({ length: 10 }, (_, n) => ({ username: String(n) })))).toHaveLength(5);
  });
});
