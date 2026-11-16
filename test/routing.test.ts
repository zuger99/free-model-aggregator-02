import test from "node:test";
import assert from "node:assert/strict";
import {
  QualityRouter,
  validateOpenAIRequest,
  validateAnthropicRequest,
  type ModelScore,
} from "../lib/router.ts";

const TEST_MODELS: ModelScore[] = [
  {
    id: "model-a",
    name: "Model A",
    rating_milli: 900,
    context_length: 32768,
    capabilities: { tools: true, reasoning: false, vision: false },
  },
  {
    id: "model-b",
    name: "Model B",
    rating_milli: 950,
    context_length: 65536,
    capabilities: { tools: true, reasoning: true, vision: false },
  },
  {
    id: "model-c",
    name: "Model C",
    rating_milli: 850,
    context_length: 131072,
    capabilities: { tools: false, reasoning: false, vision: true },
  },
  {
    id: "model-d",
    name: "Model D",
    rating_milli: 700,
    context_length: 16384,
    capabilities: { tools: false, reasoning: false, vision: false },
  },
];

// Suite of unit tests for QualityRouter, scoring, cooldowns, and wire validation
test("1. Candidates are sorted by rating_milli descending", () => {
  const router = new QualityRouter(TEST_MODELS);
  const candidates = router.selectCandidates();
  assert.equal(candidates.length, 4);
  assert.equal(candidates[0].id, "model-b"); // 950
  assert.equal(candidates[1].id, "model-a"); // 900
  assert.equal(candidates[2].id, "model-c"); // 850
  assert.equal(candidates[3].id, "model-d"); // 700
});

test("2. Capabilities filtering correctly matches requirements", () => {
  const router = new QualityRouter(TEST_MODELS);

  const toolsOnly = router.selectCandidates({ tools: true });
  assert.equal(toolsOnly.length, 2);
  assert.deepEqual(
    toolsOnly.map((m) => m.id),
    ["model-b", "model-a"]
  );

  const reasoningOnly = router.selectCandidates({ reasoning: true });
  assert.equal(reasoningOnly.length, 1);
  assert.equal(reasoningOnly[0].id, "model-b");

  const visionOnly = router.selectCandidates({ vision: true });
  assert.equal(visionOnly.length, 1);
  assert.equal(visionOnly[0].id, "model-c");

  const highContext = router.selectCandidates({ minContext: 100000 });
  assert.equal(highContext.length, 1);
  assert.equal(highContext[0].id, "model-c");
});

test("3. Exclude list correctly filters out specified model IDs", () => {
  const router = new QualityRouter(TEST_MODELS);
  const candidates = router.selectCandidates({}, ["model-b", "model-d"]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, "model-a");
  assert.equal(candidates[1].id, "model-c");
});

test("4. Upstream cooldown deprioritizes failing models and falls back gracefully", () => {
  const router = new QualityRouter(TEST_MODELS);

  // model-b fails with 429
  router.recordFailure("model-b", 429, "rate_limit_exceeded");
  assert.equal(router.isCoolingDown("model-b"), true);

  // Candidate selection should prioritize ready models first
  const candidates = router.selectCandidates();
  assert.equal(candidates[0].id, "model-a"); // model-a becomes top ready candidate
  assert.equal(candidates[candidates.length - 1].id, "model-b"); // model-b placed at end as fallback

  // Record success on model-b clears cooldown
  router.recordSuccess("model-b");
  assert.equal(router.isCoolingDown("model-b"), false);
  const updatedCandidates = router.selectCandidates();
  assert.equal(updatedCandidates[0].id, "model-b");
});

test("5. Request validators correctly validate OpenAI and Anthropic schemas", () => {
  assert.equal(validateOpenAIRequest(null).valid, false);
  assert.equal(validateOpenAIRequest({}).valid, false);
  assert.equal(validateOpenAIRequest({ messages: [] }).valid, false);
  assert.equal(
    validateOpenAIRequest({ messages: [{ role: "user", content: "hello" }] }).valid,
    true
  );

  assert.equal(validateAnthropicRequest(undefined).valid, false);
  assert.equal(validateAnthropicRequest({ messages: [] }).valid, false);
  assert.equal(
    validateAnthropicRequest({ messages: [{ role: "user", content: "hello" }] }).valid,
    true
  );
});

test("6. Failures header generates valid JSON format for x-makefun-upstream-failures", () => {
  const router = new QualityRouter(TEST_MODELS);
  router.recordFailure("model-a", 429, "rate_limit");
  router.recordFailure("model-b", 503, "service_unavailable");

  const header = router.getFailuresHeader();
  const parsed = JSON.parse(header);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].model, "model-a");
  assert.equal(parsed[0].status, 429);
  assert.equal(parsed[0].code, "rate_limit");
  assert.equal(parsed[1].model, "model-b");
  assert.equal(parsed[1].status, 503);
  assert.equal(parsed[1].code, "service_unavailable");
});
