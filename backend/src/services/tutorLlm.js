// LLM access for the tutor. Kept apart from llmService/llmProviders (the InterviewAI providers) so
// changing it cannot affect interview code. Both providers speak the OpenAI chat API.
//
//   TUTOR_LLM_PROVIDER     "openrouter" or "local". Nothing is used unless this is set, so a
//                          developer's InterviewAI settings never switch the tutor on by accident.
//
//   openrouter:
//     OPENROUTER_API_KEY   sent only in the Authorization header, never logged
//     OPENROUTER_MODEL     pin one exact model id (no automatic model routing)
//     OPENROUTER_ZDR       "true" asks OpenRouter to route only to zero-data-retention endpoints
//   local (LM Studio, Ollama, llama.cpp; no account, no cost, nothing leaves the machine):
//     LOCAL_LLM_URL        default http://localhost:1234/v1
//     LOCAL_LLM_MODEL      the loaded model's id; if empty the first loaded model is used
//     LOCAL_LLM_API_KEY    optional
//   TUTOR_LLM_TIMEOUT_MS   default 20000 (openrouter) or 90000 (local, which may load the model first)
//
// OpenRouter requests ask not to route to providers that may train on the prompt
// (provider.data_collection = "deny"). Check the current OpenRouter documentation and the chosen
// model's data policy before any child uses the app: this is a request, not a guarantee.
// The prompts sent here contain a topic, a level and practice words only, never a child's identity.

const { trackAiRequest } = require("./aiTelemetry");

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const DEFAULT_LOCAL_URL = "http://localhost:1234/v1";

class TutorLlmError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "TutorLlmError";
    this.upstreamStatus = status;
    this.code = code || (status === 429 ? "rate_limited" : status ? "http_error" : "error");
  }
}

const env = (name) => (process.env[name] || "").trim();
const chosen = () => env("TUTOR_LLM_PROVIDER").toLowerCase();

function config() {
  if (chosen() === "openrouter" && env("OPENROUTER_API_KEY") && env("OPENROUTER_MODEL")) {
    return { provider: "openrouter", baseUrl: OPENROUTER_URL, model: env("OPENROUTER_MODEL"), apiKey: env("OPENROUTER_API_KEY"), timeoutMs: 20000 };
  }
  if (chosen() === "local") {
    return { provider: "local", baseUrl: (env("LOCAL_LLM_URL") || DEFAULT_LOCAL_URL).replace(/\/+$/, ""), model: env("LOCAL_LLM_MODEL"), apiKey: env("LOCAL_LLM_API_KEY"), timeoutMs: 90000 };
  }
  return null;
}

function status() {
  const cfg = config();
  return { enabled: Boolean(cfg), provider: cfg?.provider ?? null, model: cfg?.model || null };
}

async function request({ url, method = "POST", headers, body, timeoutMs, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json().catch(() => null) };
  } catch (error) {
    if (error.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new TutorLlmError("the LLM request timed out", { code: "timeout" });
    }
    throw new TutorLlmError("the LLM server could not be reached", { code: "unreachable" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// A local server serves whatever model is loaded; use the first chat model when none is named.
async function localModel(cfg, timeoutMs, signal) {
  if (cfg.model) return cfg.model;
  const { response, data } = await request({ url: `${cfg.baseUrl}/models`, method: "GET", headers: authHeader(cfg), timeoutMs: Math.min(timeoutMs, 5000), signal });
  const name = response.ok ? (data?.data || []).map((m) => m.id).find((id) => id && !/embed/i.test(id)) : null;
  if (!name) throw new TutorLlmError("no chat model is loaded on the local server (set LOCAL_LLM_MODEL)", { code: "no_model" });
  return name;
}

const authHeader = (cfg) => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

// complete({ system, user, promptName, promptVersion, temperature, maxTokens, json, signal })
//   -> { text, model, usage }
async function complete({ system, user, promptName, promptVersion, temperature = 0.7, maxTokens, json = true, signal } = {}) {
  const cfg = config();
  if (!cfg) throw new TutorLlmError("the tutor LLM is not configured", { code: "not_configured" });
  const timeoutMs = Number(env("TUTOR_LLM_TIMEOUT_MS")) || cfg.timeoutMs;
  const model = cfg.provider === "local" ? await localModel(cfg, timeoutMs, signal) : cfg.model;
  const meta = { capability: "lesson", provider: cfg.provider, model, operation: json ? "json" : "text", prompt_name: promptName, prompt_version: promptVersion, signal };

  return trackAiRequest(meta, async (note) => {
    const body = {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature,
      // Reasoning models spend most of this budget thinking before they write the JSON (about 900 of
      // 1,200 tokens in a local test), so the limit is generous; a cut-off reply is reported as such.
      max_tokens: maxTokens || (cfg.provider === "local" ? 4000 : 2500),
      // Local servers differ on response_format (LM Studio rejects "json_object"), so the JSON
      // request is made in the prompt there and the reply is parsed leniently.
      ...(cfg.provider === "openrouter"
        ? { ...(json ? { response_format: { type: "json_object" } } : {}),
            provider: { data_collection: "deny", ...(env("OPENROUTER_ZDR").toLowerCase() === "true" ? { zdr: true } : {}) } }
        : {}),
    };
    const headers = cfg.provider === "openrouter" ? { ...authHeader(cfg), "X-Title": "AI Speaking Tutor" } : authHeader(cfg);
    const { response, data } = await request({ url: `${cfg.baseUrl}/chat/completions`, headers, body, timeoutMs, signal });
    note({ usage: data?.usage, provider_status: response.status });
    if (data?.model) note({ model: data.model });
    if (!response.ok) throw new TutorLlmError(`the LLM server returned ${response.status}`, { status: response.status });
    const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new TutorLlmError("the model returned an empty answer", { status: response.status, code: "empty_response" });
    return { text, model: data.model || model, usage: data.usage, finishReason: data?.choices?.[0]?.finish_reason ?? null };
  });
}

module.exports = { complete, status, TutorLlmError };
