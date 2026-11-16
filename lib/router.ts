export interface ModelScore {
  id: string;
  name?: string;
  rating_milli: number;
  context_length: number;
  capabilities: {
    tools: boolean;
    reasoning: boolean;
    vision: boolean;
  };
}

export interface FailoverEvent {
  model: string;
  status: number;
  code?: string;
  timestamp: number;
}

export interface UpstreamCooldown {
  model: string;
  until: number;
  failures: number;
}

export interface Requirements {
  tools?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  minContext?: number;
}

export class QualityRouter {
  public cooldowns: Map<string, UpstreamCooldown> = new Map();
  public recentFailures: FailoverEvent[] = [];
  public catalog: ModelScore[];
  public totalRequests: number = 0;
  public successfulRequests: number = 0;

  constructor(catalog: ModelScore[]) {
    this.catalog = catalog;
  }

  public isCoolingDown(modelId: string, now: number = Date.now()): boolean {
    const cd = this.cooldowns.get(modelId);
    if (!cd) return false;
    if (now >= cd.until) {
      this.cooldowns.delete(modelId);
      return false;
    }
    return true;
  }

  /**
   * Selects candidate models meeting the required capabilities,
   * sorted by rating_milli descending. Ready models are prioritized,
   * with cooling models appended as a graceful fallback.
   */
  public selectCandidates(reqs: Requirements = {}, exclude: string[] = []): ModelScore[] {
    const now = Date.now();
    const excludeSet = new Set(exclude);

    const eligible = this.catalog.filter((m) => {
      if (excludeSet.has(m.id)) return false;
      if (reqs.tools && !m.capabilities.tools) return false;
      if (reqs.reasoning && !m.capabilities.reasoning) return false;
      if (reqs.vision && !m.capabilities.vision) return false;
      if (reqs.minContext && m.context_length < reqs.minContext) return false;
      return true;
    });

    const ready: ModelScore[] = [];
    const cooling: ModelScore[] = [];

    for (const m of eligible) {
      if (this.isCoolingDown(m.id, now)) {
        cooling.push(m);
      } else {
        ready.push(m);
      }
    }

    ready.sort((a, b) => b.rating_milli - a.rating_milli);
    cooling.sort((a, b) => b.rating_milli - a.rating_milli);

    return ready.length > 0 ? ready.concat(cooling) : cooling;
  }

  public recordFailure(modelId: string, status: number, code?: string): void {
    const now = Date.now();
    const prev = this.cooldowns.get(modelId);
    const failures = (prev?.failures || 0) + 1;
    // Exponential backoff: 5s, 10s, 20s, up to 60s max
    const backoffMs = Math.min(60000, 5000 * Math.pow(2, failures - 1));
    this.cooldowns.set(modelId, {
      model: modelId,
      until: now + backoffMs,
      failures,
    });

    this.recentFailures.push({
      model: modelId,
      status,
      code,
      timestamp: now,
    });

    if (this.recentFailures.length > 100) {
      this.recentFailures.shift();
    }
  }

  public recordSuccess(modelId: string): void {
    this.cooldowns.delete(modelId);
    this.successfulRequests += 1;
  }

  public getFailuresHeader(events?: FailoverEvent[]): string {
    const list = events ?? this.recentFailures.slice(-10);
    return JSON.stringify(list.map((e) => ({ model: e.model, status: e.status, code: e.code })));
  }

  public getQualityYield(): number {
    if (this.totalRequests === 0) return 1.0;
    return this.successfulRequests / this.totalRequests;
  }
}

export function validateOpenAIRequest(body: any): { valid: boolean; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, error: "Missing or empty 'messages' field" };
  }
  return { valid: true };
}

export function validateAnthropicRequest(body: any): { valid: boolean; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, error: "Missing or empty 'messages' field" };
  }
  return { valid: true };
}
