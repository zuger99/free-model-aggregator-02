// Quality-first routing and upstream failover engine for free-model-aggregator-02
import type { ModelRow, PromptRequirements, PromptRow } from './providers.ts';

export interface ModelScore {
  modelId: string;
  ratingMilli: number;
  weight: number;
  score: number;
  capabilities: {
    tools: boolean;
    json: boolean;
    multimodal: boolean;
    contextLength: number;
  };
}

export interface FailoverEvent {
  modelId: string;
  statusCode: number;
  errorCode: string;
  timestamp: number;
  latencyMs?: number;
}

export interface UpstreamCooldown {
  modelId: string;
  cooldownUntil: number;
  consecutiveFailures: number;
}

export class QualityRouter {
  private models: ModelRow[];
  private cooldowns: Map<string, UpstreamCooldown> = new Map();
  private recentFailures: FailoverEvent[] = [];
  private readonly defaultCooldownMs: number = 30000;
  private readonly maxFailuresTracked: number = 8;

  constructor(models: ModelRow[]) {
    this.models = models;
  }

  /**
   * Evaluates prompt requirements and ranks candidate models by rating_milli in descending order.
   * Excludes models currently in cooldown or that fail hard capability requirements.
   */
  public selectCandidates(reqs: PromptRequirements = {}, exclude: Set<string> = new Set()): ModelRow[] {
    const minCtx = reqs.context ?? reqs.min_context ?? 0;
    const needTools = reqs.tools ?? false;
    const needJson = reqs.json ?? false;
    const needVision = reqs.multimodal ?? reqs.vision ?? false;
    const now = Date.now();

    const candidates = this.models.filter((m) => {
      if (exclude.has(m.id)) return false;
      const cd = this.cooldowns.get(m.id);
      if (cd && cd.cooldownUntil > now) return false;
      if (m.context_length !== null && m.context_length < minCtx) return false;
      if (needTools && !m.tools) return false;
      if (needJson && !m.json) return false;
      const mVision = m.multimodal ?? m.vision ?? false;
      if (needVision && !mVision) return false;
      return true;
    });

    candidates.sort((a, b) => b.rating_milli - a.rating_milli);

    if (candidates.length > 0) return candidates;

    // Soft fallback: ignore cooldowns if all models are unavailable
    const fallback = this.models.filter((m) => {
      if (exclude.has(m.id)) return false;
      if (m.context_length !== null && m.context_length < minCtx) return false;
      if (needTools && !m.tools) return false;
      if (needJson && !m.json) return false;
      const mVision = m.multimodal ?? m.vision ?? false;
      if (needVision && !mVision) return false;
      return true;
    });

    fallback.sort((a, b) => b.rating_milli - a.rating_milli);
    if (fallback.length > 0) return fallback;

    // Hard fallback: all remaining non-excluded models sorted by rating
    const remaining = this.models.filter((m) => !exclude.has(m.id));
    remaining.sort((a, b) => b.rating_milli - a.rating_milli);
    return remaining.length > 0 ? remaining : this.models;
  }

  /**
   * Records an upstream error or rate limit and places the model on cooldown.
   */
  public recordFailure(modelId: string, status: number, code: string, latencyMs?: number): void {
    const event: FailoverEvent = {
      modelId,
      statusCode: status,
      errorCode: code,
      timestamp: Date.now(),
      latencyMs,
    };
    this.recentFailures.push(event);
    if (this.recentFailures.length > this.maxFailuresTracked) {
      this.recentFailures.shift();
    }

    const current = this.cooldowns.get(modelId) ?? {
      modelId,
      cooldownUntil: 0,
      consecutiveFailures: 0,
    };

    current.consecutiveFailures += 1;
    const backoffMultiplier = Math.min(4, Math.pow(2, current.consecutiveFailures - 1));
    current.cooldownUntil = Date.now() + this.defaultCooldownMs * backoffMultiplier;
    this.cooldowns.set(modelId, current);
  }

  /**
   * Resets cooldown upon successful completion.
   */
  public recordSuccess(modelId: string): void {
    const current = this.cooldowns.get(modelId);
    if (current && current.consecutiveFailures > 0) {
      current.consecutiveFailures = 0;
      current.cooldownUntil = 0;
      this.cooldowns.set(modelId, current);
    }
  }

  /**
   * Returns formatted x-makefun-upstream-failures header payload.
   */
  public getFailuresHeader(currentFailures: FailoverEvent[] = []): Record<string, string> {
    const active = currentFailures.length > 0 ? currentFailures : this.recentFailures;
    if (active.length === 0) return {};
    const report = active.slice(-this.maxFailuresTracked).map((f) => ({
      status: f.statusCode,
      code: f.errorCode,
      model: f.modelId,
    }));
    return { 'x-makefun-upstream-failures': JSON.stringify(report) };
  }

  /**
   * Computes quality yield potential for a prompt based on top rated model.
   */
  public getQualityYield(prompt: PromptRow, selectedModel: ModelRow, topModel: ModelRow): number {
    if (topModel.rating_milli <= 0) return 1.0;
    const ratio = Math.min(1.0, selectedModel.rating_milli / topModel.rating_milli);
    return ratio * prompt.weight;
  }
}

/**
 * Validates request payload against OpenAI specification limits.
 */
export function validateOpenAIRequest(body: Record<string, any>): { valid: boolean; reason?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Request body must be an object' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, reason: 'messages must be a non-empty array' };
  }
  if (body.temperature !== undefined && (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)) {
    return { valid: false, reason: 'temperature must be a number between 0 and 2' };
  }
  return { valid: true };
}

/**
 * Validates request payload against Anthropic specification limits.
 */
export function validateAnthropicRequest(body: Record<string, any>): { valid: boolean; reason?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, reason: 'Request body must be an object' };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, reason: 'messages must be a non-empty array' };
  }
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens <= 0)) {
    return { valid: false, reason: 'max_tokens must be a positive integer' };
  }
  return { valid: true };
}
