import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import package_release as release
import build_portable


class PackagingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def create_build_sources(self):
        for name in (
            "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml",
            "apps/web/dist/main.js", "apps/web/index.html",
            "apps/web/dist/passwords.js", "apps/web/passwords.html",
            "apps/web/dist/share.js", "apps/web/share.html",
            "docs/assets/heavenkey-hero-square.png",
            "scripts/build_openssl.py", "scripts/build_portable.py", "scripts/build_extension.ts", "scripts/broker.rs",
            "scripts/build_agent_sandbox.ts", "scripts/sandbox/Dockerfile",
            "apps/demo/index.html", "apps/demo/main.js", "apps/demo/style.css",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)

    def test_each_embedded_demo_asset_invalidates_the_build_fingerprint(self):
        self.create_build_sources()
        with patch.object(build_portable, "ROOT", self.root):
            baseline = build_portable.source_fingerprint()
            for name in ("apps/demo/index.html", "apps/demo/main.js", "apps/demo/style.css", "docs/assets/heavenkey-hero-square.png", "apps/web/share.html"):
                with self.subTest(asset=name):
                    asset = self.root / name
                    original = asset.read_text()
                    asset.write_text(original + "changed")
                    self.assertNotEqual(baseline, build_portable.source_fingerprint())
                    asset.write_text(original)

    def test_runtime_evidence_does_not_invalidate_compiled_extension_sources(self):
        self.create_build_sources()
        source = self.root / "apps/extension/content.ts"
        source.parent.mkdir(parents=True)
        source.write_text("synthetic extension source")
        with patch.object(build_portable, "ROOT", self.root):
            baseline = build_portable.source_fingerprint()
            for name in (
                "TEST-RECEIPT.json", "ENGINE-RECEIPT.json",
                "INTEGRATION-BLOCKER.json", "WORKER-STATUS.md", "evidence/popup.png",
            ):
                with self.subTest(evidence=name):
                    evidence = source.parent / name
                    evidence.parent.mkdir(parents=True, exist_ok=True)
                    evidence.write_text("new runtime observation")
                    self.assertEqual(baseline, build_portable.source_fingerprint())
            source.write_text("changed extension behavior")
            self.assertNotEqual(baseline, build_portable.source_fingerprint())

    def test_wrong_architecture_is_rejected(self):
        binary = self.root / "binary"
        header = bytearray(64)
        header[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", header, 18, 62)
        binary.write_bytes(header)
        release.verify_architecture(binary, "x86_64-unknown-linux-musl")
        with self.assertRaises(ValueError):
            release.verify_architecture(binary, "aarch64-unknown-linux-musl")
        with self.assertRaises(ValueError):
            release.verify_architecture(binary, "x86_64-pc-windows-gnu")

    def test_extensions_package_bundles_with_only_explicit_access(self):
        self.create_build_sources()
        for name in ("chromium", "firefox"):
            source = self.root / f"extension-source-{name}"
            source.mkdir()
            for filename in ("smart-popup.js", "content.js", "background.js", "LICENSE", "THIRD-PARTY-NOTICE.md"):
                (source / filename).write_text("synthetic bundle")
            (source / "manifest.json").write_text(json.dumps({
                "manifest_version": 3, "version": release.VERSION,
                "permissions": ["activeTab", "scripting", "storage", "contextMenus"],
                "optional_host_permissions": ["http://localhost/*"],
            }))
        with (
            patch.object(release, "OUT", self.root),
            patch.object(build_portable, "ROOT", self.root),
        ):
            files = release.extensions()
        self.assertEqual(len(files), 2)
        for name in ("chromium", "firefox"):
            manifest = json.loads(
                (self.root / f"extension-{name}/manifest.json").read_text()
            )
            for permission in (
                "host_permissions",
                "content_scripts",
                "externally_connectable",
            ):
                self.assertNotIn(permission, manifest)
            self.assertEqual(manifest["manifest_version"], 3)
            self.assertEqual(set(manifest["permissions"]), {"activeTab", "scripting", "storage", "contextMenus"})
            self.assertTrue((self.root / f"extension-{name}/content.js").is_file())
        path = self.root / "extension-source-chromium/manifest.json"
        manifest["host_permissions"] = ["<all_urls>"]
        path.write_text(json.dumps(manifest))
        with patch.object(release, "OUT", self.root), self.assertRaisesRegex(ValueError, "persistent extension access"):
            release.extensions()

    def test_truncated_pe_fails_with_a_clear_error(self):
        binary = self.root / "binary"
        binary.write_bytes(b"MZ")
        with self.assertRaises(ValueError):
            release.verify_architecture(binary, "x86_64-pc-windows-gnu")

    def test_stale_or_modified_build_cannot_be_packaged(self):
        target = "x86_64-pc-windows-gnu"
        binary = self.root / "target" / target / "release/uac-api.exe"
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b"binary")
        builds = self.root / "dist/builds"
        builds.mkdir(parents=True)
        good = {
            "target": target,
            "features": ["portable"],
            "source_fingerprint": "current",
            "binary_sha256": release.sha256(binary),
        }
        for replacement in (
            {"source_fingerprint": "old"},
            {"binary_sha256": "changed"},
            {"features": []},
        ):
            with self.subTest(replacement=replacement):
                (builds / f"{target}.json").write_text(
                    json.dumps(dict(good, **replacement))
                )
                with (
                    patch.object(release, "ROOT", self.root),
                    patch.object(release, "OUT", self.root / "dist"),
                    patch.object(release, "source_fingerprint", return_value="current"),
                ):
                    with self.assertRaisesRegex(ValueError, "stale or modified"):
                        release.desktop(target)


if __name__ == "__main__":
    unittest.main()
