#!/usr/bin/env npx tsx
/**
 * Vercel AI SDK Compatibility Test — Self-Contained Search Engine API
 *
 * Tests the OpenAI-compatible /v1/chat/completions endpoint using the Vercel AI SDK
 * (@ai-sdk/openai). Validates generateText, streamText, and tool calling patterns.
 *
 * Usage:
 *   npx tsx packages/hermes-search/test_vercel_ai_sdk.ts
 *
 * Env Variables:
 *   OPENAI_BASE_URL   Base URL (default: https://609ec5ff.search-engine-api.pages.dev/v1)
 *   OPENAI_API_KEY    API key (default: test-key for open mode)
 *   TEST_MODEL        Model name (default: search-engine)
 *   CI                CI mode — JSON summary, strict exit codes
 */

import { generateText, streamText, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as process from 'node:process';

// ============================================================
// Configuration
// ============================================================

const API_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://609ec5ff.search-engine-api.pages.dev/v1';
const MODEL = process.env.TEST_MODEL ?? 'search-engine';
const API_KEY = process.env.OPENAI_API_KEY ?? 'test-key';
const IS_CI = process.env.CI === 'true';

// Initialize Vercel AI SDK OpenAI provider
// Use .chat() to target the Chat Completions API (/v1/chat/completions)
const provider = createOpenAI({ baseURL: API_BASE_URL, apiKey: API_KEY });
const chatModel = provider.chat(MODEL);

// ============================================================
// Tool Definition — web_search (Vercel AI SDK format)
// ============================================================

const webSearchTool = tool({
  description: 'Search the web for current information. Use for questions about news, trends, facts, or any topic requiring up-to-date data.',
  parameters: z.object({
    query: z.string().describe('The search query (can be in Korean, English, or any language)'),
    max_results: z.number().optional().default(5).describe('Maximum number of search results (1-20)'),
    include_answer: z.boolean().optional().default(true).describe('Include AI-generated answer summary'),
    search_depth: z.enum(['basic', 'advanced']).optional().default('basic').describe('Search depth'),
    topic: z.enum(['general', 'news', 'finance']).optional().default('general').describe('Search topic category'),
    focus: z.enum(['all', 'academic', 'news', 'video', 'social', 'shopping', 'financial'])
      .optional().default('all').describe('Focus mode for specialized search verticals'),
  }),
});

// ============================================================
// Test Infrastructure
// ============================================================

interface TestResult {
  passed: boolean;
  detail: string;
  elapsedMs: number;
  extra?: Record<string, unknown>;
}

const testResults: Record<string, TestResult> = {};

function record(
  name: string,
  passed: boolean,
  detail: string,
  elapsedMs: number = 0,
  extra?: Record<string, unknown>,
): void {
  testResults[name] = { passed, detail: detail.slice(0, 200), elapsedMs, ...(extra ?? {}) };
}

async function checkConnectivity(): Promise<number> {
  const baseUrl = API_BASE_URL
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  const url = `${baseUrl}/api/health`;
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Date.now() - start;
  } catch (e) {
    throw new Error(`API unreachable at ${url}: ${(e as Error).message}`);
  }
}

function printHeader(label: string): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('='.repeat(70));
}

function printSuccess(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function printFailure(msg: string): void {
  console.log(`  ❌ ${msg}`);
}

function printDetail(label: string, value: string): void {
  console.log(`     ${label}: ${value}`);
}

// ============================================================
// Test 1: Basic generateText — non-streaming, no tools
// ============================================================

async function testBasicGenerateText(): Promise<void> {
  printHeader('📝 TEST 1: Basic generateText (Korean query)');

  const start = Date.now();
  const result = await generateText({
    model: chatModel,
    system: 'You are a helpful AI assistant with web search capability.',
    messages: [
      { role: 'user', content: '2026년 AI 트렌드 3가지 알려줘' },
    ],
    maxTokens: 1000,
    temperature: 0.7,
  });
  const elapsed = Date.now() - start;

  printSuccess(`Response in ${elapsed}ms`);
  printDetail('Text length', `${result.text.length} chars`);
  printDetail('Finish reason', result.finishReason);
  printDetail('Usage', JSON.stringify(result.usage));
  printDetail('Preview', `${result.text.slice(0, 200)}...`);

  assert(result.text.length > 0, 'Empty response text');
  assert(result.finishReason === 'stop', `Unexpected finishReason: ${result.finishReason}`);

  record('basic_generateText', true, `${result.text.length} chars in ${elapsed}ms`, elapsed, {
    finishReason: result.finishReason,
  });

  printSuccess('TEST 1 PASSED');
}

// ============================================================
// Test 2: generateText with web_search tool definition
// ============================================================

async function testGenerateTextWithTool(): Promise<void> {
  printHeader('🔧 TEST 2: generateText with web_search Tool');

  const start = Date.now();
  const result = await generateText({
    model: chatModel,
    system: 'You are a helpful assistant with web search tools.',
    messages: [
      { role: 'user', content: 'Search for the latest developments in quantum computing' },
    ],
    tools: { web_search: webSearchTool },
    toolChoice: 'auto',
    maxTokens: 500,
  });
  const elapsed = Date.now() - start;

  printSuccess(`Response in ${elapsed}ms`);
  printDetail('Finish reason', result.finishReason);
  printDetail('Text length', `${result.text.length} chars`);
  printDetail('Tool calls', `${result.toolCalls?.length ?? 0}`);

  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const tc of result.toolCalls) {
      const argsPreview = tc.args ? JSON.stringify(tc.args).slice(0, 200) : '(undefined — JSON schema parse pending in AI SDK)';
      console.log(`\n     🔧 Tool call: ${tc.toolName}`);
      console.log(`        Args: ${argsPreview}`);
    }
    printDetail('Tool calls detected!', `${result.toolCalls.length} tool calls`);
  }

  // Allow either text content or tool calls (or both)
  assert(result.text.length > 0 || (result.toolCalls && result.toolCalls.length > 0),
    'Expected text and/or tool calls');

  const detail = result.toolCalls && result.toolCalls.length > 0
    ? `${result.toolCalls.length} tool calls, ${result.text.length} text chars`
    : `Tool definitions accepted, ${result.text.length} chars`;
  record('generateText_with_tool', true, detail, elapsed, {
    toolCallCount: result.toolCalls?.length ?? 0,
  });
  printSuccess('TEST 2 PASSED');
}

// ============================================================
// Test 3: streamText — streaming text generation
// ============================================================

async function testStreamText(): Promise<void> {
  printHeader('🌊 TEST 3: streamText (Streaming Text Generation)');

  const start = Date.now();
  const result = streamText({
    model: chatModel,
    system: 'You are a helpful AI assistant.',
    messages: [
      { role: 'user', content: 'Explain the benefits of streaming in AI applications in 3 bullet points.' },
    ],
    maxTokens: 500,
  });

  let fullText = '';
  let chunkCount = 0;

  // Consume the text stream
  for await (const chunk of result.textStream) {
    fullText += chunk;
    chunkCount++;
  }

  const elapsed = Date.now() - start;
  const finishReason = await result.finishReason;

  printSuccess(`Stream completed in ${elapsed}ms`);
  printDetail('Total chunks', `${chunkCount}`);
  printDetail('Total chars', `${fullText.length}`);
  printDetail('Finish reason', finishReason);
  printDetail('Usage', JSON.stringify(await result.usage));

  assert(chunkCount > 0, 'No chunks received from stream');
  assert(fullText.length > 0, 'Empty streamed text');
  assert(finishReason === 'stop' || finishReason === 'unknown', `Unexpected finishReason: ${finishReason}`);

  record('streamText', true, `${chunkCount} chunks, ${fullText.length} chars in ${elapsed}ms`, elapsed, {
    chunkCount,
    finishReason,
  });

  printSuccess('TEST 3 PASSED');
}

// ============================================================
// Test 4: streamText with tools (streaming + function calling surface)
// ============================================================

async function testStreamTextWithTool(): Promise<void> {
  printHeader('🔧🌊 TEST 4: streamText with web_search Tool');

  const start = Date.now();
  const result = streamText({
    model: chatModel,
    system: 'You are a helpful assistant with search tools. Provide detailed answers.',
    messages: [
      { role: 'user', content: 'What are the key advantages of edge computing?' },
    ],
    tools: { web_search: webSearchTool },
    toolChoice: 'auto',
    maxTokens: 800,
  });

  let fullText = '';
  let toolCallEvents = 0;

  // Use fullStream to monitor tool call events alongside text
  for await (const event of result.fullStream) {
    if (event.type === 'text-delta') {
      fullText += event.textDelta;
    } else if (event.type === 'tool-call') {
      toolCallEvents++;
      const argsPreview = event.args ? JSON.stringify(event.args).slice(0, 150) : '(undefined)';
      console.log(`\n     🔧 Tool call event: ${event.toolName}`);
      console.log(`        Args: ${argsPreview}`);
    }
  }

  const elapsed = Date.now() - start;
  const finishReason = await result.finishReason;

  printSuccess(`Stream completed in ${elapsed}ms`);
  printDetail('Text length', `${fullText.length} chars`);
  printDetail('Tool call events', `${toolCallEvents}`);
  printDetail('Finish reason', finishReason);
  printDetail('Usage', JSON.stringify(await result.usage));

  // Should have either text, tool calls, or both
  const hasContent = fullText.length > 0 || toolCallEvents > 0
  assert(hasContent, 'Empty stream — no text or tool calls');

  record('streamText_with_tool', true, `${toolCallEvents} tool events, ${fullText.length} chars`, elapsed);
  printSuccess('TEST 4 PASSED');
}

// ============================================================
// Test 5: Multi-turn conversation simulation
// ============================================================

async function testMultiTurnConversation(): Promise<void> {
  printHeader('💬 TEST 5: Multi-turn Conversation Simulation');

  const questions = [
    'What are the latest developments in AI agents?',
    'Which companies are leading in this space?',
  ];

  const    messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const systemPrompt = 'You are a research assistant. Always base your answers on web search results and cite sources.';

  for (let i = 0; i < questions.length; i++) {
    console.log(`\n   🗣️ Turn ${i + 1}: ${questions[i]}`);
    messages.push({ role: 'user' as const, content: questions[i] });

    const start = Date.now();
    const result = await generateText({
      model: chatModel,
      system: systemPrompt,
      messages,
      tools: { web_search: webSearchTool },
      toolChoice: 'auto',
      maxTokens: 800,
    });
    const elapsed = Date.now() - start;

    printSuccess(`Response in ${elapsed}ms`);
    printDetail('Length', `${result.text.length} chars`);
    printDetail('Finish reason', result.finishReason);
    printDetail('Preview', `${result.text.slice(0, 150)}...`);

    messages.push({ role: 'assistant' as const, content: result.text });
  }

  record('multi_turn', true, `${questions.length} turns, ${messages.length} total messages`);
  printSuccess('TEST 5 PASSED');
  console.log(`\n   📊 Total messages in conversation: ${messages.length}`);
}

// ============================================================
// Test 6: Multi-model testing
// ============================================================

async function testMultiModel(): Promise<void> {
  printHeader('📋 TEST 6: Multi-model Testing');

  const modelsToTest = ['search-engine', 'search-engine-deep', 'research-engine'];
  const results: Array<{ model: string; passed: boolean; elapsedMs: number }> = [];

  for (const modelName of modelsToTest) {
    const model = provider.chat(modelName);
    const start = Date.now();
    try {
      const result = await generateText({
        model,
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 50,
      });
      const elapsed = Date.now() - start;
      const ok = result.text.length > 0;
      printSuccess(`${modelName}: ${elapsed}ms — ${ok ? 'OK' : 'empty'}`);
      results.push({ model: modelName, passed: ok, elapsedMs: elapsed });
    } catch (e) {
      printFailure(`${modelName}: ${(e as Error).message.slice(0, 80)}`);
      results.push({ model: modelName, passed: false, elapsedMs: 0 });
    }
  }

  const allOk = results.every(r => r.passed);
  record('multi_model', allOk, `${results.filter(r => r.passed).length}/${results.length} models OK`, 0, { modelResults: results });
  assert(allOk, `Model tests: ${results.filter(r => r.passed).length}/${results.length} passed`);
  printSuccess('TEST 6 PASSED');
}

// ============================================================
// Main Runner
// ============================================================

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<number> {
  console.log('\n🚀 Vercel AI SDK Compatibility Test Suite');
  console.log(`   Base URL: ${API_BASE_URL}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   AI SDK: v7 (createOpenAI → .chat() → Chat Completions API)`);
  console.log(`   CI Mode: ${IS_CI ? 'Yes' : 'No'}`);
  console.log(`   Time: ${new Date().toISOString()}`);

  // Connectivity check
  try {
    const latency = await checkConnectivity();
    console.log(`   ✅ API reachable (baseline: ${latency}ms)\n`);
  } catch (e) {
    console.log(`   ❌ ${(e as Error).message}`);
    record('connectivity', false, (e as Error).message);
    emitJsonSummary();
    return 2;
  }

  // Run tests
  const tests: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: 'basic_generateText', fn: testBasicGenerateText },
    { name: 'generateText_with_tool', fn: testGenerateTextWithTool },
    { name: 'streamText', fn: testStreamText },
    { name: 'streamText_with_tool', fn: testStreamTextWithTool },
    { name: 'multi_turn', fn: testMultiTurnConversation },
    { name: 'multi_model', fn: testMultiModel },
  ];

  for (const { name, fn } of tests) {
    try {
      await fn();
    } catch (e) {
      printFailure(`TEST FAILED (${name}): ${(e as Error).message}`);
      if (!testResults[name]) {
        record(name, false, (e as Error).message);
      }
    }
  }

  // Summary
  const passed = Object.values(testResults).filter(r => r.passed).length;
  const total = Object.keys(testResults).length;
  const failedNames = Object.entries(testResults)
    .filter(([_, r]) => !r.passed)
    .map(([n, _]) => n);

  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(70));
  for (const [name, r] of Object.entries(testResults).sort()) {
    const icon = r.passed ? '✅' : '❌';
    const elapsed = r.elapsedMs ? ` (${r.elapsedMs}ms)` : '';
    console.log(`   ${icon} ${name}${elapsed} — ${r.detail}`);
  }

  console.log(`\n   📈 ${passed}/${total} tests passed`);
  if (failedNames.length > 0) {
    console.log(`   ❌ Failed: ${failedNames.join(', ')}`);
  }

  // Emit JSON for CI
  if (IS_CI) {
    emitJsonSummary();
    writeGitHubSummary(passed, total, failedNames);
  }

  return passed === total ? 0 : 1;
}

function emitJsonSummary(): void {
  const summary = {
    status: Object.values(testResults).every(r => r.passed) ? 'passed' as const : 'failed' as const,
    timestamp: new Date().toISOString(),
    api_base_url: API_BASE_URL,
    model: MODEL,
    framework: 'vercel-ai-sdk',
    results: Object.fromEntries(
      Object.entries(testResults).map(([name, r]) => [
        name,
        { passed: r.passed, detail: r.detail, elapsed_ms: r.elapsedMs },
      ]),
    ),
    summary: {
      total: Object.keys(testResults).length,
      passed: Object.values(testResults).filter(r => r.passed).length,
      failed: Object.values(testResults).filter(r => !r.passed).length,
    },
  };

  console.log(`\n---JSON-START---\n${JSON.stringify(summary, null, 2)}\n---JSON-END---`);
}

function writeGitHubSummary(passed: number, total: number, failed: string[]): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  try {
    const lines: string[] = [
      '## ⚡ Vercel AI SDK Compatibility Test Results\n',
      '| Metric | Value |',
      '|--------|-------|',
      `| **API URL** | \`${API_BASE_URL}\` |`,
      `| **Model** | \`${MODEL}\` |`,
      `| **Tests** | ${passed}/${total} |`,
      `| **Status** | ${passed === total ? '✅ Passed' : '❌ Failed'} |`,
      `| **Timestamp** | ${new Date().toISOString()} |`,
      '',
    ];

    if (failed.length > 0) {
      lines.push('### ❌ Failed Tests\n');
      for (const name of failed) {
        const r = testResults[name];
        lines.push(`- **${name}**: ${r?.detail ?? 'unknown error'}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('_Powered by @ai-sdk/openai + @vercel/ai SDK v7_');

    fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch {
    // Ignore write errors
  }
}

// Run
main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(`Fatal error: ${e.message}`);
    process.exit(2);
  });
