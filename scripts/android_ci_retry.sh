#!/usr/bin/env bash
# Retry a known transient dependency resolution failure without retrying failed tests.
set -u

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

for attempt in 1 2 3; do
    "$@" 2>&1 | tee "$log"
    status=${PIPESTATUS[0]}
    if (( status == 0 )); then
        exit 0
    fi
    if (( attempt == 3 )) || ! grep -Ei -q         'Received status code (429|50[0-9])|Read timed out|Connection reset|could not resolve plugin artifact.*org\.gradle\.kotlin\.kotlin-dsl' "$log"; then
        exit "$status"
    fi
    echo "Retrying transient Android dependency resolution (attempt $((attempt + 1)) of 3)."
    sleep "$((attempt * 10))"
done
