# HeavenKey 0.26 combined source review

The prior 0.25 source review remains evidence for unchanged native, crypto and sync implementation. The approved onboarding review and final runner delta below supersede its bindings for the 34 reviewed current files. All 92 union bindings were checked against current source. Source approval is distinct from the separately executed Android and desktop runtime receipts. No physical-device, iOS or production approval is inferred.

## Historical 0.25 review

# Independent unified 0.25 source review v3

Approved for the immutable 76-file v3 manifest. All 76 current source hashes match; the manifest and final-scan-addendum.json match their supplied input digests. No remaining source finding was identified within the approved scope.

Only .gitleaksignore differs from approved v2. Removing the final comment and single exact fingerprint reconstructs its v2 SHA256. The new fingerprint is 423e61578c224ca4ef034d8bc15f1fee6a34a320:docs/evidence/check.log:generic-api-key:1474. It suppresses one historical commit/file/rule/line location, with no broad file or rule exemption.

Historical Git inspection independently verifies that check.log line 1474 is a JSON receipt. Its source_sha256 values for apps/web/src/passwords-access.ts and apps/web/src/passwords-crypto.ts equal SHA256 digests calculated directly from both blobs at that exact commit. Both flagged values are public source-content hashes. The two findings share one exact fingerprint; adding one entry is sufficient. The suppression file now contains 182 exact entries: the original two, 179 previously audited entries, and this one verified historical location. No secret or match values were emitted during review.

Code, validator, documentation, dependency, runtime and native evidence approvals from independent-review-v2.md carry forward through identical hashes. The accepted Android APK remains unchanged at SHA256 66a070236893e472f1d7260d1cda3aac97ba78ba14d93894187b8e99888cdb89. The corrected APK artifact/evidence equality and its synthetic red-green regression are unchanged. The prior mobile source approval may still be rebound only for Cargo.lock and justfile using the version-only and additive-recipe reasoning recorded in v2.

This is independent source and suppression review. No builds, native journeys, downloads or provider spending occurred. Packaging, live publication and GitHub CI acceptance remain with the integrating agent. Hardware, iOS, publisher signing, professional security audit and production approval retain their previous limits. Earlier reviews remain intact; v3 supersedes v2 only for the final frozen source manifest.


## Approved onboarding review

# HeavenKey onboarding final independent source review

Approved for the exact reviewed source hashes in review-onboarding-final.json. No unresolved P1 or P2 finding remains in the reviewed onboarding changes. This approval supersedes the rejected source verdict in review-onboarding.json; both original rejected files remain unchanged. Source approval does not certify the still-pending Android onboarding runtime journey or the final published release.

## Resolved findings

The browser runner deletes its previous receipt before startup and keeps the result in memory. It verifies collected browser errors and unchanged source hashes before writing a temporary JSON file and atomically renaming it to the positive receipt path. The supplied fault-injection log records exit 1 at the browser-error assertion. Its regression directory contains screenshots but no desktop-acceptance.json, so the rejected run leaves no current green receipt. An ordinary subsequent journey records exit 0 and produces the supplied positive receipt. The console still prints its journey PASS before final validation; the positive machine-readable receipt is correctly gated and the overall process exit remains authoritative.

The previous receipt-binding gap is corrected. The new desktop receipt binds passwords-entry-assist.ts, the main controller, onboarding module, CSS, HTML and runner. All six hashes match the reviewed current files. Its tested binary SHA256 matches the current debug binary, and the receipt identifies HeavenKey 0.26.0. The injected browser-error regression is a failure-path test, not successful application or release acceptance.

README no longer claims reuse of an unchanged 0.25 APK and the mobile download label now names 0.26. Distribution documentation links to the new 0.26 release report. These source documents describe the intended final release; publication, package presence and final platform evidence remain integration gates.

## Application and caller review

The original source review carries forward for unchanged implementation hashes. Guided desktop entry keeps the four primary fields visible, preserves custom names, normalizes bare domains to HTTPS and retains explicit HTTP support. Local username suggestions require selection, use safe text rendering, and clear with editor/vault state. Password replacement requires a separate confirmation action. The full editor retains advanced fields; locked state, generation guards, encrypted commit, deliberate Cancel/Escape discard, focus return, restore and import callers remain intact. Failed storage does not clear the editor.

Flutter convenience parsing still passes the stored origin through unchanged canonicalOrigin and VaultEntry validation. The preview explicitly identifies removal of path/query/fragment while retaining exact HTTPS host and port. Existing domain, credential, IP and port restrictions remain. The scroll container keeps every form validator mounted. Controllers preserve entered values through previews, selected local hints, optional notes and generator dialogs; delayed confirmation checks mounted state, busy state and the original password before replacement. Empty-state actions navigate to existing backup or desktop flows without performing sensitive actions. The first-save reminder clears on lock. Native authentication, encrypted storage, background locking, clipboard, backup and synchronization implementations are unchanged in this onboarding diff.

The existing password-manager integration test now checks that generation leaves the entered password unchanged before confirmation, then checks the confirmed generated value. The CI source check includes the new helper tests. Workspace/web/Flutter versions remain coherent at 0.26; no dependency additions or upgrades are part of this change.

## New Android runner and release validation

The new Android UI runner fixes its serial to emulator-5584 and verifies the owned AVD name heavenkey-20261024 before installation or synthetic app-data clearing. It checks the installed APK bytes against the candidate hash, uses a synthetic PIN only in the actual system credential dialog, bounds subprocess/UI searches, handles the real keyboard, and reauthenticates between bounded test sessions. It checks first-use choices, explicit backup/desktop navigation, origin preview, HTTP rejection, password confirmation, local username selection, generation, custom title persistence, process restart and locking. It hashes all reviewed mobile entry/controller/version inputs before the journey, rechecks them before emitting success, and removes the old positive receipt at startup. These checks make failure observable; source inspection does not establish that the pending journey has passed.

The connected acceptance helper derives the candidate filename from Flutter version. Its existing optional local-file check is unchanged in meaning; publishing still requires the release validator's complete artifacts. release_acceptance now requires android-onboarding.json alongside the previous Android receipts, verifies current receipt source hashes and accepted APK binding, and requires the new current desktop onboarding receipt. The existing artifact-to-executed-APK equality, archive and extension provenance, exact package list, source/build checks and live asset digest checks remain. The boolean reused_unchanged field permits a new tested 0.26 APK; it does not bypass byte or source binding.

## Evidence and limits

The reviewer reran the three Bun helper tests: 3 pass, 13 assertions, 0 failures. git diff --check passed. Python AST parsing passed for the Android onboarding runner and both changed Python validators. This reviewer ran no native/emulator jobs, build, network call or dependency install.

The supplied desktop final journey log records exit 0. The fault run records exit 1 and has no positive receipt. The current check-final.log records just check exit 0; supplied e2e evidence records 138 of 138 cases passing. The earlier 30-test Flutter result and 11 matching mobile source bindings remain applicable to the unchanged Dart implementation reviewed here. These are supplied execution records, not jobs independently repeated by this reviewer.

At review time docs/evidence/mobile/android-onboarding.json is absent, so the Android onboarding journey remains pending and no new Android onboarding runtime approval is given. The final release validator will reject the missing receipt. Later successful Android, platform/package, GitHub CI and live-publication evidence must match these source hashes or receive a new source review. Physical devices, iOS, publisher signatures, professional security audit and production approval remain separate. No human time-saving result is inferred.


## Approved final driver delta

# HeavenKey onboarding final source review v2

Approved for all 34 source hashes in review-onboarding-final-v2.json. Only scripts/mobile_onboarding_e2e.py differs from the previous approved source manifest. The other 33 source bindings match exactly, including the Flutter implementation, versions, desktop runner, validators and documentation. No unresolved P1/P2 finding was identified in this runner update. Earlier reviews remain intact.

The Android helper now encodes spaces as %s for Android input text. Its fill action dismisses the keyboard through hide_keyboard instead of sending Back unconditionally. Keyboard dismissal checks the active mInputShown=true state and waits 0.5 seconds after Back. The supplied keyboard diagnostic shows that mIsInputViewShown can remain true even while mInputShown is false. Using the active flag prevents an unnecessary Back from navigating out of the editor; encoding spaces preserves the intended synthetic custom title.

Python AST parsing passed. Seven isolated helper assertions passed with stubbed adb, UI-node, tap and sleep functions. They verified that a false mInputShown with a true mIsInputViewShown sends no Back and performs no wait, that true mInputShown sends Back and the 0.5-second wait, and that a spaced custom title becomes Android input encoding without a blind Back. These were mocked helper checks; no emulator, adb command, real sleep or native job was executed by this reviewer.

The remaining runner safeguards were inspected. The serial and owned AVD assertion remain before installation or synthetic app-data clearing. Installed APK bytes must match the candidate hash. Device-credential actions, UI searches, subprocess timeouts and reauthentication sessions remain bounded and synthetic. The old positive receipt is removed at startup; source bindings are checked again before the final success write. The change affects test input handling, without modifying application authentication, persistence, normalization, password replacement, background locking or backup behavior.

The earlier desktop receipt-publication correction and source approval carry forward through unchanged hashes. Runtime evidence is separate. The final Android UI journey is still an integration responsibility; this review does not mark it passed or manufacture its receipt. Current APK acceptance, package assembly, CI and live publication require matching executed evidence. Physical devices, iOS, publisher signatures, professional security audit and production approval retain their previous limits. No provider spending, network calls, implementation edits or Git operations occurred in this review.
