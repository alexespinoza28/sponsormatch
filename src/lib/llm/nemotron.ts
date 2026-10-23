// NVIDIA Nemotron through NVIDIA's OpenAI-compatible endpoint, with plain fetch.
// Server-only: NVIDIA_API_KEY is read from the environment by the caller.

export const NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function resolveModel(env: Record<string, string | undefined> = process.env): string {
  return env.NVIDIA_MODEL?.trim() || DEFAULT_NVIDIA_MODEL;
}

/** Removes <think>...</think> blocks (and a stray unmatched closing tag) from a reply. */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const strayClose = out.search(/<\/think>/i);
  if (strayClose !== -1) out = out.slice(strayClose + "</think>".length);
  const strayOpen = out.search(/<think>/i);
  if (strayOpen !== -1) out = out.slice(0, strayOpen);
  return out.trim();
}

export class NvidiaError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "NvidiaError";
    this.status = status;
  }
}

export function buildChatBody(model: string, messages: ChatMessage[], maxTokens = 400, temperature = 0.3) {
  return {
    model,
    messages,
    // Low temperature: proposals must stay within the given state.
    temperature,
    top_p: 0.9,
    max_tokens: maxTokens,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

export async function chatCompletion(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<string> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await doFetch(NVIDIA_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(buildChatBody(options.model, options.messages, options.maxTokens, options.temperature)),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new NvidiaError(`NVIDIA API returned ${response.status}`, response.status);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new NvidiaError("NVIDIA API returned no text");
    const text = stripThink(content);
    if (!text) throw new NvidiaError("NVIDIA API reply was empty after removing reasoning");
    return text;
  } catch (error) {
    if (error instanceof NvidiaError) throw error;
    throw new NvidiaError(controller.signal.aborted ? "NVIDIA API timed out" : "Could not reach NVIDIA API");
  } finally {
    clearTimeout(timer);
  }
}
