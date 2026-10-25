#!/usr/bin/env bash
set -euo pipefail

test "${GITHUB_REPOSITORY:-}" = Supersynergy/HeavenKey
test "$(uname -m)" = aarch64
tools="${RUNNER_TEMP:?}/heavenkey-tools"
mkdir -p "$tools/bin"
cd "$tools"
curl --fail --location --retry 2 --max-time 120 --output bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-aarch64.zip
curl --fail --location --retry 2 --max-time 120 --output deny.tar.gz https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/cargo-deny-0.20.2-aarch64-unknown-linux-musl.tar.gz
curl --fail --location --retry 2 --max-time 120 --output audit.tgz https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv0.22.2/cargo-audit-aarch64-unknown-linux-gnu-v0.22.2.tgz
sha256sum --check <<'CHECKSUMS'
54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7  bun.zip
995c82be0defc7a025cae49a2aa2644ce8245c9a3318fc4103907c6a285e8c7d  deny.tar.gz
c6603814ddaa45e51263dafd31c0ac98808f688d26f7395804f9670b0fd599dd  audit.tgz
CHECKSUMS
unzip -q bun.zip
tar --no-same-owner --no-same-permissions -xzf deny.tar.gz
tar --no-same-owner --no-same-permissions -xzf audit.tgz
install -m755 bun-linux-aarch64/bun "$tools/bin/bun"
install -m755 cargo-deny-0.20.2-aarch64-unknown-linux-musl/cargo-deny "$tools/bin/cargo-deny"
install -m755 cargo-audit-aarch64-unknown-linux-gnu-v0.22.2/cargo-audit "$tools/bin/cargo-audit"
echo "$tools/bin" >> "${GITHUB_PATH:?}"
