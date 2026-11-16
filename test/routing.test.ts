// Unit tests for QualityRouter, capability matching, and failover tracking
import { QualityRouter, validateOpenAIRequest, validateAnthropicRequest } from '../lib/router.ts';
import { FALLBACK_MODELS } from '../lib/providers.ts';

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error('Assertion failed: ' + msg);
}

function runTests(): void {
  console.log('Running routing and validation tests...');

  // Test 1: QualityRouter ranks candidates by rating_milli descending
  const router = new QualityRouter(FALLBACK_MODELS);
  const candidates = router.selectCandidates({ context: 32000, tools: true });
  assert(candidates.length > 0, 'Candidates should not be empty');
  for (let i = 1; i < candidates.length; i++) {
    assert(candidates[i - 1].rating_milli >= candidates[i].rating_milli, 'Candidates must be ordered by rating_milli desc');
  }
  console.log('Test 1 passed: Candidates sorted by rating_milli');

  // Test 2: Hard capability filtering
  const toolCandidates = router.selectCandidates({ tools: true });
  for (const c of toolCandidates) {
    assert(c.tools === true, 'Candidate must support tools');
  }
  console.log('Test 2 passed: Tool filtering works');

  // Test 3: Failure recording and cooldown
  const topModel = candidates[0].id;
  router.recordFailure(topModel, 429, 'rate_limit_exceeded');
  const postFailureCandidates = router.selectCandidates({ context: 32000, tools: true });
  assert(postFailureCandidates[0]?.id !== topModel, 'Failed model should be in cooldown');
  console.log('Test 3 passed: Upstream failure cooldown works');

  // Test 4: OpenAI request validation
  assert(validateOpenAIRequest({ messages: [{ role: 'user', content: 'Hi' }] }).valid, 'Valid OpenAI request');
  assert(!validateOpenAIRequest({}).valid, 'Empty request invalid');
  assert(!validateOpenAIRequest({ messages: [] }).valid, 'Empty messages invalid');
  assert(!validateOpenAIRequest({ messages: [{ role: 'user', content: 'Hi' }], temperature: 5 }).valid, 'Invalid temperature');
  console.log('Test 4 passed: OpenAI validator');

  // Test 5: Anthropic request validation
  assert(validateAnthropicRequest({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 100 }).valid, 'Valid Anthropic request');
  assert(!validateAnthropicRequest({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: -1 }).valid, 'Invalid max_tokens');
  console.log('Test 5 passed: Anthropic validator');

  // Test 6: Failures header generation
  router.recordFailure('model-a', 502, 'upstream_error');
  const header = router.getFailuresHeader();
  assert(typeof header['x-makefun-upstream-failures'] === 'string', 'Header must be formatted');
  console.log('Test 6 passed: Failures header generation');

  console.log('All tests passed successfully!');
}

runTests();
