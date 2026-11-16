import http from "node:http";
import { QualityRouter, validateOpenAIRequest, validateAnthropicRequest, type FailoverEvent, type Requirements } from "./lib/router.ts";
import { readBrief, buildCatalog, extractErrorCode, FALLBACK_FREE_MODELS } from "./lib/providers.ts";
import {
  openAIModelList,
  anthropicModelList,
  openAIError,
  anthropicError,
  anthropicToOpenAI,
  openAIToAnthropic,
  openAIStreamWithModel,
  anthropicEventsFromOpenAI,
} from "./lib/wire.ts";

// 1. CLI --list handler
if (process.argv.includes("--list")) {
  const brief = readBrief();
  const report = buildCatalog(brief);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const brief = readBrief();
const catalogReport = buildCatalog(brief);
const router = new QualityRouter(catalogReport.models);

const GATEWAY_URL = process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
const GATEWAY_KEY = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || "";

function extractApiKey(req: http.IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim()) {
    return xApiKey.trim();
  }
  return null;
}

function extractOpenAIRequirements(body: any): Requirements {
  const hasTools = Boolean(Array.isArray(body.tools) && body.tools.length > 0);
  let hasVision = false;
  let hasReasoning = false;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "image_url") hasVision = true;
        }
      }
    }
  }

  if (typeof body.model === "string") {
    const m = body.model.toLowerCase();
    if (m.includes("r1") || m.includes("thinking") || m.includes("reasoning")) {
      hasReasoning = true;
    }
    if (m.includes("vision")) {
      hasVision = true;
    }
  }

  return {
    tools: hasTools,
    vision: hasVision,
    reasoning: hasReasoning,
    minContext: typeof body.max_tokens === "number" ? body.max_tokens * 2 : undefined,
  };
}

function extractAnthropicRequirements(body: any): Requirements {
  const hasTools = Boolean(Array.isArray(body.tools) && body.tools.length > 0);
  let hasVision = false;
  let hasReasoning = false;

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "image") hasVision = true;
        }
      }
    }
  }

  if (typeof body.model === "string") {
    const m = body.model.toLowerCase();
    if (m.includes("r1") || m.includes("thinking") || m.includes("reasoning")) {
      hasReasoning = true;
    }
    if (m.includes("vision")) {
      hasVision = true;
    }
  }

  return {
    tools: hasTools,
    vision: hasVision,
    reasoning: hasReasoning,
  };
}

async function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, anthropic-version"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/health" || pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", models: catalogReport.models.length }));
    return;
  }

  // GET /v1/models
  if (req.method === "GET" && pathname === "/v1/models") {
    const token = extractApiKey(req);
    res.setHeader("x-makefun-quality-yield", router.getQualityYield().toFixed(4));
    const anthropicVersion = req.headers["anthropic-version"];
    if (anthropicVersion) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicModelList(catalogReport.models)));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(openAIModelList(catalogReport.models)));
    return;
  }

  // POST /v1/chat/completions
  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    let body: any;
    try {
      body = await parseBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openAIError(400, "Invalid JSON body")));
      return;
    }

    const validation = validateOpenAIRequest(body);
    if (!validation.valid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openAIError(400, validation.error || "Bad Request")));
      return;
    }

    const reqs = extractOpenAIRequirements(body);
    let candidates = router.selectCandidates(reqs);

    if (body.model && catalogReport.models.some((m) => m.id === body.model)) {
      const preferred = catalogReport.models.find((m) => m.id === body.model)!;
      candidates = [preferred, ...candidates.filter((m) => m.id !== preferred.id)];
    }

    if (candidates.length === 0) {
      candidates = router.selectCandidates({});
    }
    if (candidates.length === 0) {
      candidates = catalogReport.models;
    }

    const failoverEvents: FailoverEvent[] = [];
    let lastStatus = 502;

    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
    };
    if (GATEWAY_KEY) {
      reqHeaders["authorization"] = `Bearer ${GATEWAY_KEY}`;
    }

    for (const candidate of candidates) {
      const payload = {
        ...body,
        model: candidate.id,
      };

      try {
        const upstreamRes = await fetch(`${GATEWAY_URL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(payload),
        });

        if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
          let code: string | undefined;
          try {
            const errJson = await upstreamRes.json();
            code = extractErrorCode(errJson);
          } catch {
            code = `HTTP_${upstreamRes.status}`;
          }
          router.recordFailure(candidate.id, upstreamRes.status, code);
          failoverEvents.push({
            model: candidate.id,
            status: upstreamRes.status,
            code,
            timestamp: Date.now(),
          });
          lastStatus = upstreamRes.status;
          continue;
        }

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          res.writeHead(upstreamRes.status, {
            "content-type": upstreamRes.headers.get("content-type") || "application/json",
            "x-makefun-upstream-failures": router.getFailuresHeader(failoverEvents),
          });
          res.end(errText);
          return;
        }

        router.recordSuccess(candidate.id);
        const failuresHeader = router.getFailuresHeader(failoverEvents);
        res.setHeader("x-makefun-quality-yield", router.getQualityYield().toFixed(4));

        if (body.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-makefun-upstream-failures": failuresHeader,
          });

          if (!upstreamRes.body) {
            res.end();
            return;
          }

          for await (const chunk of openAIStreamWithModel(upstreamRes.body, candidate.id)) {
            res.write(chunk);
          }
          res.end();
          return;
        } else {
          const data = await upstreamRes.json();
          data.model = candidate.id;
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "x-makefun-upstream-failures": failuresHeader,
          });
          res.end(JSON.stringify(data));
          return;
        }
      } catch (err: any) {
        router.recordFailure(candidate.id, 503, err.message || "FETCH_ERROR");
        failoverEvents.push({
          model: candidate.id,
          status: 503,
          code: "UPSTREAM_DIAL_FAILED",
          timestamp: Date.now(),
        });
        continue;
      }
    }

    res.writeHead(lastStatus, {
      "content-type": "application/json",
      "x-makefun-upstream-failures": router.getFailuresHeader(failoverEvents),
    });
    res.end(
      JSON.stringify(openAIError(lastStatus, "All upstream model candidates failed", "api_error"))
    );
    return;
  }

  // POST /v1/messages
  if (req.method === "POST" && pathname === "/v1/messages") {
    let body: any;
    try {
      body = await parseBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicError(400, "Invalid JSON body", "invalid_request_error")));
      return;
    }

    const validation = validateAnthropicRequest(body);
    if (!validation.valid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          anthropicError(400, validation.error || "Bad Request", "invalid_request_error")
        )
      );
      return;
    }

    const reqs = extractAnthropicRequirements(body);
    let candidates = router.selectCandidates(reqs);

    if (body.model && catalogReport.models.some((m) => m.id === body.model)) {
      const preferred = catalogReport.models.find((m) => m.id === body.model)!;
      candidates = [preferred, ...candidates.filter((m) => m.id !== preferred.id)];
    }

    if (candidates.length === 0) {
      candidates = router.selectCandidates({});
    }
    if (candidates.length === 0) {
      candidates = catalogReport.models;
    }

    const failoverEvents: FailoverEvent[] = [];
    let lastStatus = 502;

    const reqHeaders: Record<string, string> = {
      "content-type": "application/json",
    };
    if (GATEWAY_KEY) {
      reqHeaders["authorization"] = `Bearer ${GATEWAY_KEY}`;
    }

    for (const candidate of candidates) {
      const openAIPayload = anthropicToOpenAI(body, candidate.id);

      try {
        const upstreamRes = await fetch(`${GATEWAY_URL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(openAIPayload),
        });

        if (upstreamRes.status === 429 || upstreamRes.status >= 500) {
          let code: string | undefined;
          try {
            const errJson = await upstreamRes.json();
            code = extractErrorCode(errJson);
          } catch {
            code = `HTTP_${upstreamRes.status}`;
          }
          router.recordFailure(candidate.id, upstreamRes.status, code);
          failoverEvents.push({
            model: candidate.id,
            status: upstreamRes.status,
            code,
            timestamp: Date.now(),
          });
          lastStatus = upstreamRes.status;
          continue;
        }

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          res.writeHead(upstreamRes.status, {
            "content-type": "application/json",
            "x-makefun-upstream-failures": router.getFailuresHeader(failoverEvents),
          });
          res.end(JSON.stringify(anthropicError(upstreamRes.status, errText, "api_error")));
          return;
        }

        router.recordSuccess(candidate.id);
        const failuresHeader = router.getFailuresHeader(failoverEvents);
        res.setHeader("x-makefun-quality-yield", router.getQualityYield().toFixed(4));

        if (body.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-makefun-upstream-failures": failuresHeader,
          });

          if (!upstreamRes.body) {
            res.end();
            return;
          }

          for await (const chunk of anthropicEventsFromOpenAI(upstreamRes.body, candidate.id)) {
            res.write(chunk);
          }
          res.end();
          return;
        } else {
          const data = await upstreamRes.json();
          const anthropicData = openAIToAnthropic(data, candidate.id);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "x-makefun-upstream-failures": failuresHeader,
          });
          res.end(JSON.stringify(anthropicData));
          return;
        }
      } catch (err: any) {
        router.recordFailure(candidate.id, 503, err.message || "FETCH_ERROR");
        failoverEvents.push({
          model: candidate.id,
          status: 503,
          code: "UPSTREAM_DIAL_FAILED",
          timestamp: Date.now(),
        });
        continue;
      }
    }

    res.writeHead(lastStatus, {
      "content-type": "application/json",
      "x-makefun-upstream-failures": router.getFailuresHeader(failoverEvents),
    });
    res.end(
      JSON.stringify(anthropicError(lastStatus, "All upstream model candidates failed", "api_error"))
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

const requestedPort = parseInt(process.env.PORT || "0", 10) || 0;
server.listen(requestedPort, "0.0.0.0", async () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : requestedPort;
  console.log(`free-model-aggregator listening on port ${actualPort}`);

  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    try {
      const regUrl = `${envUrl.replace(/\/+$/, "")}/register`;
      const regRes = await fetch(regUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          port: actualPort,
          url: `http://localhost:${actualPort}`,
        }),
      });
      console.log(`Registered with environment at ${regUrl}: ${regRes.status}`);
    } catch (err: any) {
      console.error(`Registration failed:`, err.message);
    }

    const pollInterval = setInterval(async () => {
      try {
        const workUrl = `${envUrl.replace(/\/+$/, "")}/work`;
        const res = await fetch(workUrl);
        if (res.ok) {
          const data: any = await res.json();
          if (data && data.done === true) {
            console.log("Work complete signal received. Exiting.");
            clearInterval(pollInterval);
            server.close(() => {
              process.exit(0);
            });
          }
        }
      } catch {}
    }, 500);
  }
});
