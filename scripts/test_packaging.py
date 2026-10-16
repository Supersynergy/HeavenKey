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

    def test_each_embedded_demo_asset_invalidates_the_build_fingerprint(self):
        for name in (
            "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml",
            "apps/web/dist/main.js", "apps/web/index.html",
            "apps/web/dist/passwords.js", "apps/web/passwords.html",
            "scripts/build_openssl.py", "scripts/build_portable.py",
            "apps/demo/index.html", "apps/demo/main.js", "apps/demo/style.css",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        with patch.object(build_portable, "ROOT", self.root):
            baseline = build_portable.source_fingerprint()
            for name in ("index.html", "main.js", "style.css"):
                with self.subTest(asset=name):
                    asset = self.root / "apps/demo" / name
                    original = asset.read_text()
                    asset.write_text(original + "changed")
                    self.assertNotEqual(baseline, build_portable.source_fingerprint())
                    asset.write_text(original)

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

    def test_extensions_request_no_page_or_key_permissions(self):
        with patch.object(release, "OUT", self.root):
            files = release.extensions()
        self.assertEqual(len(files), 2)
        for name in ("chromium", "firefox"):
            manifest = json.loads(
                (self.root / f"extension-{name}/manifest.json").read_text()
            )
            for permission in (
                "permissions",
                "host_permissions",
                "content_scripts",
                "background",
                "externally_connectable",
            ):
                self.assertNotIn(permission, manifest)
            self.assertEqual(manifest["manifest_version"], 3)

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
