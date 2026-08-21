# Agent Meet Bridge architecture

Agent Meet Bridge treats the meeting, transcript, participation policy, agent harness, speech output, persistence, and private UI as separate adapters. Codex is the first harness, not a permanent coupling.

## Runtime topology

```text
Google Meet
  ├─ dedicated Chrome profile
  ├─ camera blocked and control verified off
  ├─ live captions ───────────────┐
  └─ synthetic microphone ◀── TTS│
                                  ▼
                       addressed-turn policy
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Codex harness              transcript store
             durable task               Markdown + JSONL
                    ▲
                    │ private only
             localhost sidecar
```

## Adapter contracts

| Boundary | Current adapter | Required behavior |
| --- | --- | --- |
| Meeting transport | Playwright + Chrome | Join, expose caption text, inject agent audio, force camera off, leave cleanly |
| Transcript input | Meet live captions | Produce finalized utterances without retaining large DOM subtrees |
| Participation policy | Client-side wake-name gate | Release addressed turns and bounded follow-ups; suppress ambient output |
| Agent harness | Codex app-server | Start/resume durable context, answer, interrupt, enforce permissions, close |
| Speech output | AVFoundation | Render mono PCM and feed the synthetic Meet microphone |
| Transcript store | Local Markdown + JSONL | Preserve call and private records with timestamps and visibility |
| Sidecar | Token-authenticated loopback HTTP | Show call/private timeline; keep prompts silent; require confirmation to speak |

## Harness portability

The harness boundary receives a question plus recent transcript, agenda, desired action, visibility, and permissions. It returns text and a durable-context identifier. A Claude Code, Cursor, Hermes, Agents SDK, or generic CLI adapter should not need to know how Google Meet is automated.

Codex currently owns one app-server process per meeting agent. Codex permits one active writer per persistent task, so the meeting bridge either creates its own task or resumes a task that is not open elsewhere.

## Transcript source

The stable input path is Meet captions. A mutation observer reads only leaf text nodes, debounces partial captions, filters the agent's own playback window, and deduplicates equivalent wake-name phrases. Reading entire Meet subtrees or polling `captureStream()` is explicitly avoided because both caused severe renderer growth during live testing.

The future audio adapter should prefer a decoded remote-track API (`MediaStreamTrackProcessor`, a native WebRTC sink, or an extension/native-host capture path), then apply track mixing, VAD, transcription, and diarization outside Meet's presentation DOM.

## Private/public invariant

Room transcript and private messages may appear in one operator timeline, but they remain different data classes. A private answer cannot reach audio automatically. Only the explicit `Share with room` → `Speak in meeting` path calls the speech adapter.

## Permission invariant

The default Codex sandbox is read-only with network access and approvals disabled. Spoken turns remain read-only. Even when `--allow-writes` is enabled, only a private request explicitly marked `Prototype` can receive workspace-write permission.

## Persistence

Each launch creates a session directory containing:

- `session.json` — non-secret runtime metadata;
- `transcript.jsonl` and `transcript.md` — room-visible conversation;
- `private.jsonl` and `private.md` — private operator exchange;
- generated speech files when the local speech adapter is used.

All session data and the dedicated browser profile live under ignored `data/` paths.

## Roadmap

1. Stable raw-audio transcript adapter with VAD and interruption semantics.
2. Speaker labeling and diarization.
3. Additional durable harness adapters.
4. Cross-platform TTS and audio-device support.
5. Hosted browser workers and calendar-driven launch.
6. Stronger recovery supervision for browser crashes and meeting reconnects.
