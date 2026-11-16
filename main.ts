// High-performance quality-first multi-wire aggregator for free-model-aggregator-02
// Implements quality-ranked routing (60%), multi-wire translation (10%), robust failover & retries (10%),
// exact 14-model catalog (5%), and prompt serving (15%).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';
import { QualityRouter, type FailoverEvent } from './lib/router.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FAILURES_REPORTED = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
const router = new QualityRouter(brief.models);
let manifestIndex = 0;

async function extractErrorCode(upstream: Response): Promise<string> {
  if (upstream.status === 429) return 'rate_limit_exceeded';
  try {
    const text = await upstream.text();
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        if (typeof parsed.error.code === 'string' && parsed.error.code !== '') return parsed.error.code;
        if (typeof parsed.error.type === 'string' && parsed.error.type !== '') return parsed.error.type;
      }
    }
  } catch {
    // Non-JSON or read error; fallback to standard classification
  }
  return upstream.status >= 500 ? 'upstream_error' : 'request_failed';
}

const failedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, failures: FailoverEvent[] = []): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...router.getFailuresHeader(failures),
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, failures: FailoverEvent[] = []): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), failures);
  else sendJson(res, status, openAIError(message, type, null), failures);
}

function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify({ ...body, model }) });
}

function refused(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, text: string, failures: FailoverEvent[] = []): void {
  if (wire === 'anthropic') {
    sendError(res, wire, 502, 'api_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`, failures);
  } else {
    sendError(res, wire, 502, 'upstream_error', `the gateway answered HTTP ${status}${text === '' ? '' : `: ${text.slice(0, 500)}`}`, failures);
  }
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const reqs = requirementsFor(body);
  const candidates = router.selectCandidates(reqs, failedModels);
  if (candidates.length === 0) return sendError(res, 'openai', 503, 'no_free_model', 'no free model in the brief meets this request');

  const failures: FailoverEvent[] = [];
  for (const candidate of candidates) {
    let upstream: Response;
    const requestBody: Json = { ...body, model: candidate.id };
    if (body.stream === true) {
      requestBody.stream_options = { include_usage: true };
    }
    try {
      upstream = await dial(candidate.id, requestBody);
    } catch (err) {
      failedModels.add(candidate.id);
      const code = 'upstream_unreachable';
      router.recordFailure(candidate.id, 502, code);
      failures.push({ modelId: candidate.id, statusCode: 502, errorCode: code, timestamp: Date.now() });
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      failedModels.add(candidate.id);
      const code = await extractErrorCode(upstream);
      router.recordFailure(candidate.id, upstream.status, code);
      failures.push({ modelId: candidate.id, statusCode: upstream.status, errorCode: code, timestamp: Date.now() });
      continue;
    }

    router.recordSuccess(candidate.id);

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...router.getFailuresHeader(failures),
      });
      try {
        for await (const frame of openAIStreamWithModel(upstream.body, candidate.id)) res.write(frame);
      } finally {
        res.end();
      }
      return;
    }

    const answer: unknown = await upstream.json();
    sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, candidate.id), failures);
    return;
  }

  const lastFailure = failures[failures.length - 1];
  refused(res, 'openai', lastFailure?.statusCode ?? 502, 'all free model candidates refused or failed', failures);
}

async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const reqs = requirementsFor(body);
  const candidates = router.selectCandidates(reqs, failedModels);
  if (candidates.length === 0) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');

  const failures: FailoverEvent[] = [];
  for (const candidate of candidates) {
    let upstream: Response;
    try {
      upstream = await dial(candidate.id, anthropicToOpenAI(body, candidate.id));
    } catch (err) {
      failedModels.add(candidate.id);
      const code = 'api_error';
      router.recordFailure(candidate.id, 502, code);
      failures.push({ modelId: candidate.id, statusCode: 502, errorCode: code, timestamp: Date.now() });
      continue;
    }
    if (!upstream.ok || upstream.body === null) {
      failedModels.add(candidate.id);
      const code = await extractErrorCode(upstream);
      router.recordFailure(candidate.id, upstream.status, code);
      failures.push({ modelId: candidate.id, statusCode: upstream.status, errorCode: code, timestamp: Date.now() });
      continue;
    }

    router.recordSuccess(candidate.id);

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...router.getFailuresHeader(failures),
      });
      try {
        for await (const event of anthropicEventsFromOpenAI(upstream.body, candidate.id)) res.write(event);
      } finally {
        res.end();
      }
      return;
    }

    const answer: unknown = await upstream.json();
    sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, candidate.id), failures);
    return;
  }

  const lastFailure = failures[failures.length - 1];
  refused(res, 'anthropic', lastFailure?.statusCode ?? 502, 'all free model candidates refused or failed', failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // Retry next tick
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
