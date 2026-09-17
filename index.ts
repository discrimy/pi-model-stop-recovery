/**
 * model-stop-recovery — auto-recovery for flaky models that "suddenly stop"
 * mid-task (observed with Qwen via OpenAI-compatible proxies).
 *
 * Failure patterns handled (both end the pi run silently, with no error):
 *   1. Empty completion — the model returns an assistant message with no text
 *      and no tool calls (0 output tokens). pi's loop has nothing to do and
 *      the session just dies.
 *   2. Invalid tool call — the model emits a tool call whose arguments fail
 *      pi's schema validation (observed: `edit` with arguments `{}`). The
 *      validation error frequently makes the model return an empty
 *      completion next, which then kills the session.
 *
 * Recovery, fully automatic (no user interaction):
 *   - "context" event (before every LLM call): strips the dead material from
 *     what the model sees — validation-error tool results, the tool calls
 *     that produced them, and assistant messages with no text/tool calls.
 *     The session file is NOT modified; the model simply sees the
 *     conversation ending at the state before the failed attempt. This also
 *     heals manually-resumed dead sessions on their next LLM call.
 *   - "agent_settled" event (the exact moment pi decides it will not
 *     continue on its own): if the run died on the patterns above, a marked
 *     "[pi-recovery]" user message is sent that resumes the work.
 *
 * Guards:
 *   - skipped when the run was aborted (Esc) — tracked via the run signal
 *   - skipped when the user already has pending input
 *   - hard stop after MAX_AUTORETRIES nudges per branch (+ notification)
 *   - zero-overhead no-op fast path when nothing is wrong
 */
import type { ExtensionAPI, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

const MARKER = "[pi-recovery]";
const MAX_AUTORETRIES = 3;
const RESUME_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

function resultText(m: ToolResultMessage): string {
  return m.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** True for pi's schema-validation error results ("Validation failed for tool ..."). */
export function isValidationError(m: ToolResultMessage): boolean {
  return m.isError && resultText(m).trimStart().startsWith("Validation failed for tool");
}

/** Tool-call ids that produced a validation error — the dead material to hide. */
export function badToolCallIds(messages: AgentMessage[]): Set<string> {
  const bad = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult" && isValidationError(m)) bad.add(m.toolCallId);
  }
  return bad;
}

/** An assistant message is "alive" if it has non-empty text or a non-bad tool call. */
export function hasSubstance(m: AssistantMessage, bad: Set<string>): boolean {
  return m.content.some(
    (p) => (p.type === "text" && p.text.trim() !== "") || (p.type === "toolCall" && !bad.has(p.id)),
  );
}

/**
 * Strip dead material from the message array sent to the model.
 * Returns a new array when anything changed, or null when nothing was dead.
 * User messages, custom messages and healthy assistant messages pass through
 * untouched (thinking-only assistant messages are dropped — they end runs the
 * same way empty ones do).
 */
export function stripDead(messages: AgentMessage[]): AgentMessage[] | null {
  const bad = badToolCallIds(messages);
  let changed = false;
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "toolResult") {
      if (bad.has(m.toolCallId)) {
        changed = true;
        continue;
      }
      out.push(m);
    } else if (m.role === "assistant") {
      const kept = m.content.filter((p) => !(p.type === "toolCall" && bad.has(p.id)));
      const alive = kept.some((p) => (p.type === "text" && p.text.trim() !== "") || p.type === "toolCall");
      if (!alive) {
        changed = true;
        continue;
      }
      if (kept.length !== m.content.length) {
        changed = true;
        out.push({ ...m, content: kept });
      } else {
        out.push(m);
      }
    } else {
      out.push(m);
    }
  }
  return changed ? out : null;
}

interface Verdict {
  kind: "empty-response" | "validation-tail";
  toolName?: string;
  detail?: string;
}

/**
 * Decide whether the run just settled at a dead end caused by the flaky
 * model. Only two objective patterns:
 *   - last message is an assistant with no visible content that "stopped"
 *   - last message is a validation-error tool result (model never responded)
 */
export function assessTail(messages: AgentMessage[]): Verdict | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const bad = badToolCallIds(messages);

  if (last.role === "assistant") {
    const silentStop = last.stopReason === "stop" || last.stopReason === "length";
    if (silentStop && !hasSubstance(last, bad)) {
      // Name the tool the model was attempting, if it died right after a
      // rejected call: walk back to the most recent validation error.
      let toolName: string | undefined;
      for (let i = messages.length - 2; i >= 0; i--) {
        const p = messages[i];
        if (p.role === "toolResult" && isValidationError(p)) {
          toolName = p.toolName;
          break;
        }
        if (p.role === "user") break;
      }
      return { kind: "empty-response", toolName };
    }
    return null;
  }

  if (last.role === "toolResult" && isValidationError(last)) {
    const detail = resultText(last)
      .trim()
      .split("\n")
      .slice(0, 2)
      .join(" ")
      .slice(0, 240);
    return { kind: "validation-tail", toolName: last.toolName, detail };
  }

  return null;
}

export function nudgeText(v: Verdict): string {
  if (v.kind === "empty-response") {
    const hint = v.toolName ? ` The tool call you were attempting was '${v.toolName}'.` : "";
    return (
      `${MARKER} The previous model response was empty (no text, no tool calls) — a provider failure ` +
      `that ended the run, not a completed task.${hint} The failed attempt was removed from the ` +
      `conversation context. Continue the task from where it left off and re-issue the tool call ` +
      `with complete, valid arguments.`
    );
  }
  return (
    `${MARKER} Your last tool call '${v.toolName}' was rejected by argument validation: ` +
    `${v.detail ?? "invalid arguments"}. This is a provider serialization failure, not a task problem. ` +
    `The failed attempt was removed from the conversation context. Re-issue the tool call with ` +
    `complete, valid arguments.`
  );
}

export function countNudges(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith(MARKER)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

type SessionLike = { sessionManager: { getBranch(): SessionEntry[] } };

export default function (pi: ExtensionAPI) {
  let abortedThisRun = false;

  const branchMessages = (ctx: SessionLike): AgentMessage[] =>
    ctx.sessionManager
      .getBranch()
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);

  const notify = (ctx: { hasUI: boolean; ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }, msg: string, level: "info" | "warning" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(msg, level);
  };

  const watchAbort = (signal?: AbortSignal) => {
    if (!signal) return;
    if (signal.aborted) {
      abortedThisRun = true;
      return;
    }
    signal.addEventListener("abort", () => {
      abortedThisRun = true;
    }, { once: true });
  };

  // "Rollback": hide the dead material from every LLM call. The session file
  // is untouched; only the per-call context is filtered.
  pi.on("context", (event) => {
    const stripped = stripDead(event.messages);
    return stripped ? { messages: stripped } : undefined;
  });

  // Track user aborts so we never nudge a run the user Esc'd.
  pi.on("agent_start", (_event, ctx) => {
    abortedThisRun = false;
    watchAbort(ctx.signal);
  });
  pi.on("turn_start", (_event, ctx) => {
    watchAbort(ctx.signal);
  });

  // Resume when pi has given up.
  pi.on("agent_settled", (_event, ctx) => {
    if (abortedThisRun) {
      abortedThisRun = false;
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

    const messages = branchMessages(ctx);
    const verdict = assessTail(messages);
    if (!verdict) return;

    const prior = countNudges(messages);
    if (prior >= MAX_AUTORETRIES) {
      notify(
        ctx,
        `pi-recovery: model still failing after ${prior} auto-retries — auto-recovery stopped, retry manually`,
        "error",
      );
      return;
    }

    const reason = verdict.kind === "empty-response" ? "an empty model response" : `rejected tool call '${verdict.toolName}'`;
    notify(ctx, `pi-recovery: run died on ${reason} — retrying (${prior + 1}/${MAX_AUTORETRIES})`, "warning");

    const text = nudgeText(verdict);
    setTimeout(() => {
      try {
        if (ctx.isIdle()) pi.sendUserMessage(text);
        else pi.sendUserMessage(text, { deliverAs: "followUp" });
      } catch (err) {
        notify(ctx, `pi-recovery: could not resume: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }, RESUME_DELAY_MS);
  });
}
