/* Offline test for model-stop-recovery extension.
 * Loads the real extension via jiti and replays the actual dead session
 * (01a0aa2b-...) plus synthetic edge cases against mock pi APIs. */
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const PI = process.env.PI_ROOT ||
  "/home/user/.nvm/versions/node/v24.17.0/lib/node_modules/@earendil-works/pi-coding-agent";
const EXT = path.join(__dirname, "index.ts");
// Regression fixture: a real session that died on this failure mode
// (leaf = empty assistant after a rejected `edit` call). Override with
// SESSION_FILE=... to test another session.
const SESSION = process.env.SESSION_FILE || path.join(__dirname, "fixture-dead-session.jsonl");

const piRequire = createRequire(path.join(PI, "package.json"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(__filename);

// ---- session branch reconstruction (mimics SessionManager.getBranch) ----
function loadBranch(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = new Map(lines.map((e) => [e.id, e]));
  const leaf = lines[lines.length - 1];
  const chain = [];
  let cur = leaf;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return chain.reverse();
}
const branch = loadBranch(SESSION);
const branchMsgs = branch.filter((e) => e.type === "message").map((e) => e.message);

// ---- mocks ----
function makeApi() {
  const api = { handlers: {}, sent: [] };
  api.on = (ev, h) => { (api.handlers[ev] ??= []).push(h); };
  api.sendUserMessage = (text, opts) => { api.sent.push({ text, opts }); throw null; }; // placeholder, overridden below
  return api;
}
function makeCtx(entries, { pending = false, idle = true, ui = true, signal } = {}) {
  const notes = [];
  return {
    notes,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    hasUI: ui,
    ui: { notify: (msg, level) => notes.push(`${level}: ${msg}`) },
    sessionManager: { getBranch: () => entries },
    signal,
  };
}
async function fire(api, ev, ctx, event = {}) {
  return Promise.all((api.handlers[ev] || []).map((h) => h(event, ctx)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}
const role = (m) => m && m.role;

(async () => {
  const mod = await jiti.import(EXT);
  const factory = mod.default;

  // ============ T1: context filter on the REAL dead session tail ============
  console.log("T1 context filter (real dead session)");
  {
    const api = makeApi();
    api.sendUserMessage = () => {};
    factory(api);
    const ctx = makeCtx(branch);
    const res = (await fire(api, "context", ctx, { messages: branchMsgs }))[0];
    check("returns a modified context", res && Array.isArray(res.messages));
    const msgs = res?.messages ?? [];
    const last = msgs[msgs.length - 1];
    check("tail is the healthy bash (grep) tool result", role(last) === "toolResult" && last.toolName === "bash",
      `got ${JSON.stringify(last && { role: last.role, toolName: last.toolName, stopReason: last.stopReason }).slice(0, 120)}`);
    // The real session has 4 flaky moments: 3 empty completions + 2 bad-edit
    // pairs (one of them at the tail) = 8 dead messages total.
    const BAD_IDS = ["chatcmpl-tool-9ff331ebafaa2d60", "chatcmpl-tool-a0280d0e26cfc37d"];
    check("all empty assistant messages removed", !msgs.some((m) => role(m) === "assistant" && m.content.length === 0));
    check("both bad edit tool calls removed",
      !msgs.some((m) => role(m) === "assistant" && m.content.some((p) => p.type === "toolCall" && BAD_IDS.includes(p.id))));
    check("healthy edit calls in history preserved",
      msgs.filter((m) => role(m) === "assistant" && m.content.some((p) => p.type === "toolCall" && p.name === "edit"))
        .length === branchMsgs.filter((m) => role(m) === "assistant" && m.content.some((p) => p.type === "toolCall" && p.name === "edit"))
        .length - 2);
    check("validation-error results removed", !msgs.some((m) => role(m) === "toolResult" &&
      String(m.content?.[0]?.text ?? "").startsWith("Validation failed")));
    check("exactly the 8 dead messages stripped", msgs.length === branchMsgs.length - 8,
      `${msgs.length} vs ${branchMsgs.length}`);
    check("user messages untouched", msgs.filter((m) => role(m) === "user").length === branchMsgs.filter((m) => role(m) === "user").length);
  }

  // ============ T2: agent_settled on dead tail sends nudge ============
  console.log("T2 settled on dead tail -> auto nudge");
  {
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (text, opts) => sent.push({ text, opts });
    factory(api);
    const ctx = makeCtx(branch);
    await fire(api, "agent_start", ctx, {});
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("exactly one nudge sent", sent.length === 1, `got ${sent.length}`);
    check("nudge is marked user message", sent[0]?.text?.startsWith("[pi-recovery]"));
    check("nudge names the edit tool", sent[0]?.text?.includes("'edit'"));
    check("warning notification shown", ctx.notes.some((n) => n.startsWith("warning:") && n.includes("pi-recovery")));
  }

  // ============ T3: aborted run -> no nudge ============
  console.log("T3 aborted run -> no nudge");
  {
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (t) => sent.push(t);
    factory(api);
    const ac = new AbortController();
    const ctx = makeCtx(branch, { signal: ac.signal });
    await fire(api, "agent_start", ctx, {});
    ac.abort();
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("no nudge after Esc", sent.length === 0, `got ${sent.length}`);

    // already-aborted signal variant
    const api2 = makeApi();
    const sent2 = [];
    api2.sendUserMessage = (t) => sent2.push(t);
    factory(api2);
    const ac2 = new AbortController();
    ac2.abort();
    const ctx2 = makeCtx(branch, { signal: ac2.signal });
    await fire(api2, "agent_start", ctx2, {});
    await fire(api2, "agent_settled", ctx2, {});
    await sleep(250);
    check("no nudge on pre-aborted signal", sent2.length === 0);
  }

  // ============ T4: max retries reached -> stop + error notify ============
  console.log("T4 retry cap");
  {
    const nudge = { role: "user", content: "[pi-recovery] earlier attempt", timestamp: 1 };
    const dead = [
      ...branchMsgs,
      nudge, nudge, nudge,
      { role: "assistant", content: [], api: "openai-completions", provider: "medrocket", model: "x",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 2 },
    ];
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (t) => sent.push(t);
    factory(api);
    const ctx = makeCtx(dead.map((m) => ({ type: "message", message: m })));
    await fire(api, "agent_start", ctx, {});
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("no nudge at cap", sent.length === 0, `got ${sent.length}`);
    check("error notification at cap", ctx.notes.some((n) => n.startsWith("error:") && n.includes("auto-recovery stopped")));
  }

  // ============ T5: healthy tail -> nothing happens ============
  console.log("T5 healthy tail -> no-op");
  {
    // fully synthetic healthy history (the real session contains flaky moments)
    const healthy = [
      { role: "user", content: "go on", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "ok1", name: "bash", arguments: { command: "ls" } }],
        api: "openai-completions", provider: "medrocket", model: "x",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: 1,
      },
      { role: "toolResult", toolCallId: "ok1", toolName: "bash",
        content: [{ type: "text", text: "file1" }], isError: false, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "All done." }], api: "openai-completions",
        provider: "medrocket", model: "x",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: 3 },
    ];
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (t) => sent.push(t);
    factory(api);
    const entries = healthy.map((m) => ({ type: "message", message: m }));
    const ctx = makeCtx(entries);
    const res = (await fire(api, "context", ctx, { messages: healthy }))[0];
    check("context filter no-op (undefined)", res === undefined);
    await fire(api, "agent_start", ctx, {});
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("no nudge on healthy tail", sent.length === 0);
    check("no notifications", ctx.notes.length === 0, JSON.stringify(ctx.notes));
  }

  // ============ T6: parallel calls, one bad one good ============
  console.log("T6 parallel tool calls (one bad)");
  {
    const msgs = [
      { role: "user", content: "do both", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-bad", name: "edit", arguments: {} },
          { type: "toolCall", id: "call-good", name: "bash", arguments: { command: "ls" } },
        ],
        api: "openai-completions", provider: "medrocket", model: "x",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: 1,
      },
      { role: "toolResult", toolCallId: "call-bad", toolName: "edit",
        content: [{ type: "text", text: 'Validation failed for tool "edit":\n  - path: must have required properties path, edits' }],
        isError: true, timestamp: 2 },
      { role: "toolResult", toolCallId: "call-good", toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2" }], isError: false, timestamp: 3 },
    ];
    const api = makeApi();
    api.sendUserMessage = () => {};
    factory(api);
    const ctx = makeCtx(msgs.map((m) => ({ type: "message", message: m })));
    const res = (await fire(api, "context", ctx, { messages: msgs }))[0];
    const out = res?.messages ?? [];
    check("bad pair removed, good pair kept", out.length === 3, `got ${out.length}`);
    const asst = out.find((m) => role(m) === "assistant");
    check("assistant keeps only good tool call",
      asst?.content?.length === 1 && asst.content[0].id === "call-good");
    check("good tool result kept", out.some((m) => role(m) === "toolResult" && m.toolCallId === "call-good"));
    check("bad tool result gone", !out.some((m) => role(m) === "toolResult" && m.toolCallId === "call-bad"));
  }

  // ============ T7: validation-error tail (model never responded) ============
  console.log("T7 validation-error tail -> nudge");
  {
    const tail = [
      ...branchMsgs.slice(0, branchMsgs.length - 3),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "write", arguments: {} }],
        api: "openai-completions", provider: "medrocket", model: "x",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: 1,
      },
      { role: "toolResult", toolCallId: "c1", toolName: "write",
        content: [{ type: "text", text: 'Validation failed for tool "write":\n  - path: required' }],
        isError: true, timestamp: 2 },
    ];
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (t, o) => sent.push({ t, o });
    factory(api);
    const ctx = makeCtx(tail.map((m) => ({ type: "message", message: m })));
    await fire(api, "agent_start", ctx, {});
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("one nudge", sent.length === 1, `got ${sent.length}`);
    check("names 'write' tool + validation detail",
      sent[0]?.t?.includes("'write'") && sent[0]?.t?.includes("path: required"));
  }

  // ============ T8: pending user input -> no nudge ============
  console.log("T8 pending user input -> skip");
  {
    const api = makeApi();
    const sent = [];
    api.sendUserMessage = (t) => sent.push(t);
    factory(api);
    const ctx = makeCtx(branch, { pending: true });
    await fire(api, "agent_start", ctx, {});
    await fire(api, "agent_settled", ctx, {});
    await sleep(250);
    check("no nudge when user queued input", sent.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
