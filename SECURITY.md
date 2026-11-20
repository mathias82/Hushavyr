# Security policy

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/mathias82/ai-privacy-router/security/advisories/new) when available. If private reporting is unavailable, open a public issue requesting a private contact channel. Keep sensitive details out of the public issue.

Include the extension and VS Code versions, the routing mode, and reproduction steps using synthetic sample data. Omit credentials, private prompts, source files, and raw logs.

The extension controls requests it initiates. Independent Copilot features and other extensions have their own network behavior. Use a separate profile with Copilot disabled for sensitive work. Local-only mode is the default, and the router does not automatically fall back to cloud providers.
