# HeavenKey form feature map

| Capability | Source and execution |
| --- | --- |
| de/en text extraction, entity validators, IBAN, Luhn | Reviewed SmartField `vendor/extract.js`, popup-only |
| WHATWG autocomplete, labels, aria, camel/snake identifiers | SmartField scoring primitives, restricted `content.ts` scanner |
| Country and salutation aliases | SmartField alias/option matching primitives |
| Split dates, address/house number, phone, card expiry | SmartField resolution/coercion primitives |
| Select, radio, checkbox, contenteditable, native setters | Reviewed primitives with explicit selection and safety gates |
| Open shadow roots | SmartField traversal; closed roots remain inaccessible |
| Encrypted profiles, login/TOTP search | Shared HeavenKey vault crypto and profile validator |
| Pairing, revoke/restart disconnection, current revision | Local Rust service and extension-specific origin-bound token |
| Preview, editable values, per-field mapping | `smart-popup.ts` |
| Exact login origin, fresh profile origin confirmation | Popup and independent isolated coordinator checks |
| Hidden/frame/consent/payment denial | `content.ts`, never relaxed by opt-ins |
| Sensitive and secret opt-ins, preserve existing values | `content.ts`, checked against actual target classification |
| Undo and reverse capture | Bounded isolated memory and explicit capture preview |
| Clipboard and selection | Explicit popup clicks; no background reads |
| Existing access-lab settings and opener | Existing `settings.js` and `popup.js` |
| Chrome/Firefox production bundles | `bun scripts/build_extension.ts`, version from workspace Cargo.toml |
| Login and template context menus | Background user gesture, target tab/intent only; no cross-frame fill |
| Matching site and one-form login preview | Exact-origin sort; preselected empty login fields, final origin consent |
| Optional biometric/PIN unlock | Owner WebAuthn PRF with 90-second, single-use encrypted extension handoff |
| Registration protection | New-password fields reject saved passwords, including explicit remapping |
