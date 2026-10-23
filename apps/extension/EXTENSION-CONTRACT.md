# HeavenKey extension contract

The extension connects only to a local `http://localhost:PORT` password manager after an explicit optional host-permission request and a one-use pairing code. Browser storage contains the local origin and extension-specific pairing token only. The token never authorizes `/config` or app pairing management. Revocation and process restart require pairing again.

Unlock reads the current encrypted record and revision, then reuses HeavenKey's versioned Argon2id/AES-GCM implementation (with PBKDF2-SHA256 legacy unlock). No master password, plaintext vault, derived key or session key is persisted. Closing the popup, explicit lock and two minutes of inactivity discard its decrypted state. Profile saves encrypt the complete vault and use the current compare-and-swap revision. A conflict locks the popup and requires a new read.

A user gesture injects bundled code into frame 0 in the isolated world. No permanent content script runs. The scanner records at most 200 visible fields and keeps DOM references in isolated memory. Filling requires an explicit current-origin confirmation, selected field IDs and an unchanged full URL and field fingerprint. Login fills additionally require an exact match of scheme, hostname and port with the stored login URL. HTTPS is required except loopback synthetic targets.

The coordinator excludes hidden/offscreen/honeypot, disabled, readonly, consent, newsletter, AGB and payment-choice fields and all frames. Sensitive target fields cannot be remapped into a lower sensitivity class. Sensitive values require both opt-in and exact entity matches; secrets require an independent opt-in. Existing values are preserved by default. No submit or click event is generated. Page scripts can read deliberately filled values exactly as with manual input and may react to standard input events.

Undo keeps at most five recent fills for at most two minutes, is bound to the same URL, ignores detached/replaced controls and preserves subsequent manual edits. Capture is explicit, excludes secrets always and financial/identity fields by default, and remains an editable preview until the user saves a profile. Clipboard reading occurs only after the clipboard button is clicked; the extension does not request clipboardRead permission.

Production manifests request `activeTab`, `scripting`, `storage`, `contextMenus` and optional localhost host access. There are no all-URLs hosts, external messaging, native messaging, alarms, remote scripts or persistent content scripts. The action and Ctrl/Command+Shift+Y open the popup. A selection context menu opens a preview; reading selection is a separate explicit action.

The legacy access-lab opener retains its existing local/HTTPS destination validation and connection-only preferences. Firefox temporary loading and Chrome unpacked loading are separate from store signing and distribution approval.

Saving a profile retains the unlocked record’s exact KDF and salt; the popup never silently downgrades an Argon2id vault. Migration is an explicit owner action in the main app.

## Passkey handoff and login shortcut

The passkey button opens a full extension tab when invoked from a transient toolbar popup. A fresh, non-extractable P-256 private key stays in that tab. The paired service holds only its public point and a 90-second request bound to extension origin, current pairing token, vault revision and salt. The owner page displays the extension origin and an eight-digit hexadecimal comparison code. Only an explicit owner click starts the existing verified WebAuthn/PRF unlock ceremony. Device biometrics or PIN depend on the browser and authenticator; no fingerprint support is presumed.

The owner page encrypts the transient master with ephemeral ECDH, HKDF-SHA256 and AES-256-GCM, authenticating the request, recipient point, extension origin, revision and salt. The local service relays only the sealed payload. The requesting extension consumes it once, rechecks the encrypted vault snapshot and decrypts locally. Replacement, revision changes, expiry and revocation invalidate the request. Closing, locking or falling back to the master password discards the private channel key. JavaScript cannot guarantee immediate erasure of immutable strings or protection from a compromised host/browser.

Context menus offer login, saved form templates and selected-text preview. They transmit only a target tab ID and intent, never credential values. Cross-frame context invocations are ignored. Exact-origin logins sort first. The login shortcut preselects empty username/email/password fields only when one current-password candidate identifies one form. Ambiguous forms require manual mapping. New-password targets never receive saved secrets, even with secret consent. Filling still requires an explicit origin confirmation and never submits.

This user-operated extension is separate from the contained agent broker. A receiving website can read deliberately filled values, and an agent with unrestricted page inspection or host access is outside this extension's secrecy boundary. Agent-only opaque login must use the scoped broker, not a DOM-readable browser session.
