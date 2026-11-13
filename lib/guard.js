/**
 * Thinking-channel guard: a streaming repair pass over Harness model chunks.
 *
 * Three provider-side defects deliver content in the wrong channel:
 *
 *  1. **reasoning spliced into the text channel.** OpenAI-compatible shims that
 *     pipe `reasoning_content` into `content` (or models that hand-write the
 *     tags) produce `text` blocks whose body is really thinking, usually opening
 *     with `<thinking>` markup. The user reads it as the answer.
 *
 *  2. **a channel flip mid-stream.** The provider closes the thinking block and
 *     keeps the same sentence going as text. No markup marks the seam, so only
 *     the bytes give it away: the reasoning body stops mid-token and the next
 *     characters cannot begin a sentence of their own.
 *
 *  3. **the answer produced entirely as reasoning.** A turn whose final call
 *     emits one `reasoning` block, no text and no tool call, leaves the reply
 *     inside a collapsed Think row.
 *
 *  4. **untagged deliberation in the text channel.** The provider closes the
 *     thinking block and starts a fresh sentence in `text` that is still
 *     deliberation ("The file doesn't exist... Could it be... Let me try
 *     again"). Nothing marks the seam, but the bytes do: a mid-turn text block
 *     in a Chinese-language conversation that is long and carries no CJK at all
 *     is thinking, not the answer.
 *
 * This pass re-emits the affected chunks in the correct channel. It never
 * rewrites a visible answer: the only content it removes are leaked markup
 * tokens inside a block it just moved to the reasoning channel. Every internal
 * failure degrades to plain pass-through, so the guard can never lose or
 * truncate a model call.
 *
 * @module dsh-thinking-channel-guard/guard
 */
import { readFileSync } from 'node:fs';

/**
 * Build marker, echoed in the repair log so a loaded generation is identifiable.
 * Read from the shipped manifest, so the log, the tarball and the repository can
 * never disagree about which version is running.
 */
export const GUARD_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Markup tokens that mark a leak boundary. Matched case-insensitively. */
const TAG_PATTERNS = [
  /<thinking\s*>/gi,
  /<\/thinking\s*>/gi,
  /<think\s*>/gi,
  /<\/think\s*>/gi,
  /<\|thinking\|>/gi,
  /\|\/thinking\|>/gi,
];

/** Fence form: a ```thinking opening fence at the very start of a block. */
const FENCE_OPEN = /^```think(?:ing)?[ \t]*\r?\n/i;

/** Literal prefixes a held tail could still grow into. */
const TAG_PREFIXES = [
  '<thinking>',
  '</thinking>',
  '<think>',
  '</think>',
  '<|thinking|>',
  '|/thinking|>',
];

/** Longest tail kept back while waiting for a possible split markup token. */
const TAIL_WINDOW = 12;

/** Longest leading buffer accumulated before the routing decision is forced. */
const LEAD_CAP = 64;

export const DEFAULT_RULES = Object.freeze({
  /** Text that opens with thinking markup is emitted as reasoning instead. */
  tagRouting: true,
  /** Markup tokens are removed from a block that was moved to the reasoning channel. */
  stripTags: true,
  /** A reasoning-only final call is additionally emitted as the answer text. */
  answerRescue: true,
  /** A text block that continues the previous reasoning mid-token is reasoning. */
  continuationRouting: true,
  /** Mid-turn English deliberation inside a CJK conversation is reasoning. */
  deliberationRouting: true,
});

/** A block body that ends without terminal punctuation is still mid-sentence. */
const TERMINAL_TAIL = /[.!?。！？;；:：)）\]}>"'”』】]\s*$/;

/** Continuation openings: punctuation that cannot begin a sentence of its own. */
const CONTINUATION_HEAD = /^[\s]*[`,)\]}"'”→、。，;:]/;

/**
 * A lowercase ASCII word opening a text block: a visible answer never starts this
 * way after a mid-sentence reasoning tail, while a channel flip continues the
 * reasoning sentence ("...cross-module flow, perhaps" → "table with 8 steps").
 */
const LOWERCASE_HEAD = /^[\s]*[a-z]/;

/** Shortest mid-turn text body that can be judged deliberation rather than a note. */
const DELIBERATION_MIN_CHARS = 200;

/** Any CJK ideograph: a visible answer in a CJK conversation always carries some. */
const CJK_ANY = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

/** Deliberation phrasing that no visible answer uses twice in one paragraph. */
const DELIBERATION_MARKERS = /\b(let me|let's|i'll|i should|i need to|i have to|could it be|that's strange|the user is saying|the user wants|i'm currently|i am currently|perhaps|maybe|hmm|wait|actually)\b/gi;

/** Below this Latin share a block reads as a written answer, not as thinking. */
const DELIBERATION_LATIN_SHARE = 0.5;

/**
 * Share of ASCII letters in a text.
 * @param {string} text - candidate body.
 * @returns {number} letters divided by length.
 */
function latinShare(text) {
  if (text === '') return 0;
  return (text.match(/[A-Za-z]/g) ?? []).length / text.length;
}

/**
 * Count unambiguously deliberative phrases.
 * @param {string} text - candidate body.
 * @returns {number} number of matches.
 */
function deliberationMarkers(text) {
  DELIBERATION_MARKERS.lastIndex = 0;
  return (text.match(DELIBERATION_MARKERS) ?? []).length;
}

/** Trailing words a sentence cannot end on; a flip starts right after them. */
const FUNCTION_TAIL_WORDS = new Set(
  ('a an the of to in on at for with and or but that which who whose is are was were be been being '
    + 'as than then if because while when where how why such like per via from into by about after '
    + 'before over under between through during without within against among across along around '
    + 'behind below beneath beside beyond near off onto out outside since till toward towards until '
    + 'upon versus whether yet so nor do does did done has have had will would shall should can could '
    + 'may might must not no yes its their our your his her them they we you i it this these those '
    + 'there here perhaps maybe likely roughly approximately').split(' '),
);

/** A reasoning body trailing off inside a CJK phrase. */
const CJK_TAIL = /[\u3400-\u4DBF\u4E00-\u9FFF]\s*$/;

/** Shortest head worth judging; below this the block keeps waiting. */
const FLIP_MIN = 4;

/** Longest body inspected to judge a previous block's tail. */
const TAIL_CHECK = 64;

/**
 * Whether a block body may continue into the next block's first bytes.
 * @param {string} tail - trailing body of the previous block.
 * @returns {boolean} true when the previous block stopped mid-sentence.
 */
function endsMidToken(tail) {
  return tail.trim() !== '' && !TERMINAL_TAIL.test(tail);
}

/** The last ASCII word of a body, lowercased, or an empty string. */
function lastToken(tail) {
  const match = tail.match(/([A-Za-z][A-Za-z'\u2019-]*|\d+)\s*$/);
  return match === null ? '' : match[1].toLowerCase();
}

/**
 * Whether a reasoning body stops where a new sentence cannot begin: on a word that
 * needs a continuation, or inside a CJK phrase.
 * @param {string} tail - trailing body of the previous block.
 * @returns {boolean} true when the tail cannot stand as a sentence ending.
 */
function tailNeedsContinuation(tail) {
  return FUNCTION_TAIL_WORDS.has(lastToken(tail)) || CJK_TAIL.test(tail);
}

/**
 * Whether a text body continues the previous block instead of starting one.
 * @param {string} head - leading bytes of the candidate text block.
 * @param {string} tail - trailing body of the previous block.
 * @returns {boolean} true when the bytes can only be a continuation.
 */
function continuesPrevious(head, tail) {
  if (CONTINUATION_HEAD.test(head)) return true;
  return LOWERCASE_HEAD.test(head) && tailNeedsContinuation(tail);
}

/** How many recent user messages are sampled for the conversation language. */
const LANGUAGE_WINDOW = 12;

/** How many characters of the sampled user text are inspected at most. */
const LANGUAGE_BUDGET = 40000;

/**
 * Join the text parts of one conversation message.
 * @param {any} message - conversation message.
 * @returns {string} plain text.
 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part !== null && typeof part === 'object' && (part.type === 'text' || part.type === 'input_text'))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join(' ');
}

/**
 * Whether the conversation the request carries is CJK-language.
 *
 * The newest user message alone is not enough: the harness also records short
 * English notices (approval-policy changes, timestamps, retries) as user turns,
 * and those can outnumber the real ask. The share of CJK characters across the
 * recent user text is stable against that noise and against a conversation that
 * switches model or provider.
 *
 * @param {any} messages - request messages.
 * @returns {boolean} true when the conversation is CJK-dominant.
 */
export function conversationIsCjk(messages) {
  if (!Array.isArray(messages)) return false;
  let cjk = 0;
  let total = 0;
  let sampled = 0;
  for (let i = messages.length - 1; i >= 0 && sampled < LANGUAGE_WINDOW && total < LANGUAGE_BUDGET; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = textOf(message);
    if (text === '') continue;
    sampled += 1;
    total += text.length;
    cjk += (text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) ?? []).length;
  }
  if (total === 0) return false;
  return cjk >= 20 && cjk / total >= 0.15;
}

/** Shortest rescued reasoning body worth surfacing as an answer. */
const ANSWER_MIN_CHARS = 40;

/**
 * Remove complete markup tokens from a string.
 * @param {string} text - candidate content.
 * @returns {string} content without markup tokens.
 */
export function stripMarkup(text) {
  let out = text;
  for (const pattern of TAG_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '');
  }
  return out;
}

/**
 * Whether a string still carries markup tokens.
 * @param {string} text - candidate content.
 * @returns {boolean} true when at least one token is present.
 */
export function hasMarkup(text) {
  return TAG_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * Index from which a tail must be held back because it may extend into a tag.
 * @param {string} text - accumulated but not yet emitted content.
 * @returns {number} start index of the held tail, or `text.length` when free.
 */
function holdFrom(text) {
  const at = text.lastIndexOf('<');
  const fence = text.lastIndexOf('|');
  const start = Math.max(at, fence);
  if (start === -1) return text.length;
  const suffix = text.slice(start);
  if (suffix.length > TAIL_WINDOW) return text.length;
  return TAG_PREFIXES.some((tag) => tag.length > suffix.length && tag.startsWith(suffix))
    ? start
    : text.length;
}

/**
 * Streaming filter that removes markup tokens split across chunk boundaries.
 * It holds back a short tail so a token cut in half is never rendered raw.
 */
class MarkupFilter {
  /** @type {string} */
  #held = '';

  /** @type {boolean} */
  #removed = false;

  /** @type {boolean} */
  #enabled;

  /** @param {boolean} [enabled] - whether tokens are removed from emitted content. */
  constructor(enabled = true) {
    this.#enabled = enabled;
  }

  /** Whether the filter removed anything since the last reset. */
  get removed() {
    return this.#removed;
  }

  /**
   * Accept one delta and return the content that is safe to emit now.
   * @param {string} text - next delta.
   * @returns {string} emit-ready content, possibly empty.
   */
  feed(text) {
    if (text === '') return '';
    if (!this.#enabled) return text;
    const pending = this.#held + text;
    const cut = holdFrom(pending);
    const safe = pending.slice(0, cut);
    this.#held = pending.slice(cut);
    const cleaned = stripMarkup(safe);
    if (cleaned !== safe) this.#removed = true;
    return cleaned;
  }

  /**
   * Release the held tail at block end.
   * @returns {string} emit-ready remainder.
   */
  flush() {
    if (!this.#enabled) return '';
    const pending = this.#held;
    this.#held = '';
    const cleaned = stripMarkup(pending);
    if (cleaned !== pending) this.#removed = true;
    return cleaned;
  }
}

/**
 * Match one complete markup token at the very start of a string.
 * @param {string} body - candidate content.
 * @returns {string | null} the token, or null.
 */
function matchLeadingTag(body) {
  for (const pattern of TAG_PATTERNS) {
    pattern.lastIndex = 0;
    const candidate = pattern.exec(body);
    if (candidate !== null && candidate.index === 0) return candidate[0];
  }
  return null;
}

/**
 * Whether a string is still a prefix of some markup token, so the decision must wait.
 * @param {string} body - candidate content.
 * @returns {boolean} true while it could still become a token.
 */
function isTagPrefix(body) {
  if (body === '' ) return true;
  if (body.length > TAIL_WINDOW) return false;
  return TAG_PREFIXES.some((tag) => tag.length > body.length && tag.startsWith(body));
}

/**
 * Decide the channel of a text block from its leading bytes.
 *
 * Complete thinking markup at the start settles it immediately. A leading part
 * that can still grow into such markup keeps the decision open, and any other
 * opening settles it as ordinary text on the first delta.
 *
 * @param {string} buffer - content accumulated so far.
 * @returns {{state: 'pending'|'text'|'reasoning', rest: string}} decision and
 *   the content left after consuming any leading markup.
 */
export function classifyLeading(buffer) {
  let body = buffer.replace(/^\s*/, '');
  let consumed = false;
  for (;;) {
    const fence = FENCE_OPEN.exec(body);
    if (fence !== null) {
      consumed = true;
      body = body.slice(fence[0].length);
      continue;
    }
    const tag = matchLeadingTag(body);
    if (tag !== null) {
      consumed = true;
      body = body.slice(tag.length);
      continue;
    }
    if (consumed) return { state: 'reasoning', rest: body };
    if (isTagPrefix(body) || body === '') return { state: 'pending', rest: buffer };
    return { state: 'text', rest: buffer };
  }
}

/**
 * One repair pass over one model call.
 *
 * Blocks are tracked by index because providers interleave them: a tool call can
 * open while a text block is still streaming, so a single "current block" would
 * lose the held text at the wrong moment.
 */
export class GuardPass {
  /** @param {object} options - pass configuration. */
  constructor(options = {}) {
    this.rules = { ...DEFAULT_RULES, ...(options.rules ?? {}) };
    this.dryRun = options.dryRun === true;
    this.onRepair = typeof options.onRepair === 'function' ? options.onRepair : undefined;

    /** @type {Map<number, any>} open blocks by index. */
    this.blocks = new Map();
    this.seenText = false;
    this.seenReasoning = false;
    this.seenToolCall = false;
    this.mutated = false;
    this.rescued = false;
    this.reasoningText = '';
    this.inserted = 0;
    this.maxIndex = -1;
    /** @type {number | null} index of the text block whose channel is undecided. */
    this.pendingIndex = null;
    /** @type {{kind: string, tail: string} | null} last block body seen. */
    this.lastClosed = null;
    // Live tail of the newest reasoning bytes: a channel flip can start before the
    // reasoning block's own block-end arrives, so a closed-block tail is not enough.
    this.recentKind = null;
    this.recentTail = '';
    /** @type {boolean} whether the conversation's request is CJK-dominant. */
    this.userCjk = options.userCjk === true;
    /** @type {{chunk: any} | null} text block-end held until the next block is known. */
    this.pendingTextEnd = null;
    this.repairs = [];
  }

  /**
   * Record one repair for the caller's diagnostics.
   * @param {string} kind - repair name.
   * @param {object} detail - small serializable detail.
   * @returns {void}
   */
  #note(kind, detail) {
    const entry = { kind, ...detail };
    this.repairs.push(entry);
    this.onRepair?.(entry);
  }

  /**
   * Build the delta chunk for a block in its decided channel.
   * @param {{info: {index: number, kind: string}}} block - block state.
   * @param {string} text - cleaned delta.
   * @returns {any} delta chunk.
   */
  #delta(block, text) {
    return block.kind === 'reasoning'
      ? { type: 'reasoning-delta', index: block.index, text }
      : { type: 'text-delta', index: block.index, text };
  }

  /**
   * Append cleaned content to a block and to the rescue accumulator.
   * @param {any} block - block state.
   * @param {string} text - cleaned delta.
   * @returns {void}
   */
  #absorb(block, text) {
    if (text === '') return;
    block.text += text;
    if (block.kind === 'reasoning') {
      this.reasoningText += text;
      this.recentKind = 'reasoning';
      this.recentTail = (this.recentTail + text).slice(-TAIL_CHECK);
    }
  }

  /**
   * Settle the channel of a held text block and emit its start plus first content.
   * @param {any} block - held text block.
   * @param {string} [next] - delta that forced the decision, when any.
   * @returns {any[]} chunks to emit.
   */
  #decide(block, next, force = false) {
    if (typeof next === 'string') block.buffer += next;
    if (block.flipCheck) {
      const flip = this.#flipVerdict(block, force);
      if (flip !== undefined) return this.#emit(block, flip);
    }
    const verdict = classifyLeading(block.buffer);
    if (block.flipCheck && verdict.state === 'text' && !force) {
      // A flip candidate needs its first bytes before the channel is settled.
      if (block.buffer.replace(/^\s*/, '').length < FLIP_MIN) return [];
    }
    if (!force && verdict.state === 'pending' && block.buffer.length < LEAD_CAP) return [];
    if (force && verdict.state === 'pending') {
      // A block still holding must not outlive its own slot in the stream: once a
      // foreign chunk arrives the emission order would otherwise change.
      return this.#emit(block, { state: 'text', rest: block.buffer });
    }
    return this.#emit(block, verdict);
  }

  /**
   * Emit the decided block start and whatever content is already buffered.
   * @param {any} block - held text block.
   * @param {{state: string, rest: string}} verdict - final classification.
   * @returns {any[]} chunks to emit.
   */
  /**
   * Judge whether a block continues the previous reasoning block mid-token.
   * @param {any} block - held text block.
   * @param {boolean} force - whether a foreign chunk forces the decision.
   * @returns {{state: string, rest: string, reason: string} | undefined} reroute
   *   verdict, or undefined to fall through to the markup classifier.
   */
  #flipVerdict(block, force) {
    const body = block.buffer;
    const head = body.replace(/^\s*/, '');
    // Markup at the head belongs to the tag rule; it decides on its own.
    if (head === '' || head.startsWith('<') || head.startsWith('|')) return undefined;
    if (!force && head.length < FLIP_MIN) return undefined;
    if (continuesPrevious(head, this.recentTail)) {
      return { state: 'reasoning', rest: body, reason: 'continuation' };
    }
    // A sentence of its own: stop checking and let the markup path settle it.
    block.flipCheck = false;
    return undefined;
  }

  #emit(block, verdict) {
    const out = [];
    const reroute = verdict.state === 'reasoning'
      && (verdict.reason === 'continuation' ? this.rules.continuationRouting : this.rules.tagRouting);
    if (reroute) {
      block.kind = 'reasoning';
      this.seenReasoning = true;
      this.mutated = true;
      // Only a rerouted block has its markup tokens removed: healthy content is
      // forwarded byte-for-byte, so a literal tag in real prose stays untouched.
      block.filter = new MarkupFilter(this.rules.stripTags);
      block.rerouted = true;
      if (verdict.reason === 'continuation') {
        this.#note('reasoning-continuation', { index: block.index, bytes: block.buffer.length, head: block.buffer.trim().slice(0, 24) });
      } else {
        this.#note('reasoning-in-text-channel', { index: block.index, bytes: block.buffer.length });
      }
    } else {
      block.kind = 'text';
      this.seenText = true;
    }
    block.decided = true;
    if (this.pendingIndex === block.index) this.pendingIndex = null;
    out.push({ type: 'block-start', index: block.index, blockType: block.kind });
    const body = verdict.state === 'reasoning' ? verdict.rest : block.buffer;
    block.buffer = '';
    const cleaned = block.filter.feed(body);
    if (cleaned !== '') {
      this.#absorb(block, cleaned);
      out.push(this.#delta(block, cleaned));
    }
    return out;
  }

  /**
   * Whether a finished text block looks like deliberation the provider leaked.
   * @param {any} block - finished text block state.
   * @returns {boolean} true when the block-end must wait for the next block.
   */
  #shouldHoldDeliberation(block) {
    if (!this.rules.deliberationRouting) return false;
    if (block.kind !== 'text') return false;
    const text = block.text;
    if (text.trim().length < DELIBERATION_MIN_CHARS) return false;
    // A CJK-heavy body is a written answer even when it is mid-turn.
    if (latinShare(text) < DELIBERATION_LATIN_SHARE) return false;
    const markers = deliberationMarkers(text);
    if (CJK_ANY.test(text)) {
      // Mixed script: the block quotes Chinese material while thinking in English.
      // The phrasing alone carries this branch, so it needs no language setting and
      // never relies on "a reasoning block came before".
      return markers >= 2;
    }
    if (!this.userCjk) return false;
    if (this.seenReasoning) return true;
    // No reasoning block at all in this call: only act on unmistakable deliberation
    // phrasing, so a real English answer in a CJK conversation stays visible.
    return markers >= 2;
  }

  /**
   * Re-emit a held text block-end in the reasoning channel.
   * @param {{chunk: any}} held - held block-end.
   * @returns {any} corrected block-end chunk.
   */
  #rerouteHeld(held) {
    const text = held.chunk.block.text ?? '';
    this.mutated = true;
    this.seenReasoning = true;
    this.lastClosed = { kind: 'reasoning', tail: text.slice(-TAIL_CHECK) };
    this.#note('reasoning-deliberation', {
      index: held.chunk.index,
      bytes: text.length,
      head: text.trim().slice(0, 24),
    });
    return { type: 'block-end', index: held.chunk.index, block: { type: 'reasoning', text } };
  }

  /**
   * Feed one chunk.
   * @param {any} chunk - raw provider chunk.
   * @returns {any[]} chunks to emit, possibly empty.
   */
  push(chunk) {
    const out = [];
    if (this.pendingTextEnd !== null) {
      const held = this.pendingTextEnd;
      this.pendingTextEnd = null;
      const followedByTool = chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType === 'tool-call');
      // A tool call right after the block proves the block was mid-turn: the answer
      // is still being worked on, so an English-only body is leaked deliberation.
      out.push(followedByTool ? this.#rerouteHeld(held) : held.chunk);
    }
    if (this.pendingIndex !== null) {
      const own = (chunk.type === 'text-delta' && chunk.index === this.pendingIndex);
      if (!own) {
        const held = this.blocks.get(this.pendingIndex);
        if (held !== undefined && !held.decided) out.push(...this.#decide(held, undefined, true));
        this.pendingIndex = null;
      }
    }
    out.push(...this.#dispatch(chunk));
    return out;
  }

  /**
   * Route one chunk to its handler.
   * @param {any} chunk - raw provider chunk.
   * @returns {any[]} chunks to emit.
   */
  #dispatch(chunk) {
    switch (chunk.type) {
      case 'block-start':
        return this.#onBlockStart(chunk);
      case 'text-delta':
      case 'reasoning-delta':
        return this.#onDelta(chunk);
      case 'tool-call-delta':
        this.seenToolCall = true;
        return [chunk];
      case 'block-end':
        return this.#onBlockEnd(chunk);
      case 'finish':
        return this.#onFinish(chunk);
      default:
        return [chunk];
    }
  }

  /** @param {any} chunk - block-start chunk. @returns {any[]} to emit. */
  #onBlockStart(chunk) {
    this.blocks.delete(chunk.index);
    this.maxIndex = Math.max(this.maxIndex, chunk.index);
    if (chunk.blockType === 'text') {
      this.pendingIndex = chunk.index;
      const continuePrevious = this.rules.continuationRouting
        && this.recentKind === 'reasoning'
        && endsMidToken(this.recentTail);
      this.blocks.set(chunk.index, {
        index: chunk.index,
        kind: 'text',
        decided: false,
        buffer: '',
        flipCheck: continuePrevious,
        // Undecided text is never rewritten: a visible block passes through as
        // written, and only a rerouted block has its markup tokens removed.
        filter: new MarkupFilter(false),
        text: '',
      });
      return [];
    }
    if (chunk.blockType === 'reasoning') {
      this.seenReasoning = true;
      this.blocks.set(chunk.index, {
        index: chunk.index,
        kind: 'reasoning',
        decided: true,
        buffer: '',
        // Native reasoning is never rewritten: only rerouted or visible text is.
        filter: new MarkupFilter(false),
        text: '',
      });
      return [chunk];
    }
    if (chunk.blockType === 'tool-call') this.seenToolCall = true;
    this.recentKind = chunk.blockType;
    return [chunk];
  }

  /** @param {any} chunk - text or reasoning delta. @returns {any[]} to emit. */
  #onDelta(chunk) {
    const block = this.blocks.get(chunk.index);
    if (block === undefined) {
      if (chunk.type === 'text-delta') this.seenText = true;
      else {
        this.seenReasoning = true;
        this.reasoningText += chunk.text;
      }
      return [chunk];
    }
    if (block.kind === 'tool-call') return [chunk];
    if (!block.decided) return this.#decide(block, chunk.text);
    const cleaned = block.filter.feed(chunk.text);
    if (cleaned === '') return [];
    this.#absorb(block, cleaned);
    return [this.#delta(block, cleaned)];
  }

  /** @param {any} chunk - block-end chunk. @returns {any[]} to emit. */
  #onBlockEnd(chunk) {
    const block = this.blocks.get(chunk.index);
    this.blocks.delete(chunk.index);
    this.maxIndex = Math.max(this.maxIndex, chunk.index);
    if (block === undefined || block.kind === 'tool-call') {
      if (chunk.block.type === 'text') this.seenText = true;
      if (chunk.block.type === 'reasoning') this.seenReasoning = true;
      this.lastClosed = { kind: chunk.block.type, tail: (chunk.block.text ?? '').slice(-TAIL_CHECK) };
      return [chunk];
    }
    const out = [];
    if (!block.decided) out.push(...this.#decide(block, undefined, true));
    const tail = block.filter.flush();
    if (tail !== '') {
      this.#absorb(block, tail);
      out.push(this.#delta(block, tail));
    }
    if (block.filter.removed) {
      this.mutated = true;
      if (!block.rerouted) this.#note('markup-stripped', { index: block.index });
    }
    if (block.kind !== chunk.block.type) this.mutated = true;
    this.lastClosed = { kind: block.kind, tail: block.text.slice(-TAIL_CHECK) };
    const end = {
      type: 'block-end',
      index: block.index,
      block: { type: block.kind, text: block.text },
    };
    if (this.#shouldHoldDeliberation(block)) {
      // Another block may already have started (providers interleave), in which case
      // the tool call is visible now and the answer is settled immediately.
      if (this.seenToolCall) {
        out.push(this.#rerouteHeld({ chunk: end }));
        return out;
      }
      // Otherwise the held end is released before the chunk that decides it, so the
      // assembled block order never changes.
      this.pendingTextEnd = { chunk: end };
      return out;
    }
    out.push(end);
    return out;
  }

  /**
   * Decide whether the turn's only content was an answer written as reasoning.
   * @param {{kind?: string}} reason - terminal reason of the call.
   * @returns {any[]} rescue chunks, possibly empty.
   */
  #rescue(reason) {
    if (!this.rules.answerRescue || this.rescued) return [];
    if (this.seenToolCall || this.seenText || !this.seenReasoning) return [];
    if (reason?.kind !== 'stop') return [];
    if (this.reasoningText.trim().length < ANSWER_MIN_CHARS) return [];
    this.rescued = true;
    this.mutated = true;
    // Append right after the blocks this call already emitted: the client keeps
    // blocks in an index-addressed array, so a distant index would be sparse.
    const index = this.maxIndex + 1 + this.inserted;
    this.inserted += 1;
    this.#note('answer-in-reasoning-channel', { bytes: this.reasoningText.length });
    return [
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text: this.reasoningText },
      { type: 'block-end', index, block: { type: 'text', text: this.reasoningText } },
    ];
  }

  /** @param {any} chunk - finish chunk. @returns {any[]} to emit. */
  #onFinish(chunk) {
    const out = this.#rescue(chunk.reason);
    if (this.mutated && chunk.replayState !== undefined) {
      // The adapter's replay metadata is index-aligned with the blocks it emitted.
      // A repaired stream no longer matches it, so drop the metadata instead of
      // letting it degrade with a mismatch on every later replay.
      const { replayState: _dropped, ...rest } = chunk;
      return [...out, rest];
    }
    return [...out, chunk];
  }

  /**
   * Flush a stream that ended without a terminal chunk.
   * @returns {any[]} chunks to emit.
   */
  end() {
    const out = [];
    if (this.pendingTextEnd !== null) {
      out.push(this.pendingTextEnd.chunk);
      this.pendingTextEnd = null;
    }
    for (const block of this.blocks.values()) {
      if (block.kind === 'tool-call') continue;
      if (!block.decided) out.push(...this.#decide(block));
      const tail = block.filter.flush();
      if (tail !== '') {
        this.#absorb(block, tail);
        out.push(this.#delta(block, tail));
      }
    }
    this.blocks.clear();
    this.pendingIndex = null;
    return out;
  }
}

/**
 * Wrap a chunk stream with the repair pass.
 * @param {AsyncIterable<any>} source - upstream chunks.
 * @param {object} [options] - pass options, see {@link GuardPass}.
 * @returns {AsyncGenerator<any, void, undefined>} repaired chunks.
 */
export async function* guardStream(source, options = {}) {
  let pass;
  try {
    pass = new GuardPass(options);
  } catch {
    yield* source;
    return;
  }
  for await (const chunk of source) {
    let out;
    try {
      out = pass.push(chunk);
    } catch {
      out = [chunk];
    }
    if (pass.dryRun) {
      yield chunk;
      continue;
    }
    for (const item of out) yield item;
  }
  if (pass.dryRun) return;
  let tail;
  try {
    tail = pass.end();
  } catch {
    tail = [];
  }
  for (const item of tail) yield item;
}
