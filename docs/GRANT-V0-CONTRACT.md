# Grant-v0 conformance contract

`heavenkey-grant-v0` describes the legacy wire profile implemented by
`crates/verifier/src/lib.rs`. Conformance is proven against
`docs/vectors/grant-v0.json`: the Rust test
`crates/verifier/tests/grant_v0.rs` replays every case and independently
`scripts/grant-reference.mjs` (wired into `scripts/ci.sh`) re-encodes all
material with its own encoder and Node crypto.

## Signed message

- Grant signature input: `b"UAC-AUDIT-GRANT-v0\0" || serde_json::to_vec(body)`
- Invocation signature input: `b"UAC-AUDIT-INVOKE-v0\0" || serde_json::to_vec(body)`
- `grant_id(signed) = SHA-256(b"UAC-AUDIT-GRANT-v0\0" || serde_json::to_vec(signed))`

Canonical `serde_json` bytes: struct fields in declaration order
(`Grant`: `issuer`, `audience`, `resource`, `actions`, `not_before`,
`expires_at`, `remaining_delegations`, `parent`; `Invocation`: `grant`,
`resource`, `action`, `arguments_hash`, `nonce`, `issued_at`; envelope:
`body`, `signature`), compact separators, byte arrays as integer arrays,
`Option` as `null`/value, `BTreeSet<Action>` sorted by enum order
`Read` < `Write` < `Unlock` (declaration order, not alphabetical).
Parsing is order-insensitive: reordered fields or arbitrary whitespace
decode to the same `message`/`id`; duplicate fields, unknown fields
(`deny_unknown_fields`) and wrong types reject.

## Limits and decision order

`MAX_CHAIN = 8`, `MAX_GRANT_BYTES = 4096` (per serialized grant),
invocation freshness `now - issued_at < 30` seconds. `Verifier::verify`
evaluates: chain length → `ClockRollback` (per-process `last_time`) →
per-link `Limits` → `Signature` → `Escalation` (empty actions, resource
mismatch) → `Time` → `Revoked` → `Chain`/`UntrustedRoot`/`Escalation`
(attenuation: issuer binding, parent id, action subset, monotone time
window, strictly decreasing `remaining_delegations` with parent > 0) →
invocation `Signature` → `Invocation` (grant id, resource, action,
arguments hash, nonce, leaf rights) → `Time` → `Replay` (per-process
nonce set). `authorize_passkey_grant` uses the single-grant order
`Limits` → `Signature` → `UntrustedRoot` → `Revoked` → `Invocation` →
`Time`.

## Vector file

`fixtures[]`: `{name, grant, signature_valid, message_hex, id_hex}` —
real Ed25519 signatures over deterministic keys (`SigningKey::from_bytes([n;32])`,
root `[1;32]`). `invocations[]` the same for `Signed<Invocation>`.
`cases[]`: `{name, chain, invocation, context, revoked, steps[]}` where
`steps` replay one verifier in order (`now`, `expect` = `"ok"` or an
`Error` variant, covering `ClockRollback`/`Replay`). `grant_cases[]`
exercise `authorize_passkey_grant`. `invalid_json[]` raw texts that must
reject; `equivalent_json[]` texts that must decode to the documented id.

Regenerate deterministically with
`HEAVENKEY_GRANT_V0_REGEN=1 cargo test -p uac-verifier --test grant_v0`.
