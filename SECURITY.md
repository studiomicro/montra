# Security policy

Montra handles financial records, mailbox access tokens and user-supplied AI keys, so we take reports seriously.

## Reporting a vulnerability

Report privately with GitHub Security Advisories: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue or pull request for a vulnerability. If you cannot use
advisories, write to `<security-contact>`.

Please include what you found, steps to reproduce, and the impact. We aim to acknowledge a report within a few days
and will tell you when it is fixed.

## In scope

- Authentication, sessions, password and account-key handling.
- Space membership and role checks (reading or changing another space's data).
- Injection, XSS, CSRF and SSRF in the app and the Workers.
- Webhook verification, the inbound e-mail path and the Gmail connection.
- Leaks of secrets, tokens, balances or personal data, including through the assistant's tools.
- Weak encryption of stored results, connected-app tokens or user AI keys.

## Out of scope

- Findings that need a rooted device, a compromised browser or physical access.
- Denial of service by volume, and automated scanner output without a working proof.
- Missing best-practice headers with no demonstrated impact.
- Vulnerabilities in third-party services (Cloudflare, Google, Anthropic); report those to the vendor.

## Rules for testing

Test only against your own self-hosted instance or your own accounts. Never access, change or delete another
person's data, and stop once you have shown the issue. Do not run tests against a hosted instance operated by
someone else without their written permission.
