"use strict";
/**
 * openai-anthropic.cjs — OpenAI chat.completions body → Anthropic Messages
 * request parts, for the HTTP engine. Unlike otterly's openaiToClaudeInput
 * (which flattens everything into one prompt string for `claude -p`), this
 * keeps roles, tool calls and tool results as real Messages-API blocks.
 */

const JSON_RULE = "You must respond with valid JSON only. No markdown, no explanation, no code fences, just a JSON object.";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p && p.type === "text" ? p.text || "" : "")).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function imageBlock(part) {
  const url = typeof part.image_url === "string" ? part.image_url : (part.image_url && part.image_url.url) || "";
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function userBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (typeof part === "string") out.push({ type: "text", text: part });
    else if (part && part.type === "text" && part.text) out.push({ type: "text", text: part.text });
    else if (part && part.type === "image_url") { const b = imageBlock(part); if (b) out.push(b); }
  }
  return out;
}

function parseArgs(s) {
  if (s && typeof s === "object") return s;
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
}

function push(messages, role, blocks) {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function convertTools(tools) {
  return tools
    .map((t) => (t && t.function) || t)
    .filter((f) => f && f.name)
    .map((f) => ({
      name: f.name,
      description: f.description || "",
      input_schema: f.parameters || { type: "object", properties: {} },
    }));
}

function convertToolChoice(tc) {
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc && typeof tc === "object" && tc.function && tc.function.name) return { type: "tool", name: tc.function.name };
  return undefined;
}

function toAnthropic(body) {
  const systems = [];
  const messages = [];
  for (const msg of body.messages || []) {
    if (!msg) continue;
    switch (msg.role) {
      case "system":
      case "developer": {
        const t = textOf(msg.content);
        if (t) systems.push(t);
        break;
      }
      case "user":
        push(messages, "user", userBlocks(msg.content));
        break;
      case "assistant": {
        const blocks = [];
        const t = textOf(msg.content);
        if (t) blocks.push({ type: "text", text: t });
        for (const tc of msg.tool_calls || []) {
          if (!tc || !tc.function) continue;
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
        }
        push(messages, "assistant", blocks);
        break;
      }
      case "tool":
        push(messages, "user", [{ type: "tool_result", tool_use_id: msg.tool_call_id, content: textOf(msg.content) }]);
        break;
      default:
        break;
    }
  }
  if (body.response_format && body.response_format.type === "json_object") systems.push(JSON_RULE);

  const out = { system: systems.length ? systems.join("\n\n") : null, messages };
  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== "none";
  if (wantsTools) {
    out.tools = convertTools(body.tools);
    const choice = convertToolChoice(body.tool_choice);
    if (choice) out.tool_choice = choice;
  }
  return out;
}

function toolUseToOpenAI(block) {
  return { id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } };
}

module.exports = { toAnthropic, toolUseToOpenAI, JSON_RULE };
