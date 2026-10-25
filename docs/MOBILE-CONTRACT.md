# HeavenKey mobile platform contract

Flutter owns the interface; native code owns encrypted storage, device authentication,
clipboard expiry and browser credential delivery. Android additionally supports
explicitly paired, certificate-pinned TLS synchronization of end-to-end encrypted
snapshots and Website Passkeys through the system Credential Provider API (34+).
There is no analytics, cloud account, custom signing primitive or plaintext export.
The desktop vault keeps its Argon2id encryption; its encrypted payload also contains
paired-device keys, merge baselines and synchronized website-passkey records.
Portable backups contain ciphertext only and use a separately retained random key.
The current mobile backup format contains logins. Website passkeys can be recovered
through the synchronized desktop vault and its encrypted desktop backup.

Channel: `heavenkey/vault`. All errors use a safe code/message without secret values.

| Method | Input | Result |
|---|---|---|
| `status` | none | `{available, secureDevice, autofillEnabled, platform}`; Android also reports `browserTrusted` and `windowFocused`. |
| `unlock` | none | Device authentication, then a list of entry maps. Empty list for a new vault. Cancellation is an error. |
| `save` | entry map | Save atomically; return null. Requires an authenticated session. |
| `delete` | `{id: string}` | Delete atomically; return null. Requires an authenticated session. |
| `lock` | none | Discard native session and clear owned clipboard; return null. |
| `copyPassword` | `{id: string}` | Copy from authenticated native vault, mark sensitive and schedule expiry after 30 seconds; clear owned data when leaving; return null. |
| `enableAutofill` | none | Open the system provider settings; return null. |
| `configureBrowser` | none | Android: open the pinned default browser’s Autofill settings; report unsupported settings instead of guessing a private activity. |
| `newBackupKey` | none | Authenticated session; return `hk1_` plus canonical base64url of 32 random bytes. |
| `copyBackupKey` | `{recoveryKey}` | Authenticated session and the same clipboard policy as passwords. |
| `createBackup` | `{recoveryKey}` | Authenticated snapshot encrypted with platform AES-256-GCM; return envelope string. |
| `saveBackupFile` | `{envelope}` | System document picker, ciphertext only; true on save, false on cancellation. Locks the vault. |
| `loadBackupFile` | none | System document picker; ciphertext string or null on cancellation. Locks the vault. |
| `inspectBackup` | `{envelope, recoveryKey}` | Authenticate and validate; return counts, redacted entry metadata and archive/current-vault fingerprints. |
| `restoreBackup` | `{envelope, recoveryKey, vaultFingerprint, archiveFingerprint, replaceExisting}` | Validate again, reject stale preview, atomically merge by ID. Existing records remain unless replacement is explicitly true. Return current records. |

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

Backups have exact envelope keys `format`, `version`, `iv`, `ciphertext`.
The format is `heavenkey-mobile-backup`, version 1, a fresh 12-byte nonce,
and ciphertext followed by the 16-byte GCM tag. Binary values use canonical,
unpadded base64url. The authenticated data is `HeavenKey/mobile-backup/v1`.
The recovery key is never written into the archive. No password-derived key or
custom encryption is used. Cap plaintext at 16 MiB and envelope/file reads at
24 MiB before parsing. File jobs have one bounded worker and a 120-second timeout.
Only encrypted temporary files are allowed. Pickers cannot revive an authenticated
session; the user unlocks again before preview or restore. A wrong key, damaged
archive or stale fingerprint must leave the existing vault unchanged.

Android: API 30+, Keystore AES-GCM with required strong biometric/device credential
authentication, `noBackupFilesDir` and atomic writes. No accessibility service.
The browser must be the current default and its current APK signer set must match
bundled release-certificate pins. A legacy request establishes an exact HTTPS
host, not a complete field origin. Before authentication, require explicit
single-request host authorization explaining unknown ports and same-host frames.
Only then may stored HTTPS origins on that exact host be offered; the stored
origin itself is unchanged. No implicit parent/subdomain matching or persisted
exception. A top-level URL bar must never certify field origin. Conflicting
reported hosts, HTTP, ambiguous pairs and hidden/new-password fields are rejected.
Recheck browser trust, cancellation and the 30-second deadline before consuming
the grant exactly once. Source/parser tests cannot substitute for the actual
browser flow. The user authorized this researched adaptive policy; details and
primary sources are in MOBILE-AUTOFILL-POLICY.md.

iOS: shared Keychain access group for app and Credential Provider extension;
`whenPasscodeSetThisDeviceOnly` plus user presence, no iCloud synchronization.
Extension prompts for device authentication and credential selection. Only a
complete, unambiguous HTTPS URL context can authorize delivery. Domain-only and
identity-only requests do not establish the requesting port and are rejected.
URL identifiers require exact origin equality; every supplied domain hint must
agree with that host. Context changes and backgrounding invalidate pending UI and
authentication callbacks. A request expires after 120 seconds. Unsupported
contexts show a reason with the unlock action disabled. The extension target,
embed phase and matching entitlements are present; an iOS SDK build stays separate.

Native compilation, signed installation and actual browser flows are separate
acceptance from Dart tests or source inspection. No platform acceptance claim
without executed evidence for its source revision.
