#!/usr/bin/env node
/**
 * Replay a session store through the guard and report what it would repair.
 *
 *   node scripts/audit.mjs <dir-or-file> [more…]
 *
 * Input is decompressed session logs (`session.v4.jsonl`, produced by
 * `zstd -dc session.v4.jsonl.zstd > session.jsonl`). For every recorded
 * `assistant/message` the script expands its stream, runs it through the guard,
 * reassembles both sides and compares them. It reports how many messages were
 * repaired, how many lost their block order, and which repair kinds fired.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_VERSION, conversationIsCjk, guardStream } from '../lib/guard.js';

/** Expand an accumulator stream record into per-delta chunks. */
function expand(stream) {
  const out = [];
  for (const rec of stream) {
    if (rec === null || typeof rec !== 'object') continue;
    if (rec.type === 'chunk') {
      out.push(rec.chunk);
      continue;
    }
    const members = rec.type === 'tool-call-chunks' ? rec.args : rec.texts;
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      if (rec.type === 'text-chunks') out.push({ type: 'text-delta', index: rec.index, text: member });
      else if (rec.type === 'reasoning-chunks') out.push({ type: 'reasoning-delta', index: rec.index, text: member });
      else out.push({ type: 'tool-call-delta', index: rec.index, args: member });
    }
  }
  return out;
}

/** Rebuild blocks in provider order the way the Harness assembler does. */
function assemble(chunks) {
  const partials = new Map();
  const order = [];
  const ensure = (index, type) => {
    let partial = partials.get(index);
    if (partial === undefined) {
      partial = { type, text: '' };
      partials.set(index, partial);
      order.push(index);
    }
    return partial;
  };
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start':
        ensure(chunk.index, chunk.blockType);
        break;
      case 'text-delta':
        ensure(chunk.index, 'text').text += chunk.text;
        break;
      case 'reasoning-delta':
        ensure(chunk.index, 'reasoning').text += chunk.text;
        break;
      case 'tool-call-delta': {
        const partial = ensure(chunk.index, 'tool-call');
        partial.id ??= chunk.id;
        partial.name ??= chunk.name;
        partial.text += chunk.argumentsDelta ?? chunk.args ?? '';
        break;
      }
      case 'block-end': {
        const partial = ensure(chunk.index, chunk.block.type);
        partial.block = chunk.block;
        break;
      }
      default:
        break;
    }
  }
  return order.map((index) => {
    const partial = partials.get(index);
    if (partial.block !== undefined) return partial.block;
    return partial.type === 'tool-call'
      ? { type: 'tool-call', text: partial.text, name: partial.name, id: partial.id }
      : { type: partial.type, text: partial.text };
  });
}

/** Collect `.jsonl` paths under the given arguments. */
function collectInputs(args) {
  const files = [];
  const walk = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (path.endsWith('.jsonl')) {
      files.push(path);
    }
  };
  for (const arg of args) walk(arg);
  return files;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/audit.mjs <dir-or-file> [more…]');
  process.exit(2);
}

const files = collectInputs(args);
const kinds = {};
let messages = 0;
let withStream = 0;
let repaired = 0;
let reordered = 0;

for (const file of files) {
  /** Recent substantive user messages, newest last: the language signal. */
  const userTexts = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const data = record.data;
    if (record.type === 'user/message') {
      const body = data?.message ?? data;
      const content = body?.content;
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content)
          ? content.filter((part) => part?.type === 'text' || part?.type === 'input_text')
            .map((part) => (typeof part.text === 'string' ? part.text : '')).join(' ')
          : '');
      if (text.trim().length >= 20) {
        userTexts.push(text);
        if (userTexts.length > 4) userTexts.shift();
      }
      continue;
    }
    if (record.type !== 'assistant/message' || !Array.isArray(data?.message?.content)) continue;
    messages += 1;
    if (!Array.isArray(data.stream) || data.stream.length === 0) continue;
    withStream += 1;
    const chunks = expand(data.stream);
    const before = assemble(chunks);
    const repairs = [];
    const out = [];
    const source = (async function* replay() {
      for (const chunk of chunks) yield chunk;
    })();
    const userCjk = conversationIsCjk(userTexts.map((text) => ({ role: 'user', content: text })));
    for await (const chunk of guardStream(source, { userCjk, onRepair: (repair) => repairs.push(repair) })) out.push(chunk);
    const after = assemble(out);
    const key = (blocks) => JSON.stringify(blocks);
    if (key(before) === key(after)) continue;
    const sorted = (blocks) => JSON.stringify([...blocks].map((block) => `${block.type}:${block.text ?? ''}`).sort());
    if (sorted(before) === sorted(after)) {
      reordered += 1;
      continue;
    }
    repaired += 1;
    for (const repair of repairs) kinds[repair.kind] = (kinds[repair.kind] ?? 0) + 1;
  }
}

console.log(JSON.stringify({ guardVersion: GUARD_VERSION, files: files.length, assistantMessages: messages, withStream, repaired, reordered, kinds }, null, 2));
