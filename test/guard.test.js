import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { GUARD_VERSION, classifyLeading, guardStream, stripMarkup } from '../lib/guard.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Rebuild a chunk list from a fixture file.
 * @param {string} name - fixture base name.
 * @returns {{provider: string, model: string, chunks: any[]}} fixture.
 */
function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/**
 * Drive the guard over a chunk list.
 * @param {any[]} chunks - input chunks.
 * @param {object} [options] - guard options.
 * @returns {Promise<any[]>} emitted chunks.
 */
async function run(chunks, options) {
  async function* source() {
    for (const chunk of chunks) yield chunk;
  }
  const out = [];
  for await (const chunk of guardStream(source(), options)) out.push(chunk);
  return out;
}

/**
 * Minimal mirror of the Harness block assembler, enough to read a call's channels.
 * @param {any[]} chunks - emitted chunks.
 * @returns {{blocks: any[], finish: any}} assembled blocks and terminal chunk.
 */
function assemble(chunks) {
  const partials = new Map();
  const order = [];
  let finish;
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      if (!partials.has(chunk.index)) {
        order.push(chunk.index);
        partials.set(chunk.index, { blockType: chunk.blockType, text: '', closed: false });
      }
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      let partial = partials.get(chunk.index);
      if (partial === undefined) {
        partial = { blockType: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '', closed: false };
        order.push(chunk.index);
        partials.set(chunk.index, partial);
      }
      if (!partial.closed) partial.text += chunk.text;
    } else if (chunk.type === 'block-end') {
      const partial = partials.get(chunk.index);
      if (partial !== undefined && !partial.closed) {
        partial.closed = true;
        partial.block = chunk.block;
      }
    } else if (chunk.type === 'finish') {
      finish = chunk;
    }
  }
  const blocks = order.map((index) => {
    const partial = partials.get(index);
    if (partial.block !== undefined) return partial.block;
    return partial.blockType === 'reasoning'
      ? { type: 'reasoning', text: partial.text }
      : { type: 'text', text: partial.text };
  });
  return { blocks, finish };
}

test('classifyLeading settles markup, prefixes, and plain text', () => {
  assert.equal(classifyLeading('<thinking>hello').state, 'reasoning');
  assert.equal(classifyLeading('<thinking>hello').rest, 'hello');
  assert.equal(classifyLeading('  \n<thinking>hi').state, 'reasoning');
  assert.equal(classifyLeading('</thinking>tail').state, 'reasoning');
  assert.equal(classifyLeading('</thinking>tail').rest, 'tail');
  assert.equal(classifyLeading('```thinking\nbody').state, 'reasoning');
  assert.equal(classifyLeading('<thi').state, 'pending');
  assert.equal(classifyLeading('<').state, 'pending');
  assert.equal(classifyLeading('<!-- note').state, 'text');
  assert.equal(classifyLeading('# Heading').state, 'text');
  assert.equal(classifyLeading('答案如下：').state, 'text');
  assert.equal(classifyLeading('').state, 'pending');
});

test('stripMarkup removes every supported token', () => {
  assert.equal(stripMarkup('<thinking>a</thinking>'), 'a');
  assert.equal(stripMarkup('<think >b</think>'), 'b');
  assert.equal(stripMarkup('<|thinking|>c'), 'c');
  assert.equal(stripMarkup('plain'), 'plain');
});

test('a tag split across deltas is not truncated or rendered raw', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thi' },
    { type: 'text-delta', index: 0, text: 'nking>the plan is</thin' },
    { type: 'text-delta', index: 0, text: 'king> done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>the plan is</thinking> done' } },
  ]);
  const { blocks } = assemble(out);
  assert.deepEqual(blocks, [{ type: 'reasoning', text: 'the plan is done' }]);
  assert.equal(out[0].blockType, 'reasoning');
});

test('markup in the middle of a visible answer is left exactly as written', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'name is `<thinking>` and `</thinking>`, not a channel' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'name is `<thinking>` and `</thinking>`, not a channel' } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('a real leaked Kimi turn moves its reasoning out of the answer', async () => {
  const { chunks } = fixture('leak-14-2');
  const before = assemble(chunks);
  const out = await run(chunks);
  const after = assemble(out);
  const beforeText = before.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.ok(/<\/?thinking/i.test(beforeText), 'fixture must actually carry leaked markup');
  const afterText = after.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(afterText.includes('<thinking'), false);
  assert.equal(afterText.includes('</thinking>'), false);
  const reasoning = after.blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('');
  assert.ok(reasoning.length > 0, 'leaked reasoning must survive in the reasoning channel');
  assert.equal(after.finish.replayState, undefined, 'repaired streams drop stale replay metadata');
});

test('a lowercase continuation after a dangling function word is moved to reasoning', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '- 1 Business panorama and cross-module flow, perhaps' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '- 1 Business panorama and cross-module flow, perhaps' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '\ntable with 8 steps and states.' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '\ntable with 8 steps and states.' } },
  ]);
  assert.deepEqual(assemble(out).blocks, [
    { type: 'reasoning', text: '- 1 Business panorama and cross-module flow, perhaps' },
    { type: 'reasoning', text: '\ntable with 8 steps and states.' },
  ]);
});

test('a lowercase continuation after a CJK fragment is moved to reasoning', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'P03-04 P18 zero consumption direct no分摊' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'P03-04 P18 zero consumption direct no分摊' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'perhaps fully消缺? P03-04 old zero denominator.' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'perhaps fully消缺? P03-04 old zero denominator.' } },
  ]);
  assert.deepEqual(assemble(out).blocks.map((block) => block.type), ['reasoning', 'reasoning']);
});

test('a lowercase answer after a complete reasoning word stays in the answer channel', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('a real channel flip with a lowercase head is moved to reasoning (turn 22 step 10)', async () => {
  const { chunks } = fixture('leak-22-10');
  const out = await run(chunks);
  const after = assemble(out);
  const text = after.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(text.includes('perhaps fully'), false, 'leaked plan text must leave the answer channel');
  assert.equal(after.blocks.filter((block) => block.type === 'reasoning').length, 2);
});

test('a real channel flip with a lowercase head is moved to reasoning (turn 22 step 13)', async () => {
  const { chunks } = fixture('leak-22-13');
  const out = await run(chunks);
  const after = assemble(out);
  const text = after.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(text.includes('table with 8 steps'), false);
  assert.ok(after.blocks.filter((block) => block.type === 'reasoning').length >= 2);
});

test('a healthy DeepSeek turn passes through byte-for-byte', async () => {
  const { chunks } = fixture('healthy-1-1');
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('a tool-call-only turn passes through byte-for-byte', async () => {
  const { chunks } = fixture('toolonly-3-1');
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('a reply stranded in the reasoning channel is also emitted as the answer', async () => {
  const body = '这是最终答复：先把结论说清楚，再列出三条依据和两条补充说明，最后给出下一步建议。';
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: body },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: body } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const { blocks } = assemble(out);
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: body },
    { type: 'text', text: body },
  ]);
  assert.deepEqual(out.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('the rescue stays off for tool calls, truncation, and short bodies', async () => {
  const resume = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'short' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'short' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  assert.deepEqual(assemble(await run(resume)).blocks.length, 1);

  const long = 'x'.repeat(200);
  const truncated = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: long },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: long } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ];
  assert.equal(assemble(await run(truncated)).blocks.length, 1);

  const withTool = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: long },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: long } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'bash', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
  assert.equal(assemble(await run(withTool)).blocks.length, 2);
});

test('dry run reports repairs but emits the original stream', async () => {
  const { chunks } = fixture('leak-14-2');
  const repairs = [];
  const out = await run(chunks, { dryRun: true, onRepair: (repair) => repairs.push(repair) });
  assert.deepEqual(out, chunks);
  assert.ok(repairs.length > 0, 'dry run still records what it would repair');
});

test('a stream cut mid-block releases the held text instead of dropping it', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial answer' },
  ]);
  const { blocks } = assemble(out);
  assert.deepEqual(blocks, [{ type: 'text', text: 'partial answer' }]);
});

test('an empty text block stays empty and keeps its channel', async () => {
  const out = await run([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  ]);
  assert.deepEqual(assemble(out).blocks, [{ type: 'text', text: '' }]);
});

test('replay metadata survives an untouched stream', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: {}, blocks: [{ type: 'reasoning' }, { type: 'text' }] } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('an unrecognized chunk is forwarded and cannot break the pass', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello' },
    { type: 'mystery-chunk' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('a healthy third-party turn keeps its channels and text', async () => {
  const data = fixture('healthy-kimi-7-4');
  const out = await run(data.chunks);
  const { blocks } = assemble(out);
  assert.deepEqual(blocks, data.content);
});

test('the leaked body survives the move, minus its markup', async () => {
  const { chunks } = fixture('leak-11-26');
  const before = assemble(chunks);
  const leaked = before.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const after = assemble(await run(chunks));
  const moved = after.blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('');
  const strip = (text) => text.replace(/<\/?think(?:ing)?\s*>/gi, '').trim();
  assert.equal(strip(moved), strip(leaked));
  assert.ok(strip(leaked).length > 400, 'fixture must carry a substantial body');
});

test('a text block that continues reasoning mid-token is moved to the reasoning channel', async () => {
  const { chunks } = fixture('leak-1-97');
  const before = assemble(chunks);
  const beforeText = before.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.ok(beforeText.length > 3000, 'fixture must actually carry the leaked deliberation');
  assert.equal(/^\s*<\/?thinking/i.test(beforeText), false, 'the leak does not open with markup');
  const out = await run(chunks);
  const after = assemble(out);
  const afterText = after.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  assert.equal(afterText, '', 'no visible text may be left on a tool-call turn');
  const reasoning = after.blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('');
  assert.ok(reasoning.length > beforeText.length, 'the leaked body moves into the reasoning channel');
  assert.ok(after.blocks.some((block) => block.type === 'tool-call'), 'the tool call is preserved');
  assert.equal(after.blocks.length, before.blocks.length, 'the block count is preserved');
});

test('the continuation rule leaves a self-contained narration sentence alone', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'I still have to check the token path' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'I still have to check the token path' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Now I will read the file.' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Now I will read the file.' } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('the continuation rule leaves a lowercase answer after a finished sentence alone', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'The scan is done.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'The scan is done.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'const x = 1;' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'const x = 1;' } },
  ];
  const out = await run(chunks);
  assert.deepEqual(out, chunks);
});

test('the continuation rule can be switched off', async () => {
  const { chunks } = fixture('leak-1-97');
  const out = await run(chunks, { rules: { continuationRouting: false } });
  const after = assemble(out);
  assert.ok(after.blocks.some((block) => block.type === 'text'));
});


test('the build marker matches the shipped manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(GUARD_VERSION, pkg.version);
});
