# Contributing

Thanks for helping make coding agents useful in live meetings.

## Development setup

Agent Meet Bridge currently targets macOS, Node.js 22+, Google Chrome, and Google Meet.

```bash
npm ci
npm run setup:local
npm run check
```

Use a dedicated Google account and Chrome profile for the meeting participant. Keep `.env`, browser profiles, transcripts, generated audio, and credentials out of commits.

## Pull requests

- Open an issue before large architectural changes.
- Add or update tests for behavior changes.
- Preserve the private/public boundary: sidebar messages stay silent unless the user explicitly selects **Share with room**.
- Preserve the permission boundary: harnesses are read-only unless the user explicitly enables a private Prototype turn.
- Keep adapter-specific behavior behind runtime or meeting-transport interfaces.
- Run `npm run check` before submitting.

Small, focused pull requests are easiest to review.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) before adding a new agent harness, meeting platform, transcript source, or voice transport.
