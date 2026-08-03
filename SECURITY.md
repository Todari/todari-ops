# Security Policy

## Supported version

Security fixes are applied to the latest commit on `main`. Older revisions and
fork-specific deployments are not maintained.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities, exposed credentials, or
deployment details. Use GitHub's **Security → Report a vulnerability** flow for
this repository.

Include the affected component, reproduction steps, impact, and any suggested
mitigation. Do not access data or systems that you do not own while validating
a report.

## Deployment responsibility

This project is designed for a trusted, single-owner Discord environment. A
deployment operator is responsible for protecting Discord, GitHub, Anthropic,
Sentry, Vercel, SSH, database, and webhook credentials; restricting network
access; and rotating credentials after suspected exposure.
