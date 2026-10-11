# Security

HeavenKey is a research preview. Production deployment is not supported yet. Hardware, recovery, multiple credentials, key rotation, distributed concurrency, rate limits and external security review remain open.

Collaborators should report vulnerabilities privately to the repository owner through their existing private contact channel. Do not post credentials or exploitable details in a public issue. A dedicated disclosure address and response SLA have not been configured.

Reproduce reports with synthetic fixtures and include the affected commit, expected behavior and minimal steps. Real wallets, vehicles, accounts and customer records require separate authorization.

The bootstrap file and issuer key remain local and are excluded from Git. Bootstrap authority ends after the first successful provisioned owner enrollment. Legacy data from the first-enrollment spike is not trusted production ownership.
