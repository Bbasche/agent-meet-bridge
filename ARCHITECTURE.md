# Agent Meet Bridge architecture

Agent Meet Bridge treats the meeting, transcript, participation policy, agent harness, speech output, persistence, and private UI as separate adapters. Codex, Claude Code, Cursor, Hermes, Pi, and a generic CLI bridge implement one harness contract; local speech, OpenAI Realtime, Grok Voice, and task-scoped Codex Realtime implement one voice boundary.

## Runtime topology

```text
Google Meet
  ├─ dedicated Chrome profile
  ├─ camera blocked and control verified off
  ├─ captions or raw audio ───────┐
  └─ synthetic microphone ◀── TTS│
                                  ▼
                       addressed-turn policy
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             agent harness              transcript store
             durable context            Markdown + JSONL
                    ▲
                    │ private only
             localhost sidecar
                    │ fixed target only
                    └──────────────▶ Notion notes sink
```

## Adapter contracts

| Boundary | Current adapter | Required behavior |
| --- | --- | --- |
| Meeting transport | Playwright + Chrome | Join, expose caption text, inject agent audio, force camera off, leave cleanly |
| Transcript input | Meet live captions | Produce finalized utterances without retaining large DOM subtrees |
| Participation policy | Client-side wake-name gate | Release addressed turns and bounded follow-ups; suppress ambient output |
| Agent harness | Codex / Claude Code / Cursor / Hermes / Pi | Start/resume durable context, answer, interrupt, enforce permissions, close |
| Speech output | Local / OpenAI / Grok / Codex | Stream mono PCM and feed the synthetic Meet microphone |
| Transcript store | Local Markdown + JSONL | Preserve call and private records with timestamps and visibility |
| Notion notes sink | Fixed-page Notion Blocks API | Validate fixed-schema agenda/running/debrief batches; persist restart-safe cursor/idempotency state; fail closed independently |
| Sidecar | Token-authenticated loopback HTTP | Show call/private timeline; keep prompts silent; require confirmation to speak; clear token-bearing URL fragments |

## Harness portability

The harness boundary receives a self-contained prompt containing the question, recent transcript, agenda, desired action, visibility, and effective permissions. It returns text and a durable-context identifier. Harnesses do not know how Google Meet is automated.

- Codex owns one app-server process and one durable task.
- Claude Code uses JSON output plus an explicit UUID session and resumes it on subsequent turns.
- Cursor uses JSON print mode, Ask mode for read turns, durable session resume, and Agent+force only for authorized private prototype turns.
- Hermes uses one-shot sessions; each resume produces a successor ID, which the adapter resolves and carries forward.
- Pi uses JSON event mode, explicit session IDs, and a built-in tool allowlist.
- Generic CLI launches an explicit executable with an argument array (never a shell string) and can normalize text or JSON results.

Voice providers receive the same normalized callbacks for input PCM, output PCM, transcripts, barge-in, status, and `ask_agent` tool calls. Provider definitions own endpoint URLs, session shapes, sample rates, voices, and forced-speech events.

## Transcript source

The local default uses Meet captions. A mutation observer reads only leaf text nodes, debounces partial captions, filters the agent's own playback, and deduplicates equivalent wake-name phrases. A pending candidate is flushed immediately when the detected speaker changes, so a rapid second speaker cannot overwrite the first while the settle timer is running. Both browser exact-key suppression and response-boundary semantic dedupe are speaker-scoped and time-bounded. Semantic comparison normalizes exact wake/filler variants and one observed, tightly constrained proper-name ASR correction, but rejects negation and broad content-word similarity. This deliberately permits a duplicate response to two corrected negative hypotheses rather than risking the loss of a meaning reversal. Reading entire Meet subtrees or polling `captureStream()` is explicitly avoided because both caused severe renderer growth during live testing.

Realtime providers use a decoded remote-track path. An init script intercepts each audio `RTCPeerConnection` track, mixes sources through Web Audio, extracts 100 ms PCM frames in an `AudioWorklet`, and forwards them outside Meet's presentation DOM. A synthetic loopback integration check verifies non-silent 48 kHz PCM capture. Per-speaker track identity and diarization are not yet retained.

## Private/public invariant

Room transcript and private messages may appear in one operator timeline, but they remain different data classes. A private answer cannot reach audio automatically. Only the explicit `Share with room` → `Speak in meeting` path calls the speech adapter.

The sidecar applies display-only exact-duplicate suppression per speaker for eight seconds. Suppressed rows do not extend that window, so a legitimate later repetition is shown, and this presentation filter never changes the authoritative transcript store.

Room-triggered harness analysis is a private data class too. The provider may use a bounded result to form a concise spoken answer, but the detailed tool result is stored only in the private audit stream. The room transcript contains the provider's final spoken transcript, never hidden tool output.

## Permission invariant

Spoken turns remain read-only. Even when `--allow-writes` is enabled, only a private request explicitly marked `Prototype` can receive workspace-write permission. Codex uses a read-only sandbox; Claude Code and Pi receive constrained read-tool sets; Cursor uses Ask mode; Hermes read-only turns use safe mode because its one-shot mode bypasses approvals. The generic adapter cannot enforce the supplied executable's internal sandbox and reports that limitation explicitly.

Notion notes are a separate launch-time capability. `--notion-notes`, a syntactically valid fixed `--notion-page-id`, and an operator-supplied stable `--notion-meeting-id` are required. The integration token is injected from runtime custody outside captions and model context; repository-local `.env` values for this token are ignored, and the bridge removes the inherited token from the process environment before launching any agent harness. Caption text is bounded literal content and cannot provide a destination, section, or control field.

The deterministic sink serializes a fixed-schema agenda, bounded running-note deltas, and final public debrief. The richer local debrief may include private sidecar context; the Notion debrief is derived separately and deterministically from public transcript entries only. State uses a stable private namespace keyed by hashes of page and meeting identity, so a fresh CLI process resumes the same cursor without sharing idempotency across separate meetings. Every cursor must be exactly contiguous. State and audit metadata are persisted before network access; uncertain writes, gaps, conflicts, and exhausted rate limits halt the sink without interrupting transcript persistence or meeting transport. A valid Notion `Retry-After` value is capped before one safe 429 retry. The sidecar reports actual written entry count, distinct from its local prototype-write permission.

## Persistence

Each launch creates a session directory containing:

- `session.json` — non-secret runtime metadata;
- `transcript.jsonl` and `transcript.md` — room-visible conversation;
- `private.jsonl` and `private.md` — private operator exchange;
- `context.md` — a bounded live snapshot of participants, questions, candidate commitments, and recent chronology;
- generated speech files when the local speech adapter is used.

Fixed-page notes keep `state.json` and `audit.jsonl` outside the random session directory under `data/notion-notes-state/<page-hash>/<meeting-hash>/`. They contain cursor, counts, hashes, and error state but no credentials, raw captions, agenda text, or debrief text.

All session data and the dedicated browser profile live under ignored `data/` paths.

## Roadmap

1. Speaker labeling and diarization for the raw-audio transcript adapter.
2. Offline streaming transcription without Meet captions.
3. Additional durable harness adapters for agent SDKs as their permission contracts mature.
4. Cross-platform TTS and audio-device support.
5. Hosted browser workers and calendar-driven launch.
6. Operator approval cards for write requests raised from the room.
