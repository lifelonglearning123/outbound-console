import "server-only";
import OpenAI from "openai";

/**
 * The one place the app talks to a language model. Kimi (Moonshot) when KIMI_API_KEY is set, otherwise OpenAI.
 * Both speak the OpenAI chat-completions protocol with JSON-schema structured output, so the call sites don't care.
 *
 *   KIMI_API_KEY     switches to Kimi; KIMI_MODEL (default kimi-k2.6), KIMI_BASE_URL (default https://api.moonshot.ai/v1)
 *   OPENAI_API_KEY   otherwise; OPENAI_MODEL (default gpt-5.5), OPENAI_BASE_URL
 */

export type Effort = "low" | "high";

type Config = { provider: "kimi" | "openai"; apiKey: string | undefined; baseURL: string | undefined; model: string };

function config(): Config {
  if (process.env.KIMI_API_KEY) {
    return {
      provider: "kimi",
      apiKey: process.env.KIMI_API_KEY,
      baseURL: process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1",
      model: process.env.KIMI_MODEL || "kimi-k2.6",
    };
  }
  return { provider: "openai", apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined, model: process.env.OPENAI_MODEL || "gpt-5.5" };
}

export function llmReady(): boolean {
  return !!config().apiKey;
}

/** For messages to the user, e.g. "Kimi (kimi-k2.6)". */
export function llmLabel(): string {
  const c = config();
  return `${c.provider === "kimi" ? "Kimi" : "OpenAI"} (${c.model})`;
}

export function llmKeyHint(): string {
  return config().provider === "kimi" ? "KIMI_API_KEY" : "OPENAI_API_KEY";
}

let client: OpenAI | null = null;
let clientKey = "";
function api(): { client: OpenAI; cfg: Config } {
  const cfg = config();
  if (!cfg.apiKey) throw new Error("No AI key: set KIMI_API_KEY (or OPENAI_API_KEY)");
  const key = `${cfg.apiKey}|${cfg.baseURL}`;
  if (!client || clientKey !== key) {
    client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
    clientKey = key;
  }
  return { client, cfg };
}

/**
 * How much the model should think. Each provider spells it differently and rejects the others' fields:
 * kimi-k3 takes reasoning_effort; kimi-k2.6 takes thinking on/off; kimi-k2.7-code can't turn thinking off;
 * OpenAI reasoning models take reasoning_effort.
 */
function effortParams(model: string, effort: Effort): Record<string, unknown> {
  if (model.startsWith("kimi-k3")) return { reasoning_effort: effort === "low" ? "low" : "high" };
  if (model.startsWith("kimi-k2.6")) return effort === "low" ? { thinking: { type: "disabled" } } : {};
  if (model.startsWith("kimi")) return {};
  if (/^(gpt-5|o\d)/.test(model)) return { reasoning_effort: effort };
  return {};
}

async function complete(opts: { system: string; user: string; effort: Effort; format?: Record<string, unknown> }): Promise<string> {
  const { client, cfg } = api();
  const params = {
    model: cfg.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    ...(opts.format ? { response_format: opts.format } : {}),
    ...effortParams(cfg.model, opts.effort),
  };
  const res = await client.chat.completions.create(params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error(`${llmLabel()} returned nothing${res.choices[0]?.finish_reason === "length" ? " (output cut off)" : ""}`);
  return text;
}

/** Ask for an object matching `schema` (JSON Schema; every property required, additionalProperties false). */
export async function llmJson<T>(opts: { system: string; user: string; name: string; schema: object; effort?: Effort }): Promise<T> {
  const text = await complete({
    system: opts.system,
    user: opts.user,
    effort: opts.effort ?? "low",
    format: { type: "json_schema", json_schema: { name: opts.name, schema: opts.schema, strict: true } },
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${llmLabel()} returned something that isn't JSON: ${text.slice(0, 120)}`);
  }
}

/** Plain text answer. */
export async function llmText(opts: { system: string; user: string; effort?: Effort }): Promise<string> {
  return complete({ system: opts.system, user: opts.user, effort: opts.effort ?? "low" });
}
