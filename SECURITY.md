# Security and privacy

Do not commit or publish browser profiles, cookies, session state, API keys, provider tokens, diagnostic screenshots, or account-specific HTML/text dumps. The repository ignores its local runtime directories, but review `git status` before every commit.

If a credential or session artifact is committed, revoke or rotate it through the relevant platform/provider immediately, remove it from Git history, and invalidate affected browser sessions where possible.

## Reporting a vulnerability

Please open a private security advisory or contact the repository maintainer privately. Do not include credentials, cookies, browser profiles, full account HTML, or unredacted personal data in a public issue.
