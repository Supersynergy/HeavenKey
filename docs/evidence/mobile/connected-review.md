# Independent unified 0.25 source review v3

Approved for the immutable 76-file v3 manifest. All 76 current source hashes match; the manifest and final-scan-addendum.json match their supplied input digests. No remaining source finding was identified within the approved scope.

Only .gitleaksignore differs from approved v2. Removing the final comment and single exact fingerprint reconstructs its v2 SHA256. The new fingerprint is 423e61578c224ca4ef034d8bc15f1fee6a34a320:docs/evidence/check.log:generic-api-key:1474. It suppresses one historical commit/file/rule/line location, with no broad file or rule exemption.

Historical Git inspection independently verifies that check.log line 1474 is a JSON receipt. Its source_sha256 values for apps/web/src/passwords-access.ts and apps/web/src/passwords-crypto.ts equal SHA256 digests calculated directly from both blobs at that exact commit. Both flagged values are public source-content hashes. The two findings share one exact fingerprint; adding one entry is sufficient. The suppression file now contains 182 exact entries: the original two, 179 previously audited entries, and this one verified historical location. No secret or match values were emitted during review.

Code, validator, documentation, dependency, runtime and native evidence approvals from independent-review-v2.md carry forward through identical hashes. The accepted Android APK remains unchanged at SHA256 66a070236893e472f1d7260d1cda3aac97ba78ba14d93894187b8e99888cdb89. The corrected APK artifact/evidence equality and its synthetic red-green regression are unchanged. The prior mobile source approval may still be rebound only for Cargo.lock and justfile using the version-only and additive-recipe reasoning recorded in v2.

This is independent source and suppression review. No builds, native journeys, downloads or provider spending occurred. Packaging, live publication and GitHub CI acceptance remain with the integrating agent. Hardware, iOS, publisher signing, professional security audit and production approval retain their previous limits. Earlier reviews remain intact; v3 supersedes v2 only for the final frozen source manifest.
