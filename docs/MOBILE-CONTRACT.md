# HeavenKey mobile platform contract

Flutter owns the interface; native code owns encrypted storage, device authentication,
clipboard expiry and browser credential delivery. No network, analytics, account,
custom cryptography, plaintext export or automatic desktop vault conversion.
The existing Argon2id desktop vault remains unchanged.
Portable backups contain ciphertext only and use a separately retained random key.

Channel: `heavenkey/vault`. All errors use a safe code/message without secret values.

| Method | Input | Result |
|---|---|---|
| `status` | none | `{available: bool, secureDevice: bool, autofillEnabled: bool, platform: string}` |
| `unlock` | none | Device authentication, then a list of entry maps. Empty list for a new vault. Cancellation is an error. |
| `save` | entry map | Save atomically; return null. Requires an authenticated session. |
| `delete` | `{id: string}` | Delete atomically; return null. Requires an authenticated session. |
| `lock` | none | Discard native session and clear owned clipboard; return null. |
| `copyPassword` | `{id: string}` | Copy from authenticated native vault, mark sensitive and schedule expiry after 30 seconds; clear owned data when leaving; return null. |
| `enableAutofill` | none | Open the system provider settings; return null. |
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
The legacy AutofillService and its authentication activity are disabled. The
previous implementation reconstructed a default-port origin from host-only hints;
the old APK offered that login on another port. A native top-level URL alone
also does not establish the origin of each frame. Browser delivery remains an
open requirement until a complete per-field origin is verified. It must not be
closed by simply disabling the feature or passing parser tests.

iOS: shared Keychain access group for app and Credential Provider extension;
`whenPasscodeSetThisDeviceOnly` plus user presence, no iCloud synchronization.
Extension prompts for device authentication and credential selection. Only a
complete, unambiguous HTTPS URL context can authorize delivery. Domain-only and
identity-only requests do not establish the requesting port and are rejected.
URL identifiers require exact origin equality.
Add the actual Xcode extension target, embed phase and matching entitlements.

Native compilation, signed installation and actual browser flows are separate
acceptance from Dart tests or source inspection. No platform acceptance claim
without executed evidence for its source revision.
