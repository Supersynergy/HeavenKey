# HeavenKey design system

The local password manager uses the approved 16 October 2026 app concept. Keep its navigation and behavior consistent across unlock, vault, editor and settings. The separate passkey access lab keeps its existing interface.

## Structure

- Desktop: navigation, entry list, selected-entry details. Search and create stay in the toolbar.
- Small windows: collapsible navigation; narrow windows alternate between list and details while retaining search and selection.
- Edit in a focused form. Place import, backup, restore and master-password rotation in settings. Locked recovery must remain usable without opening the old vault.
- Copy next to the field; show and copy remain separate actions. Display real state and actionable errors.

## Visual rules

Use system sans-serif type, cool neutral surfaces and one blue accent. Use shared CSS tokens for light and dark themes, spacing, borders and focus. Keep long content scrollable within its owning region. Settings and lock remain available in short windows. Use restrained borders and no decorative artwork in app views.

Buttons have clear names, consistent shapes and visible keyboard focus. Primary touch actions need 44-pixel targets. Reduced-motion preferences apply. Theme may persist locally; credentials, search queries and decrypted contents may not.

## Product truth

Use only the actual encrypted vault. No demonstration records, static TOTP codes, mock security scores or decorative sync indicators. Security summaries, if present, must be calculated locally from real entries and explain their limits. Keep all existing validation, confirmation, storage-revision and lock invalidation paths.

The HTML, CSS and TypeScript entry points remain in place. Cryptography, API contracts, database format and the access-lab route are outside this visual redesign.
