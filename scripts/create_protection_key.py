"""Explicit headless setup: create one private key file outside HeavenKey's data directory."""
import argparse
import os
from pathlib import Path


def create(path: Path):
    path = path.expanduser().absolute()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Exclusive creation prevents overwriting a key needed by an existing database.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(os.urandom(32))
        stream.flush()
        os.fsync(stream.fileno())
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(f"Private protection key created: {create(args.path)}")
    print("Set HEAVENKEY_KEY_FILE to this path. Back it up separately; never put it inside the data directory.")
