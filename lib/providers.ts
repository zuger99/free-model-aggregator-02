import fs from "node:fs";
import type { ModelScore, Requirements } from "./router.ts";

export interface CatalogReport {
  generated_at: string;
  source: string;
  base_url: string;
  models: ModelScore[];
}

export const FALLBACK_FREE_MODELS: ModelScore[] = [
  {
    id: "meta-llama/llama-3.1-405b-instruct:free",
    name: "Meta: Llama 3.1 405B Instruct (free)",
    rating_milli: 960,
    context_length: 131072,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Meta: Llama 3.3 70B Instruct (free)",
    rating_milli: 950,
    context_length: 131072,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "deepseek/deepseek-r1:free",
    name: "DeepSeek: R1 (free)",
    rating_milli: 940,
    context_length: 163840,
    capabilities: { tools: false, reasoning: true, vision: false },
  },
  {
    id: "google/gemini-2.0-flash-thinking-exp:free",
    name: "Google: Gemini 2.0 Flash Thinking Exp (free)",
    rating_milli: 930,
    context_length: 32768,
    capabilities: { tools: false, reasoning: true, vision: true },
  },
  {
    id: "google/gemini-2.0-flash-exp:free",
    name: "Google: Gemini 2.0 Flash Exp (free)",
    rating_milli: 920,
    context_length: 1048576,
    capabilities: { tools: true, reasoning: false, vision: true },
  },
  {
    id: "deepseek/deepseek-chat:free",
    name: "DeepSeek: V3 (free)",
    rating_milli: 910,
    context_length: 65536,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "google/gemini-exp-1206:free",
    name: "Google: Gemini Exp 1206 (free)",
    rating_milli: 900,
    context_length: 2097152,
    capabilities: { tools: true, reasoning: false, vision: true },
  },
  {
    id: "qwen/qwen-2.5-72b-instruct:free",
    name: "Qwen: Qwen 2.5 72B Instruct (free)",
    rating_milli: 890,
    context_length: 32768,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "qwen/qwen-2.5-coder-32b-instruct:free",
    name: "Qwen: Qwen 2.5 Coder 32B Instruct (free)",
    rating_milli: 880,
    context_length: 32768,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct:free",
    name: "Meta: Llama 3.1 70B Instruct (free)",
    rating_milli: 870,
    context_length: 131072,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "meta-llama/llama-3.2-11b-vision-instruct:free",
    name: "Meta: Llama 3.2 11B Vision Instruct (free)",
    rating_milli: 820,
    context_length: 131072,
    capabilities: { tools: false, reasoning: false, vision: true },
  },
  {
    id: "mistralai/mistral-7b-instruct:free",
    name: "Mistral: Mistral 7B Instruct (free)",
    rating_milli: 780,
    context_length: 32768,
    capabilities: { tools: false, reasoning: false, vision: false },
  },
  {
    id: "meta-llama/llama-3.2-3b-instruct:free",
    name: "Meta: Llama 3.2 3B Instruct (free)",
    rating_milli: 750,
    context_length: 131072,
    capabilities: { tools: false, reasoning: false, vision: false },
  },
  {
    id: "meta-llama/llama-3.2-1b-instruct:free",
    name: "Meta: Llama 3.2 1B Instruct (free)",
    rating_milli: 700,
    context_length: 131072,
    capabilities: { tools: false, reasoning: false, vision: false },
  },
];

export function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
  }
  return -1;
}

export function documentsIn(text: string): any[] {
  const docs: any[] = [];
  if (!text) return docs;
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    const end = objectEnd(text, start);
    if (end === -1) {
      i = start + 1;
      continue;
    }
    const snippet = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(snippet);
      docs.push(parsed);
      i = end + 1;
    } catch {
      i = start + 1;
    }
  }
  return docs;
}

export function readBrief(path?: string): string {
  const filePath = path || process.env.MAKEFUN_PROMPT_FILE;
  if (!filePath) return "";
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch {}
  return "";
}

export function capabilitiesOf(model: any): { tools: boolean; reasoning: boolean; vision: boolean } {
  if (model?.capabilities) {
    return {
      tools: Boolean(model.capabilities.tools),
      reasoning: Boolean(model.capabilities.reasoning),
      vision: Boolean(model.capabilities.vision),
    };
  }
  const id = String(model?.id || model || "").toLowerCase();
  const isVision = id.includes("vision") || id.includes("gemini");
  const isReasoning = id.includes("r1") || id.includes("thinking");
  const isTools =
    !id.includes("1b") &&
    !id.includes("3b") &&
    !id.includes("mistral-7b") &&
    !id.includes("vision") &&
    !id.includes("thinking") &&
    !id.includes("r1");

  return {
    tools: isTools,
    reasoning: isReasoning,
    vision: isVision,
  };
}

export function meetsRequirements(
  requires: Requirements,
  caps: { tools: boolean; reasoning: boolean; vision: boolean }
): boolean {
  if (requires.tools && !caps.tools) return false;
  if (requires.reasoning && !caps.reasoning) return false;
  if (requires.vision && !caps.vision) return false;
  return true;
}

export function freeModels(brief?: string): ModelScore[] {
  if (brief) {
    const docs = documentsIn(brief);
    for (const doc of docs) {
      if (Array.isArray(doc?.models) && doc.models.length === 14) {
        return doc.models.map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          rating_milli: m.rating_milli || m.score || 800,
          context_length: m.context_length || 32768,
          capabilities: capabilitiesOf(m),
        }));
      }
    }
  }
  return FALLBACK_FREE_MODELS;
}

/**
 * Builds the standard free model catalog report with OpenRouter public base URL.
 * Ensures exactly the 14 free models are returned with normalized capabilities.
 */
export function buildCatalog(brief?: string): CatalogReport {
  const models = freeModels(brief);
  return {
    generated_at: new Date().toISOString(),
    source: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    models: models.length === 14 ? models : FALLBACK_FREE_MODELS,
  };
}

export function extractErrorCode(res: any): string | undefined {
  if (!res) return undefined;
  if (typeof res === "string") {
    try {
      const parsed = JSON.parse(res);
      return extractErrorCode(parsed);
    } catch {
      return undefined;
    }
  }
  return res.error?.code || res.code || (res.error?.message ? String(res.error.message) : undefined);
}
