/**
 * Plugin entry: puts a repairing pass around every streaming model call.
 *
 * The pass is transparent: it forwards each chunk unchanged unless it recognizes
 * a channel defect (see lib/guard.js). Rules, dry-run, and tracing come from
 * `$DSH_HOME/thinking-channel-guard.json`, re-read when the file changes:
 *
 * ```json
 * {
 *   "version": 1,
 *   "rules": { "tagRouting": true, "continuationRouting": true, "stripTags": true, "answerRescue": true },
 *   "dryRun": false,
 *   "trace": false,
 *   "sessions": { "session-xxxx": { "answerRescue": false } }
 * }
 * ```
 *
 * Repairs are appended to `$DSH_HOME/thinking-channel-guard.log` as JSON lines.
 *
 * @module dsh-thinking-channel-guard
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RULES, GUARD_VERSION, guardStream } from './lib/guard.js';

/** Configuration file name inside the Harness home directory. */
const CONFIG_NAME = 'thinking-channel-guard.json';

/** Repair log file name inside the Harness home directory. */
const LOG_NAME = 'thinking-channel-guard.log';

/** Longest repair log kept before a pass stops appending to an oversized file. */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the Harness home directory the running host uses.
 * @returns {string} absolute directory path.
 */
function harnessHome() {
  const configured = process.env.DSH_HOME;
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh');
}

/** Cached configuration and the file signature that produced it. */
let cachedConfig = { signature: '', value: {} };

/**
 * Read the plugin configuration, rebuilding only when the file changed.
 * @returns {Record<string, any>} parsed configuration, or an empty object.
 */
function configuration() {
  const path = join(harnessHome(), CONFIG_NAME);
  try {
    const stat = statSync(path);
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature === cachedConfig.signature) return cachedConfig.value;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const value = parsed !== null && typeof parsed === 'object' ? parsed : {};
    cachedConfig = { signature, value };
    return value;
  } catch {
    if (cachedConfig.signature !== '') cachedConfig = { signature: '', value: {} };
    return cachedConfig.value;
  }
}

/**
 * Merge global and per-session rules for one call.
 * @param {Record<string, any>} config - parsed configuration.
 * @param {string | undefined} sessionId - calling session.
 * @returns {{rules: Record<string, boolean>, dryRun: boolean, trace: boolean}} settings.
 */
function settingsFor(config, sessionId) {
  const global = config.rules !== null && typeof config.rules === 'object' ? config.rules : {};
  const sessions = config.sessions !== null && typeof config.sessions === 'object' ? config.sessions : {};
  const override = sessionId === undefined ? undefined : sessions[sessionId];
  const local = override !== null && typeof override === 'object' ? override : {};
  const pick = (key) => {
    if (typeof local[key] === 'boolean') return local[key];
    if (typeof global[key] === 'boolean') return global[key];
    return DEFAULT_RULES[key];
  };
  // Every rule the pass knows is resolved, so a new rule cannot be silently
  // ignored by a config file that names it.
  const rules = {};
  for (const key of Object.keys(DEFAULT_RULES)) rules[key] = pick(key);
  return {
    rules,
    dryRun: typeof local.dryRun === 'boolean' ? local.dryRun : config.dryRun === true,
    trace: typeof local.trace === 'boolean' ? local.trace : config.trace === true,
  };
}

/**
 * Append one JSON line to the repair log, ignoring an oversized or unwritable file.
 * @param {Record<string, any>} entry - log record.
 * @returns {void}
 */
function log(entry) {
  const path = join(harnessHome(), LOG_NAME);
  try {
    try {
      if (statSync(path).size > LOG_LIMIT_BYTES) return;
    } catch {
      // Missing log file is the normal first-write case.
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Diagnostics never fail a model call.
  }
}

/**
 * Register the repairing pass.
 * @param {any} ctx - plugin context.
 * @param {Record<string, any>} [_config] - optional row configuration.
 * @returns {void}
 */
export function apply(ctx, _config) {
  ctx.on(
    'llm/stream',
    (options, next) => {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
      let settings;
      try {
        settings = settingsFor(configuration(), sessionId);
      } catch {
        settings = { rules: { ...DEFAULT_RULES }, dryRun: false, trace: false };
      }
      const repairs = [];
      const stream = guardStream(next(), {
        rules: settings.rules,
        dryRun: settings.dryRun,
        onRepair: (repair) => {
          repairs.push(repair);
        },
      });
      return (async function* guarded() {
        let blocks = 0;
        try {
          for await (const chunk of stream) {
            if (chunk.type === 'block-start') blocks += 1;
            yield chunk;
          }
        } finally {
          if (repairs.length > 0 || settings.trace) {
            log({
              guardVersion: GUARD_VERSION,
              time: new Date().toISOString(),
              sessionId,
              provider: options.provider,
              model: options.model,
              dryRun: settings.dryRun,
              blocks,
              repairs,
            });
          }
        }
      })();
    },
    { global: true, prepend: true },
  );
}
