# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Shipyard, **please do not open a public issue.**

Instead, email **info@acendas.ca** with:

- A description of the vulnerability
- Steps to reproduce
- Which component is affected (skill, agent, hook, rule, script)
- Potential impact

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

Shipyard is a Claude Code plugin — it runs locally on the user's machine. Security concerns include:

- **Hook scripts** — Python scripts that run on every tool invocation. A vulnerability here could execute arbitrary code.
- **Data file handling** — Shipyard reads and writes project data. Path traversal or injection in file paths is a concern.
- **Shell commands** — Skills and hooks execute shell commands. Command injection is a concern.
- **Auto-approve hook** — Automatically approves writes to Shipyard data directories. A bypass could approve writes to unintended paths.

## Out of Scope

- Vulnerabilities in Claude Code itself (report to [Anthropic](https://docs.anthropic.com/en/docs/claude-code))
- Vulnerabilities in the AI model's output (prompt injection, hallucination)
- Issues requiring physical access to the user's machine

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Previous minor | Best effort |
| Older | No |
