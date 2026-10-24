# HeavenKey mobile platform contract

Flutter owns the interface; native code owns encrypted storage, device authentication,
clipboard expiry and browser credential delivery. No network, analytics, account,
custom cryptography, plaintext export or automatic desktop vault conversion.
The existing Argon2id desktop vault remains unchanged.

Channel: `heavenkey/vault`. All errors use a safe code/message without secret values.

| Method | Input | Result |
|---|---|---|
| `status` | none | `{available: bool, secureDevice: bool, autofillEnabled: bool, platform: string}` |
| `unlock` | none | Device authentication, then a list of entry maps. Empty list for a new vault. Cancellation is an error. |
| `save` | entry map | Save atomically; return null. Requires an authenticated session. |
| `delete` | `{id: string}` | Delete atomically; return null. Requires an authenticated session. |
| `lock` | none | Discard native session and clear owned clipboard; return null. |
| `copyPassword` | `{id: string}` | Copy from authenticated native vault, mark sensitive and expire within 30 seconds; return null. |
| `enableAutofill` | none | Open the system provider settings; return null. |

Entries contain string fields `id`, `title`, `origin`, `username`, `password`,
`notes`, `updatedAt` (UTC ISO8601). Bounds: 500 entries, id 80, title 120,
origin 2048, username 320, password 1024, notes 4096 characters.
IDs match `[A-Za-z0-9_-]{1,80}`. Title and password are required.
The origin is a canonical HTTPS origin: ASCII DNS host, no userinfo, path except
`/`, query or fragment; explicit non-default ports remain distinct.
Reject empty labels, trailing dots, IP addresses, localhost and Unicode hosts.
Native stored payloads are capped at 16 MiB. Oversized edits fail before replacing
the previous data and preserve the authenticated editor for correction.
Use exact scheme/host/port equality; never suffix-match or upgrade HTTP.
All native writes validate again; reject corrupt storage, never silently reset it.

Authenticate at every unlock. Lock on background and no later than 60 seconds after unlock;
operations after native expiry fail closed. Do not display credentials in task
switcher snapshots. No plaintext files, preferences, logs, notifications or caches.
Authentication callbacks must never restore a session after lock/background.

Android: API 30+, Keystore AES-GCM with required strong biometric/device credential
authentication, `noBackupFilesDir` and atomic writes. No accessibility service.
Autofill exposes an authentication challenge, then an explicit credential choice
for the exact HTTPS site. Treat web-domain hints as untrusted; support the
user-selected system default browser only and reject other packages. Refuse
ambiguous origins, HTTP, cross-origin frames or unknown field layouts.

iOS: shared Keychain access group for app and Credential Provider extension;
`whenPasscodeSetThisDeviceOnly` plus user presence, no iCloud synchronization.
Extension prompts for device authentication and credential selection. A domain
identifier can select default-port HTTPS entries for that exact host only;
URL identifiers require exact origin equality. Bind identities to entry IDs.
Add the actual Xcode extension target, embed phase and matching entitlements.

Native compilation, signed installation and actual browser flows are separate
acceptance from Dart tests or source inspection. No platform acceptance claim
without executed evidence for its source revision.
