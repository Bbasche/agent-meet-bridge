# Changelog

All notable changes to this project are documented here.

## Unreleased

- Add provider-neutral durable harness adapters for Codex, Claude Code, Hermes, and Pi, plus a shell-free generic CLI adapter.
- Add one shared OpenAI-compatible realtime voice core for OpenAI Realtime and Grok Voice.
- Add audio-rate conversion, passive output gating, function calls, reconnect buffering, and provider readiness checks.
- Enable the Codex app-server realtime feature explicitly and report its current API-key requirement without hanging.
- Capture decoded remote WebRTC audio through an AudioWorklet and recover the isolated meeting browser after crashes without losing the durable agent context.
- Add bounded meeting/repository context packs and harden passive wake-name gating against provider event reordering.
- Add a real loopback WebSocket integration check covering session readiness, PCM conversion, wake gating, harness tools, and spoken output.
- Persist a bounded live `context.md` and include structured room plus private-operator context in the private debrief.
- Retain high-signal context across long calls and serialize transcript writes before shutdown.
- Reconcile raw-audio transcripts with recent Meet speaker labels and bind passive follow-ups to the original speaker.
- Serialize inbound realtime events so asynchronous callbacks cannot reorder speaker permissions or playback.
- Buffer meeting PCM until reconnecting providers acknowledge the configured voice session.
- Close failed handshake sockets and use one bounded retry supervisor for realtime reconnects.
- Silence the bot browser's local media playback without using Chrome's capture-breaking mute flag.

## 0.1.5 — 2026-08-21

- Make the bridge BYO-agent: name, wake word, task title, voice instructions, and optional persona guidance are operator supplied.
- Replace identity-specific defaults, examples, transcript filters, test fixtures, and generated audio filenames with agent-neutral equivalents.
- Leave after five continuous minutes alone, then generate a private durable-task debrief beside the transcript.

## 0.1.4 — 2026-08-21

- Preserve the wake name when Google Meet rolls a long addressed sentence into multiple caption blocks.
- Reconstruct incremental caption fragments before dispatching an addressed turn to the agent.
- Flush buffered addressed turns when another speaker takes the floor.

## 0.1.3 — 2026-08-21

- Continue capturing participant captions while the agent is speaking and during the former playback tail window.
- Filter the agent's self-captions by speaker identity instead of suppressing every caption during playback.
- Preserve overlapped and immediate post-response speech in the durable transcript.

## 0.1.2 — 2026-08-21

- Never synthesize passive-mode sentinel responses such as `[Agent remains silent.]` or “I'll stay quiet.”
- Limit the follow-up window to the same speaker and genuine follow-up cues.
- Treat “I'm not talking to the agent” and similar phrases as dismissals rather than wake-name requests.

## 0.1.1 — 2026-08-21

- Capture ambient Google Meet captions from every speaker, not only turns containing the agent's wake name.
- Preserve inferred Meet participant names in the durable transcript and private sidecar.

## 0.1.0 — 2026-08-21

- Added a named, addressable Google Meet participant backed by a durable Codex task.
- Added Google Meet caption ingestion and a unified local call transcript.
- Added a private, silent sidecar with Analyze and explicit Prototype modes.
- Added synthetic microphone output for spoken agent responses on macOS.
- Added persistent Google profile and Codex task reuse across meeting rejoins.
- Added explicit passive, active, and unrestricted participation policies.
- Added extension points for other coding harnesses, transcript sources, and meeting transports.
