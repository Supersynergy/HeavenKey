# Security

HeavenKey provides a local encrypted password manager and a separate experimental passkey/access lab. The current release verification is documented in docs/PASSWORD-MANAGER-VERIFICATION.md and the release ACCEPTANCE.json. Automated tests cover implemented recovery, multiple credentials, key rotation and bounded pairing attempts; these features do not establish an external security audit or physical-device acceptance. Publisher signing, notarization, physical passkeys and Firefox extension runtime remain unaccepted.

Collaborators should report vulnerabilities privately to the repository owner through their existing private contact channel. Do not post credentials or exploitable details in a public issue. A dedicated disclosure address and response SLA have not been configured.

Reproduce reports with synthetic fixtures and include the affected commit, expected behavior and minimal steps. Real wallets, vehicles, accounts and customer records require separate authorization.

The bootstrap file and issuer key remain local and are excluded from Git. Bootstrap authority ends after the first successful provisioned owner enrollment. Legacy data from the first-enrollment spike is not trusted production ownership.
