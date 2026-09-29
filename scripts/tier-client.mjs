/**
 * The pieces the offline model harnesses share: one chat completion against an
 * OpenAI-compatible endpoint, a fresh output directory, and the per-call log.
 * `run-tier.mjs` (0d) and `replay-canon.mjs` call the model the same way through this,
 * so their numbers are comparable.
 *
 * NANOGPT_API_KEY is read from the environment or the repo's gitignored `.env`, and never
 * written; NANOGPT_BASE_URL overrides the endpoint. Local only.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASE_URL = (process.env.NANOGPT_BASE_URL ?? 'https://nano-gpt.com/api/v1').replace(/\/$/, '');
const TIMEOUT_MS = 300_000;
const ATTEMPTS = 3;

/** The API key, from the environment or the repo's `.env`. */
export function loadKey() {
    const env = path.join(REPO, '.env');
    if (existsSync(env)) process.loadEnvFile(env);
    const key = process.env.NANOGPT_API_KEY;
    if (!key) throw new Error('NANOGPT_API_KEY is not set');
    return key;
}

/** Corpus content never lands in this public repo (CLAUDE.md §3.13). */
export function outsideRepo(dir) {
    if (dir === REPO || dir.startsWith(REPO + path.sep)) {
        throw new Error(`refusing to write corpus content inside the repo: ${dir} (CLAUDE.md §3.13)`);
    }
    return dir;
}

/** A directory per run that did not exist before — nothing in the corpus is overwritten. */
export function freshDir(dir) {
    if (existsSync(dir)) throw new Error(`${dir} already exists — nothing in the corpus is overwritten (CLAUDE.md §3.14)`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

export const pad = (n) => String(n).padStart(2, '0');
export const slugOf = (model) => model.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * One chat completion. Temperature is left to the endpoint's default, as a memory profile
 * that never set one would; the reply's usage and anything cost-shaped are kept raw.
 */
export async function complete(model, request, key) {
    const body = JSON.stringify({ model, messages: request.messages, max_tokens: request.maxTokens, stream: false });
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const started = Date.now();
        try {
            const res = await fetch(`${BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
            if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`), { fatal: true });
            const json = JSON.parse(text);
            const choice = json.choices?.[0];
            const costHeaders = Object.fromEntries([...res.headers].filter(([k]) => /cost|balance|price/i.test(k)));
            return {
                content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
                finish: choice?.finish_reason ?? null,
                usage: json.usage ?? null,
                cost: json.cost ?? json.usage?.cost ?? null,
                costHeaders,
                ms: Date.now() - started,
                raw: json,
            };
        } catch (err) {
            if (err.fatal) throw err;
            lastError = err;
            if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
    }
    throw new Error(`${ATTEMPTS} attempts failed, last: ${lastError.message}`);
}

export function log(dir, entry) {
    appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(entry) + '\n');
}

export function say(kind, label, reply) {
    const u = reply.usage ?? {};
    const warn = reply.finish === 'length' ? '  ← TRUNCATED at max_tokens' : (reply.content ? '' : '  ← EMPTY content');
    console.log(`  ${kind} ${label}  ${u.prompt_tokens ?? '?'} in / ${u.completion_tokens ?? '?'} out, `
        + `${(reply.ms / 1000).toFixed(1)}s, finish ${reply.finish}${reply.cost != null ? `, cost ${reply.cost}` : ''}${warn}`);
}
