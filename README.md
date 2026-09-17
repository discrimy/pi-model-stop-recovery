# pi-model-stop-recovery

A pi extension that auto-recovers from a flaky model's "sudden stop"
behavior (observed with Qwen 27B via an OpenAI-compatible proxy):

1. **Empty completion** — the model returns an assistant message with no text
   and no tool calls; pi's loop has nothing to do and the session dies
   silently.
2. **Invalid tool call** — the model emits a tool call whose arguments fail
   pi's schema validation (e.g. `edit` with `{}`); the error frequently makes
   the model return an empty completion next.

## What it does

- **Context filter** (`context` event, before every LLM call): strips the dead
  material — validation-error tool results, the tool calls that produced them,
  and assistant messages with no text/tool calls. The session file is not
  modified; the model sees the conversation ending at the state before the
  failed attempt. Also heals manually-resumed dead sessions.
- **Auto-resume** (`agent_settled` event — the moment pi stops continuing on
  its own): if the run died on the patterns above, sends a marked
  `[pi-recovery]` user message that resumes the work, no interaction needed.
- **Guards**: skips Esc-aborted runs, skips when you have pending input,
  hard-stops after 3 nudges per branch (+ error notification).

## Install

Add the project to `~/.pi/agent/settings.json` (global, all projects):

```json
{
  "extensions": ["/home/user/Projects/pi-model-stop-recovery"]
}
```

Then `/reload` in pi (or start a new session). No dependencies, no build —
pi loads `index.ts` directly via jiti.

To use in one project only, put the same entry in that project's
`.pi/settings.json` instead.

## Test

```bash
node test.cjs
```

Offline: loads the extension via jiti and replays the committed dead-session
fixture `fixture-dead-session.jsonl` (a real session that died on this failure
mode; override with `SESSION_FILE=...`, pi install root with `PI_ROOT=...`).
26 assertions: filter correctness, auto-nudge, abort cap, retry cap,
healthy-session no-op, parallel tool calls.

## Config

Constants at the top of `index.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `MAX_AUTORETRIES` | `3` | max `[pi-recovery]` nudges per branch |
| `RESUME_DELAY_MS` | `100` | delay before the resume message |
