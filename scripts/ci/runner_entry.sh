#!/usr/bin/env bash
set -euo pipefail
cd /opt/heavenkey/runner
jit=$(python3 -c 'import json; print(json.load(open("/jit/config.json"))["encoded_jit_config"])')
exec ./run.sh --jitconfig "$jit"
