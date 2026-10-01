"use strict";
// anthropic-usage.cjs — read token usage and tool names out of an anthropic
// /v1/messages response while it streams past. Read-only: the caller forwards
// the original chunks untouched and feeds a copy here. Nothing in this module
// throws; an unparseable response just yields null counts.

const MAX_JSON = 20 * 1024 * 1024; // non-streaming bodies larger than this are not parsed

function createTap(contentType) {
  const sse = /text\/event-stream/i.test(contentType || "");
  const out = { inputTokens: null, outputTokens: null, cacheCreationTokens: null, cacheReadTokens: null, tools: [] };
  const decoder = new TextDecoder("utf-8"); // stream mode keeps split multibyte characters intact
  let buf = "";
  let dropped = false;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  function usage(u) {
    if (!u || typeof u !== "object") return;
    if (num(u.input_tokens) !== undefined) out.inputTokens = u.input_tokens;
    if (num(u.output_tokens) !== undefined) out.outputTokens = u.output_tokens;
    if (num(u.cache_creation_input_tokens) !== undefined) out.cacheCreationTokens = u.cache_creation_input_tokens;
    if (num(u.cache_read_input_tokens) !== undefined) out.cacheReadTokens = u.cache_read_input_tokens;
  }
  function toolBlock(b) {
    if (b && b.type === "tool_use" && typeof b.name === "string") out.tools.push(b.name);
  }
  function event(data) {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "message_start" && ev.message) usage(ev.message.usage);
    else if (ev.type === "message_delta") usage(ev.usage);
    else if (ev.type === "content_block_start") toolBlock(ev.content_block);
  }

  return {
    push(chunk) {
      try {
        if (dropped || !chunk) return;
        buf += decoder.decode(chunk, { stream: true });
        if (!sse) {
          if (buf.length > MAX_JSON) { buf = ""; dropped = true; }
          return;
        }
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line.startsWith("data:")) event(line.slice(5).trim());
        }
      } catch { /* a tap must never break the response */ }
    },
    result() {
      try {
        if (!sse && !dropped && buf) {
          const j = JSON.parse(buf);
          if (j && typeof j === "object") {
            usage(j.usage);
            if (Array.isArray(j.content)) j.content.forEach(toolBlock);
          }
        }
      } catch { /* not JSON: leave the nulls */ }
      return { ...out, tools: out.tools.slice() };
    },
  };
}

module.exports = { createTap, MAX_JSON };
