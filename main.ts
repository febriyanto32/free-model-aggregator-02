// Free Model Aggregator — one server that answers OpenAI and Anthropic
// completion requests with live completions from free OpenRouter models,
// dialled through the grader's gateway on Chat Completions.
//
// Node 22, standard library only. No wall clock and no unseeded randomness:
// every choice is a function of the brief, the request and the gateway's
// answers, so a replay leaves the same state export.

import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// The free-model catalog, taken from the trial brief's live catalog.
// Each row is dialable as "openrouter/<upstream id>:free" and priced $0.
// rating_milli is the house quality rating, higher is stronger.
// ---------------------------------------------------------------------------
const MODELS = [
  { id: "openrouter/thinkingmachines/inkling-2-small:free", rating: 1475, context: 1048576, tools: true, vision: true, json: false },
  { id: "openrouter/nvidia/nemotron-3.5-super-vl:free", rating: 1303, context: 1000000, tools: true, vision: true, json: true },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", rating: 1285, context: 1000000, tools: true, vision: false, json: false },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free", rating: 1221, context: 1000000, tools: true, vision: false, json: false },
  { id: "openrouter/google/gemma-4-31b-it:free", rating: 1210, context: 262144, tools: true, vision: true, json: true },
  { id: "openrouter/cohere/north-mini-code:free", rating: 1200, context: 256000, tools: true, vision: false, json: false },
  { id: "openrouter/baidu/ernie-5.5-flash-preview:free", rating: 1150, context: 1024000, tools: true, vision: false, json: true },
  { id: "openrouter/dots-studio/dots-3-note-preview:free", rating: 1150, context: 512000, tools: true, vision: true, json: true },
  { id: "openrouter/google/gemma-4-26b-a4b-it:free", rating: 1150, context: 262144, tools: true, vision: true, json: true },
  { id: "openrouter/inclusionai/ling-3.2-flash:free", rating: 1150, context: 1048576, tools: true, vision: true, json: true },
  { id: "openrouter/liquid/lfm-3-1.7b:free", rating: 1150, context: 262144, tools: true, vision: false, json: true },
  { id: "openrouter/particle-ai/particle-1:free", rating: 1150, context: 1048576, tools: true, vision: true, json: true },
  { id: "openrouter/recursive/flint-v1.0:free", rating: 1150, context: 262144, tools: true, vision: false, json: true },
  { id: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", rating: 1150, context: 256000, tools: true, vision: true, json: false },
];

const CATALOG = {
  providers: [
    {
      id: "openrouter",
      base_url: "https://openrouter.ai/api/v1",
      key_env: "OPENROUTER_API_KEY",
      wire: "openai",
      models: MODELS.map((m) => ({ id: m.id, free: true, context_length: m.context })),
    },
  ],
};
const CATALOG_TEXT = JSON.stringify(CATALOG);

if (process.argv.includes("--list")) {
  process.stdout.write(CATALOG_TEXT + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Deterministic helpers (seeded from the trial seed, never the wall clock).
// ---------------------------------------------------------------------------
function fnvHex(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function seededRng(seedText) {
  let s = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) {
    s ^= seedText.charCodeAt(i);
    s = Math.imul(s, 0x01000193) >>> 0;
  }
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}
// The seed exists so any tie-break that needs randomness is reproducible.
const rng = seededRng(process.env.MAKEFUN_TRIAL_SEED || "free-model-aggregator-02");
void rng;

// Models that refused twice in a row are spent for this trial.
const spentModels = new Set();

// Rank the models that can serve a prompt: best rating first, id as the
// deterministic tie-break. A JSON-mode prompt needs a json:true model; a
// tools prompt needs a tools:true model.
function candidatesFor(needsJson, needsTools) {
  return MODELS.filter((m) => (!needsJson || m.json) && (!needsTools || m.tools))
    .filter((m) => !spentModels.has(m.id))
    .slice()
    .sort((a, b) => (b.rating - a.rating) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Canonical request: both client wires translate into this shape, which is
// then sent to the gateway as a Chat Completions body.
// ---------------------------------------------------------------------------
function textOfParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      if (part.type === "text" && typeof part.text === "string") out.push(part.text);
      else if (part.type === "input_text" && typeof part.text === "string") out.push(part.text);
      else if (typeof part.text === "string") out.push(part.text);
    }
  }
  return out.join("");
}

function openAiToolsFromAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    }));
}

function canonicalFromOpenAI(body) {
  const messages = [];
  let system = "";
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system") { system += textOfParts(m.content); continue; }
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      messages.push({ role: "assistant", content: textOfParts(m.content) || null, tool_calls: m.tool_calls });
      continue;
    }
    messages.push({ role: m.role, content: textOfParts(m.content) });
  }
  const cap = body.max_tokens ?? body.max_completion_tokens ?? null;
  return {
    messages,
    system,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    json: !!(body.response_format && body.response_format.type === "json_object"),
    maxTokens: typeof cap === "number" && cap > 0 ? Math.min(cap, 8192) : 1024,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    stream: body.stream === true,
  };
}

function canonicalFromAnthropic(body) {
  const messages = [];
  const system = textOfParts(body.system);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    // The env's Anthropic bodies carry message content as a plain string;
    // the API also allows content blocks. Accept both.
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const toolCalls = [];
      let text = "";
      for (const part of Array.isArray(m.content) ? m.content : []) {
        if (part && part.type === "text") text += part.text || "";
        else if (part && part.type === "tool_use") {
          toolCalls.push({
            id: part.id || ("call_" + fnvHex(JSON.stringify(part))),
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
          });
        }
      }
      if (toolCalls.length > 0) messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      else messages.push({ role: "assistant", content: text });
      continue;
    }
    // user: text parts and tool results become plain text
    const bits = [];
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (typeof part === "string") bits.push(part);
      else if (part && part.type === "text") bits.push(part.text || "");
      else if (part && part.type === "tool_result") bits.push(textOfParts(part.content));
      else if (part && part.type === "image") bits.push("[image]");
    }
    messages.push({ role: "user", content: bits.join("") });
  }
  const cap = body.max_tokens ?? null;
  return {
    messages,
    system,
    tools: openAiToolsFromAnthropic(body.tools),
    json: false,
    maxTokens: typeof cap === "number" && cap > 0 ? Math.min(cap, 8192) : 1024,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    stream: body.stream === true,
  };
}

// ---------------------------------------------------------------------------
// Gateway: one Chat Completions call per attempt, 25 s bound, never the
// Anthropic Messages route for these ids (the gateway refuses it).
// ---------------------------------------------------------------------------
const GATEWAY_URL = (process.env.OPENAI_BASE_URL || "http://llm:8080/v1").replace(/\/$/, "");
const GATEWAY_KEY = process.env.OPENAI_API_KEY || "";

async function dialGateway(modelId, canon) {
  const body = { model: modelId, messages: canon.messages, max_tokens: canon.maxTokens, stream: false };
  if (canon.system) body.messages = [{ role: "system", content: canon.system }, ...canon.messages];
  if (canon.temperature !== undefined) body.temperature = canon.temperature;
  if (canon.tools) body.tools = canon.tools;
  if (canon.json) body.response_format = { type: "json_object" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(GATEWAY_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + GATEWAY_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let code = "upstream_error";
      try {
        const parsed = JSON.parse(text);
        const err = parsed && parsed.error;
        if (err && typeof err.code === "string" && err.code) code = err.code;
        else if (err && typeof err.type === "string" && err.type) code = err.type;
        else if (typeof parsed.code === "string" && parsed.code) code = parsed.code;
      } catch { /* keep the default code */ }
      return { ok: false, status: res.status, code, model: modelId };
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, status: 502, code: "bad_gateway_body", model: modelId }; }
    return { ok: true, status: 200, model: modelId, data: parsed };
  } catch (err) {
    return { ok: false, status: 0, code: err && err.name === "AbortError" ? "timeout" : "gateway_unreachable", model: modelId };
  } finally {
    clearTimeout(timer);
  }
}

// Try the ranked models in order: retry a 429/5xx once on the same model,
// then fail over to the next-best eligible model. A 401 means no key was
// pushed, so no model can serve — give up at once instead of burning calls.
async function serveWithFailover(canon) {
  const failures = [];
  const candidates = candidatesFor(canon.json, !!(canon.tools && canon.tools.length > 0));
  for (const model of candidates) {
    if (failures.length >= 8) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await dialGateway(model.id, canon);
      if (result.ok) return { result, failures, model: model.id };
      failures.push({ status: result.status || 502, code: result.code, model: model.id });
      if (result.status === 401) return { result: null, failures, model: null };
      if (result.status === 400) break; // request-level refusal: next model
      if (result.status !== 429 && !(result.status >= 500)) break;
      if (attempt === 0) continue; // one retry on the same model
      spentModels.add(model.id);
    }
  }
  return { result: null, failures, model: null };
}

// ---------------------------------------------------------------------------
// Answers: the gateway's completion, whole, in the client's own wire.
// The model field always names the id actually dialled.
// ---------------------------------------------------------------------------
function gatewayText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return textOfParts(message.content);
}

function gatewayUsage(data) {
  const usage = data && data.usage && typeof data.usage === "object" ? data.usage : null;
  const input = usage && typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  let output = usage && typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  if (output < 1) output = 1;
  return { input, output };
}

function gatewayStop(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  return choice && typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
}

function openAiAnswer(modelId, data, text) {
  const usage = gatewayUsage(data);
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const out = {
    id: "chatcmpl-" + fnvHex(modelId + text),
    object: "chat.completion",
    created: 0,
    model: modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: gatewayStop(data),
      },
    ],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
  if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    out.choices[0].message.tool_calls = message.tool_calls;
  }
  return out;
}

function anthropicStop(openAiStop) {
  if (openAiStop === "length") return "max_tokens";
  if (openAiStop === "tool_calls") return "tool_use";
  if (openAiStop === "content_filter") return "stop";
  return "end_turn";
}

function anthropicAnswer(modelId, data, text) {
  const usage = gatewayUsage(data);
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = [{ type: "text", text }];
  if (message && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: call.id || ("call_" + fnvHex(text)), name: call.function.name, input });
    }
  }
  return {
    id: "msg_" + fnvHex(modelId + text),
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: anthropicStop(gatewayStop(data)),
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

function sseChunk(payload) {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function openAiStreamBody(modelId, data, text) {
  const usage = gatewayUsage(data);
  const stop = gatewayStop(data);
  const base = {
    id: "chatcmpl-" + fnvHex(modelId + text),
    object: "chat.completion.chunk",
    created: 0,
    model: modelId,
  };
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const firstDelta = { role: "assistant", content: text };
  if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) firstDelta.tool_calls = message.tool_calls;
  let out = "";
  out += sseChunk({ ...base, choices: [{ index: 0, delta: firstDelta, finish_reason: null }] });
  out += sseChunk({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: stop }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  });
  out += "data: [DONE]\n\n";
  return out;
}

function anthropicStreamBody(modelId, data, text) {
  const usage = gatewayUsage(data);
  const stop = anthropicStop(gatewayStop(data));
  const msgId = "msg_" + fnvHex(modelId + text);
  let out = "";
  out += "event: message_start\n" + sseChunk({
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model: modelId,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input, output_tokens: 0 },
    },
  });
  out += "event: content_block_start\n" + sseChunk({
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  });
  out += "event: content_block_delta\n" + sseChunk({
    type: "content_block_delta", index: 0,
    delta: { type: "text_delta", text },
  });
  out += "event: content_block_stop\n" + sseChunk({ type: "content_block_stop", index: 0 });
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  if (message && Array.isArray(message.tool_calls)) {
    let index = 1;
    for (const call of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }
      out += "event: content_block_start\n" + sseChunk({
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: call.id || ("call_" + fnvHex(text)), name: call.function.name, input },
      });
      out += "event: content_block_stop\n" + sseChunk({ type: "content_block_stop", index });
      index++;
    }
  }
  out += "event: message_delta\n" + sseChunk({
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: usage.output },
  });
  out += "event: message_stop\n" + sseChunk({ type: "message_stop" });
  return out;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > 8 * 1024 * 1024) return reject(new Error("body_too_large"));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function failuresHeader(failures) {
  if (!failures || failures.length === 0) return {};
  const rows = failures.slice(0, 8).map((f) => ({
    status: typeof f.status === "number" ? f.status : 502,
    code: typeof f.code === "string" ? f.code : "upstream_error",
    model: typeof f.model === "string" ? f.model : null,
  }));
  return { "x-makefun-upstream-failures": JSON.stringify(rows) };
}

async function handleCompletion(req, res, wire) {
  let raw;
  try { raw = await readBody(req); } catch {
    sendJson(res, 413, { error: { message: "request body too large", type: "invalid_request_error", code: "request_too_large" } });
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    sendJson(res, 400, { error: { message: "request body is not JSON", type: "invalid_request_error", code: "invalid_json" } });
    return;
  }
  const canon = wire === "openai" ? canonicalFromOpenAI(body) : canonicalFromAnthropic(body);
  const served = await serveWithFailover(canon);
  if (!served.result) {
    const headers = failuresHeader(served.failures);
    const last = served.failures[served.failures.length - 1];
    sendJson(res, 502, {
      error: {
        message: "all eligible free models refused this prompt" + (last ? (" (last: " + last.status + " " + last.code + ")") : ""),
        type: "upstream_error",
        code: last ? last.code : "upstream_error",
      },
    }, headers);
    return;
  }
  const modelId = served.model;
  const data = served.result.data;
  const text = gatewayText(data);
  const headers = failuresHeader(served.failures);
  if (wire === "openai") {
    if (canon.stream) {
      const payload = openAiStreamBody(modelId, data, text);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...headers,
      });
      res.end(payload);
    } else {
      sendJson(res, 200, openAiAnswer(modelId, data, text), headers);
    }
  } else {
    if (canon.stream) {
      const payload = anthropicStreamBody(modelId, data, text);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...headers,
      });
      res.end(payload);
    } else {
      sendJson(res, 200, anthropicAnswer(modelId, data, text), headers);
    }
  }
}

function handleModels(req, res) {
  const ids = MODELS.map((m) => m.id);
  if (req.headers["x-api-key"]) {
    sendJson(res, 200, {
      data: ids.map((id) => ({ id, type: "model", display_name: id, created_at: "1970-01-01T00:00:00Z" })),
      has_more: false,
      first_id: ids[0],
      last_id: ids[ids.length - 1],
    });
  } else {
    sendJson(res, 200, {
      object: "list",
      data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "openrouter" })),
    });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://server");
  if (req.method === "GET" && url.pathname === "/v1/models") { handleModels(req, res); return; }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") { handleCompletion(req, res, "openai"); return; }
  if (req.method === "POST" && url.pathname === "/v1/messages") { handleCompletion(req, res, "anthropic"); return; }
  sendJson(res, 404, { error: { message: "no route " + req.method + " " + url.pathname, type: "invalid_request_error", code: "not_found" } });
});

// ---------------------------------------------------------------------------
// Boot: listen on a free port, register with the env, poll /work until done.
// ---------------------------------------------------------------------------
const ENV_URL = (process.env.MAKEFUN_ENV_URL || "").replace(/\/$/, "");

async function postJson(url, value, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(timer); }
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { status: res.status, data: JSON.parse(await res.text()) };
  } finally { clearTimeout(timer); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = server.address().port;
  if (!ENV_URL) {
    process.stderr.write("free-model-aggregator-02: listening on port " + port + " with no MAKEFUN_ENV_URL set\n");
    return; // keep serving until stopped
  }
  let registered = false;
  for (let i = 0; i < 20 && !registered; i++) {
    try {
      const reply = await postJson(ENV_URL + "/register", { protocol_version: 1, port, catalog: CATALOG }, 5000);
      if (reply.status === 200) registered = true;
      else process.stderr.write("register refused: " + reply.status + " " + reply.text + "\n");
    } catch (err) {
      process.stderr.write("register attempt failed: " + (err && err.message ? err.message : err) + "\n");
    }
    if (!registered) await sleep(500);
  }
  if (!registered) {
    process.stderr.write("free-model-aggregator-02: could not register with the env\n");
    process.exit(1);
  }
  for (;;) {
    try {
      const work = await getJson(ENV_URL + "/work", 5000);
      if (work.data && work.data.done === true) break;
    } catch { /* keep polling */ }
    await sleep(500);
  }
  server.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write("free-model-aggregator-02: " + (err && err.message ? err.message : err) + "\n");
  process.exit(1);
});
