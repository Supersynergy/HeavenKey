#!/usr/bin/env bash
set -euo pipefail

cd /archive
sha256sum --check <<'CHECKSUMS'
628b4a7258487b80c1d3c221095a7ded349f5ae0175fd3dfab708d07428f041b  actions-runner-linux-arm64-2.338.0.tar.gz
54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7  bun-linux-aarch64.zip
995c82be0defc7a025cae49a2aa2644ce8245c9a3318fc4103907c6a285e8c7d  cargo-deny-0.20.2-aarch64-unknown-linux-musl.tar.gz
c6603814ddaa45e51263dafd31c0ac98808f688d26f7395804f9670b0fd599dd  cargo-audit-aarch64-unknown-linux-gnu-v0.22.2.tgz
CHECKSUMS

mkdir -p /opt/heavenkey/runner /opt/heavenkey/deps/apps/web /opt/heavenkey/tools
tar --no-same-owner --no-same-permissions -xzf actions-runner-linux-arm64-2.338.0.tar.gz -C /opt/heavenkey/runner
unzip -q bun-linux-aarch64.zip -d /opt/heavenkey/tools
install -m 755 /opt/heavenkey/tools/bun-linux-aarch64/bun /usr/local/bin/bun
tar --no-same-owner --no-same-permissions -xzf cargo-deny-0.20.2-aarch64-unknown-linux-musl.tar.gz -C /opt/heavenkey/tools
tar --no-same-owner --no-same-permissions -xzf cargo-audit-aarch64-unknown-linux-gnu-v0.22.2.tgz -C /opt/heavenkey/tools
install -m 755 /opt/heavenkey/tools/cargo-deny-0.20.2-aarch64-unknown-linux-musl/cargo-deny /usr/local/bin/cargo-deny
install -m 755 /opt/heavenkey/tools/cargo-audit-aarch64-unknown-linux-gnu-v0.22.2/cargo-audit /usr/local/bin/cargo-audit

cp /source/package.json /source/bun.lock /opt/heavenkey/deps/
cp /source/apps/web/package.json /opt/heavenkey/deps/apps/web/
cd /opt/heavenkey/deps
bun install --frozen-lockfile --ignore-scripts
PLAYWRIGHT_BROWSERS_PATH=/opt/heavenkey/browsers bun node_modules/playwright-core/cli.js install --with-deps chromium
useradd --uid 501 --gid 20 --create-home --shell /bin/bash heavenkey
cp /source/scripts/ci/runner_entry.sh /opt/heavenkey/runner/entry.sh
chmod 755 /opt/heavenkey/runner/entry.sh
bun --version
cargo-deny --version
cargo-audit --version
/opt/heavenkey/runner/bin/Runner.Listener --version
chown -R 501:20 /opt/heavenkey/runner
