# Security Policy

## Reporting a vulnerability

Please report vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue for credentials exposure, command execution, sidecar authorization bypasses, or private-message disclosure.

## Supported version

The latest commit on `main` is supported during the project's early development phase.

## Security model

- The sidecar binds to loopback and requires an unguessable per-session token delivered outside the HTTP request target.
- The sidecar clears the token-bearing URL fragment, disables caching/referrers/framing, and accepts bounded JSON API bodies only.
- The browser profile is dedicated to the meeting agent.
- Codex workspace access is read-only by default.
- Workspace writes require an explicit Prototype-mode action.
- Private sidebar messages are never spoken without an explicit **Share with room** action.
- Meeting transcripts and browser profiles stay local and are ignored by Git.
- Unparsed failed harness output remains attached only for local adapter parsing and is not surfaced in logs or meeting audio.

This project automates a browser and connects it to an agent capable of inspecting local files. Review configuration and permissions before joining any sensitive call.
