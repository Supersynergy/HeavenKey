# /// script
# requires-python = ">=3.13,<3.14"
# dependencies = ["asyncssh==2.21.1", "pyftpdlib==2.2.0", "pyopenssl==25.3.0"]
# ///
"""Loopback-only SFTP/FTPES fixtures. All keys, credentials and files are synthetic."""
import argparse
import asyncio
import datetime
import json
import logging
import os
from pathlib import Path
import signal
import threading

import asyncssh
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    args = parser.parse_args()
    base = args.directory.resolve()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = base / "files"
    allowed = root / "allowed"
    allowed.mkdir(parents=True)
    (allowed / "hello.txt").write_text("Synthetic transfer document.\n")
    (allowed / "large.bin").write_bytes(bytes(1048577))
    (root / "outside.txt").write_text("Synthetic outside-scope document.\n")
    (allowed / "escape").symlink_to(root / "outside.txt")
    (base / "authorized_keys").write_text("")
    user, password = "transfer-fixture", "Synthetic-transfer-only!42"
    host_key = asyncssh.generate_private_key("ssh-ed25519")

    class SSHServer(asyncssh.SSHServer):
        def begin_auth(self, username):
            return True

        def password_auth_supported(self):
            return True

        def validate_password(self, username, supplied):
            return username == user and supplied == password

        def public_key_auth_supported(self):
            return True

        def validate_public_key(self, username, key):
            if username != user:
                return False
            expected = key.export_public_key().decode().strip().split()[:2]
            return any(line.split()[:2] == expected for line in (base / "authorized_keys").read_text().splitlines())

    class ConfinedSFTP(asyncssh.SFTPServer):
        def map_path(self, path):
            local = super().map_path(path)
            if os.path.commonpath([os.fsdecode(os.path.realpath(local)), str(allowed)]) != str(allowed):
                raise asyncssh.SFTPPermissionDenied("Synthetic account boundary")
            return local

    sftp = await asyncssh.create_server(
        SSHServer, "127.0.0.1", 0, server_host_keys=[host_key],
        sftp_factory=lambda channel: ConfinedSFTP(channel, chroot=str(allowed)),
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "HeavenKey synthetic transfer CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=2))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                         data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                         encipher_only=None, decipher_only=None), critical=True)
          .sign(ca_key, hashes.SHA256()))
    tls_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
            .issuer_name(ca_name).public_key(tls_key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                           data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                           encipher_only=None, decipher_only=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    (base / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (base / "server.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file = base / "server-key.pem"
    key_file.write_bytes(tls_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_file.chmod(0o600)
    authorizer = DummyAuthorizer()
    authorizer.add_user(user, password, str(allowed), perm="elradfmwMT")

    class FTPHandler(TLS_FTPHandler):
        certfile = str(base / "server.pem")
        keyfile = str(key_file)
        tls_control_required = True
        tls_data_required = True

    FTPHandler.authorizer = authorizer
    ftp = FTPServer(("127.0.0.1", 0), FTPHandler)
    ftp_thread = threading.Thread(target=ftp.serve_forever, kwargs={"timeout": 0.1, "blocking": True, "handle_exit": False}, daemon=True)
    ftp_thread.start()
    info = {"sftp_port": sftp.get_port(), "ftpes_port": ftp.socket.getsockname()[1], "host_key": host_key.get_fingerprint("sha256"), "root": "/", "username": user}
    (base / "fixture.json").write_text(json.dumps(info))
    print(json.dumps({"ready": True, **info}), flush=True)
    stopped = asyncio.Event()
    for name in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(name, stopped.set)
    try:
        await stopped.wait()
    finally:
        ftp.close_all()
        sftp.close()
        await sftp.wait_closed()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    os.umask(0o077)
    asyncio.run(main())
