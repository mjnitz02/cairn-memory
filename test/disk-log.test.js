import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_FILENAME, createDiskLog, logFilename } from '../src/util/disk-log.js';
import { createContext } from './mocks/sillytavern.js';

/** A snapshot of the shape createObserver emits. */
function snapshot(overrides = {}) {
    return {
        at: '2026-09-15T12:00:00.000Z',
        api: 'text-completion',
        promptChars: 1000,
        promptTokens: 250,
        maxContext: 24064,
        contextPercent: 1,
        stability: {
            previousLength: 900,
            currentLength: 1000,
            commonPrefix: 900,
            stabilityPercent: 90,
            divergence: { index: 900, previous: 'old tail', current: 'new tail' },
        },
        divergenceIn: { key: 'qvink_memory_short', owner: 'qvink', label: 'Qvink Memory (short)', offsetInEntry: 0, precision: 'inside' },
        inventory: [
            {
                key: 'qvink_memory_short', owner: 'qvink', label: 'Qvink Memory (short)',
                positionName: 'in-prompt', depth: 16, tokens: 120, chars: 480,
                offset: 300, offsetPercent: 30, match: 'exact',
            },
        ],
        summary: { count: 1, tokens: 120, writers: 1, byOwner: [{ owner: 'qvink', count: 1, tokens: 120 }] },
        worldInfo: [],
        ...overrides,
    };
}

let fetchMock;
let getContext;
let context;
/** What each file holds on "disk", as ST's `/user/files/` route would serve it. */
let disk;
let uploadResponse;

/**
 * ST's two routes: `/user/files/<name>` serves a file or 404s (src/users.js:1218), and
 * `/api/files/upload` replaces one (src/endpoints/files.js:28).
 */
function routedFetch(url, init = {}) {
    if (url === '/api/files/upload') {
        const response = uploadResponse();
        if (response.ok) {
            const { name, data } = JSON.parse(init.body);
            disk.set(name, Buffer.from(data, 'base64').toString('utf8'));
        }
        return Promise.resolve(response);
    }
    const name = decodeURIComponent(url.replace('/user/files/', ''));
    return Promise.resolve(disk.has(name)
        ? { ok: true, status: 200, text: async () => disk.get(name) }
        : { ok: false, status: 404, text: async () => 'Not Found' });
}

beforeEach(() => {
    disk = new Map();
    uploadResponse = () => ({ ok: true, status: 200, json: async () => ({ path: `user/files/${LOG_FILENAME}` }) });
    fetchMock = vi.fn(routedFetch);
    vi.stubGlobal('fetch', fetchMock);

    context = createContext();
    context.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    getContext = () => context;
});

/** The uploads, in order — the reads that precede them are not writes. */
function uploads() {
    return fetchMock.mock.calls.filter(([url]) => url === '/api/files/upload');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Decode what was last POSTed back into the lines it represents. */
function writtenLines() {
    const body = JSON.parse(uploads().at(-1)[1].body);
    return Buffer.from(body.data, 'base64').toString('utf8').trim().split('\n');
}

describe('disk log', () => {
    it('writes nothing until enabled', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(log.count).toBe(0));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the run to ST\'s file endpoint, under the open chat\'s own name', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(uploads()).toHaveLength(1));

        const [url, init] = uploads()[0];
        expect(url).toBe('/api/files/upload');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body).name).toBe(logFilename(context.chatId));
    });

    it('writes one flat JSON line per generation', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        log.append(snapshot({ promptTokens: 300 }), getContext);

        await vi.waitFor(() => expect(uploads()).toHaveLength(1));

        const lines = writtenLines();
        expect(lines).toHaveLength(2);

        const first = JSON.parse(lines[0]);
        expect(first).toMatchObject({
            api: 'text-completion',
            prompt_tokens: 250,
            stability_percent: 90,
            injected_tokens: 120,
            writers: 1,
        });
        expect(first.injections[0]).toMatchObject({ owner: 'qvink', position: 'in-prompt' });
    });

    it('rewrites the whole run, since the endpoint replaces files', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(1));

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(2));

        expect(writtenLines()).toHaveLength(2);
    });

    it('survives non-Latin-1 text, which plain btoa would throw on', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({
            stability: { ...snapshot().stability, divergence: { index: 1, previous: 'café — ✓', current: '日本語' } },
        }), getContext);

        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        expect(JSON.parse(writtenLines()[0]).divergence_current).toBe('日本語');
    });

    it('swallows a failed upload rather than breaking the turn', async () => {
        uploadResponse = () => ({ ok: false, status: 500, text: async () => 'nope' });
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(1));
        expect(log.count).toBe(1); // kept, so the next write retries it
    });
});

/** docs/decisions.md D-0085: one trail per chat, across every session it is played in. */
describe('one log per chat, appended to', () => {
    it('adds to what an earlier session wrote rather than replacing it', async () => {
        const name = logFilename(context.chatId);
        disk.set(name, '{"earlier":1}\n{"earlier":2}\n');
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(1));
        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(2));

        const lines = disk.get(name).trim().split('\n');
        expect(lines).toHaveLength(4);
        expect(JSON.parse(lines[0])).toEqual({ earlier: 1 });
        // Read back once a session, not before every write.
        expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/user/files/'))).toHaveLength(1);
    });

    it('writes nothing when it cannot read the file back, so it never replaces a trail', async () => {
        const name = logFilename(context.chatId);
        disk.set(name, '{"earlier":1}\n');
        fetchMock.mockImplementation((url, init) => (url.startsWith('/user/files/')
            ? Promise.resolve({ ok: false, status: 500, text: async () => 'busy' })
            : routedFetch(url, init)));
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(uploads()).toHaveLength(0);
        expect(disk.get(name)).toBe('{"earlier":1}\n');
        expect(log.count).toBe(1);
    });

    it('keeps each chat in its own file across a chat change, dropping nothing', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        const first = context.chatId;

        log.append(snapshot(), getContext);
        log.reset();
        context.chatId = 'another-chat';
        log.append(snapshot({ promptTokens: 999 }), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(2));

        expect(disk.get(logFilename(first)).trim().split('\n')).toHaveLength(1);
        const other = disk.get(logFilename('another-chat')).trim().split('\n');
        expect(JSON.parse(other[0])).toMatchObject({ prompt_tokens: 999, chat_id: 'another-chat' });
    });

    it('marks every line with its chat and the session that wrote it', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads()).toHaveLength(1));

        const [a, b] = writtenLines().map((line) => JSON.parse(line));
        expect(a.chat_id).toBe(context.chatId);
        expect(Number.isNaN(Date.parse(a.session))).toBe(false);
        expect(b.session).toBe(a.session);
    });

    it('names a chat\'s file with only the characters ST accepts, and keeps two chats apart', () => {
        const name = logFilename('Esk - 2026-09-01@12h30m45s');
        expect(name).toMatch(/^cairn-Esk_-_2026-09-01_12h30m45s-[0-9a-f]{8}\.jsonl$/);
        // src/endpoints/assets.js:22's rule.
        expect(name).toMatch(/^[a-zA-Z0-9_\-.]+$/);
        expect(logFilename('Esk @ 1')).not.toBe(logFilename('Esk # 1'));
        expect(logFilename(null)).toBe(LOG_FILENAME);
        expect(logFilename('日本語')).toMatch(/^cairn-chat-[0-9a-f]{8}\.jsonl$/);
    });

    it('debounces bursts into a single write', async () => {
        vi.useFakeTimers();
        const log = createDiskLog({ delayMs: 1500 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        log.append(snapshot(), getContext);
        log.append(snapshot(), getContext);
        expect(fetchMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1500);
        expect(uploads()).toHaveLength(1);
        expect(writtenLines()).toHaveLength(3);
    });
});

describe('what a line has to answer', () => {
    /**
     * The log exists so a run can be read with jq instead of by hand
     * (docs/decisions.md D-0017). "Stability fell to 13%" is only actionable
     * with the block it fell inside, which means offsets have to survive the
     * trip to disk.
     */
    it('records which block the prefix broke inside', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));

        expect(JSON.parse(writtenLines()[0])).toMatchObject({
            divergence_index: 900,
            divergence_in: 'qvink_memory_short',
            divergence_in_owner: 'qvink',
            divergence_in_offset: 0,
            divergence_in_precision: 'inside',
        });
    });

    it('records where each injection actually landed, not just its size', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));

        expect(JSON.parse(writtenLines()[0]).injections[0]).toMatchObject({
            key: 'qvink_memory_short',
            chars: 480,
            offset: 300,
            offset_percent: 30,
            match: 'exact',
        });
    });

    it('writes nulls rather than dropping the fields on a first turn', async () => {
        // A missing key and a key that is null read very differently in jq.
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({
            divergenceIn: null,
            stability: { previousLength: 0, currentLength: 1000, commonPrefix: 0, stabilityPercent: null, divergence: null },
        }), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));

        const entry = JSON.parse(writtenLines()[0]);
        expect(entry).toHaveProperty('divergence_in', null);
        expect(entry).toHaveProperty('divergence_in_precision', null);
    });
});

describe('disk log — the holder regime', () => {
    /**
     * Without this the log cannot tell a control run from a treatment run, and
     * the whole measurement is unreadable (docs/decisions.md D-0024).
     */
    it('carries how many entries were held', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({ worldInfoHeld: 29 }), getContext);

        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        expect(JSON.parse(writtenLines().at(-1)).world_info_held).toBe(29);
    });

    it('carries null when the holder was off, not zero', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        expect(JSON.parse(writtenLines().at(-1)).world_info_held).toBeNull();
    });
});

describe('disk log — the memory plan', () => {
    /**
     * The number P1 is aimed at (docs/decisions.md D-0019). A run is read off
     * this file, so if the block's own change is not in it there is nothing to
     * read — the prompt-level stability number cannot separate a block that grew
     * at its tail from one that was rebuilt at its head.
     */
    it('carries where the block changed and whether the cadences held', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({
            memory: {
                source: 'qvink',
                scenes: 122,
                included: 96,
                oldest: 11,
                newest: 107,
                summarisedThrough: 107,
                stepped: true,
                stepReason: 'step',
                evicted: 0,
                cap: 15_800,
                floor: 7_900,
                slack: 7_900,
                stepTokens: 890,
                recoupled: false,
                chars: 38_900,
                tokens: 9_040,
                change: { stabilityPercent: 97.7, divergenceAt: 37_100, divergencePercent: 99.9 },
            },
        }), getContext);

        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        expect(JSON.parse(writtenLines().at(-1))).toMatchObject({
            memory_planned: true,
            memory_included: 96,
            memory_stepped: true,
            memory_evicted: 0,
            memory_change_percent: 99.9,
        });
    });

    it('says so plainly when no block was planned', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        expect(JSON.parse(writtenLines().at(-1)).memory_planned).toBe(false);
    });
});

describe('disk log — P2 summaries', () => {
    const memory = {
        source: 'mixed', cairnScenes: 21, stepWaiting: false, scenes: 51, included: 51,
        summarisedThrough: 50, stepped: false, stepReason: 'held', evicted: 0, cap: 7_705,
        floor: 3_852, maxPromptTokens: 22_016, chars: 18_000, tokens: 4_200,
        change: { stabilityPercent: 100, divergenceAt: null, divergencePercent: null },
    };
    const status = {
        gate: 'ready', inFlight: 12, pending: 2, givenUp: [9], calls: 7, written: 5, failures: 2,
        lastReason: 'truncated', ms: 48_300, lastMs: 6_900, tokensIn: 7_084, tokensOut: 777, promptDefault: true,
    };

    async function line(overrides) {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(overrides), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        return JSON.parse(writtenLines().at(-1));
    }

    it('carries the fields the cutover run is read from (docs/decisions.md D-0041)', async () => {
        expect(await line({ memory, summaries: status, promptTokens: 17_762 })).toMatchObject({
            memory_source: 'mixed',
            memory_cairn_scenes: 21,
            memory_step_waiting: false,
            memory_cap: 7_705,
            summary_reported: true,
            summary_gate: 'ready',
            summary_in_flight: true,
            summary_pending: 2,
            summary_given_up: [9],
            summary_calls: 7,
            summary_written: 5,
            summary_failures: 2,
            summary_last_reason: 'truncated',
            summary_ms: 48_300,
            summary_last_ms: 6_900,
            summary_tokens_in: 7_084,
            summary_tokens_out: 777,
            summary_prompt_default: true,
            prompt_near_limit: false,
        });
    });

    it('no longer carries a cap type: there is only one kind of cap', async () => {
        expect(await line({ memory })).not.toHaveProperty('memory_cap_type');
    });

    it('flags a prompt full enough that ST may have dropped raw history', async () => {
        expect((await line({ memory, promptTokens: 21_500 })).prompt_near_limit).toBe(true);
    });

    it('does not report an overlap when no request was out', async () => {
        expect((await line({ memory, summaries: { ...status, inFlight: null } })).summary_in_flight).toBe(false);
    });

    it('says so plainly when there was no summarizer to ask', async () => {
        const entry = await line({});

        expect(entry.summary_reported).toBe(false);
        expect(entry.prompt_near_limit).toBeNull();
    });
});

describe('disk log — P3 world state', () => {
    const placement = {
        injected: true, reason: 'injected', tracker: null, index: 41, depth: 1, chars: 290, tokens: 55,
        changed: true, changeKinds: ['location', 'characters.outfit'],
        text: '[Current scene]\nLocation: The ferry, upper deck',
    };
    const status = {
        gate: 'ready', tracker: null, inFlight: null, pending: false, givenUp: false, calls: 12, written: 11,
        failures: 1, lastReason: 'truncated', dropped: 2, ms: 82_800, lastMs: 6_100, tokensIn: 14_400, tokensOut: 960,
    };

    async function line(overrides) {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(overrides), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        return JSON.parse(writtenLines().at(-1));
    }

    it('carries the fields the P3 run is read from (docs/decisions.md D-0049)', async () => {
        expect(await line({ state: placement, summaries: { state: { ...status, inFlight: 43 } } })).toMatchObject({
            state_reported: true,
            state_injected: true,
            state_reason: 'injected',
            state_tracker: null,
            state_depth: 1,
            state_chars: 290,
            state_tokens: 55,
            state_changed: true,
            state_change_kinds: ['location', 'characters.outfit'],
            state_gate: 'ready',
            state_in_flight: true,
            state_pending: false,
            state_given_up: false,
            state_calls: 12,
            state_written: 11,
            state_failures: 1,
            state_last_reason: 'truncated',
            state_dropped_fields: 2,
            state_ms: 82_800,
            state_last_ms: 6_100,
            state_tokens_in: 14_400,
            state_tokens_out: 960,
        });
    });

    it('never writes the state\'s text', async () => {
        const written = JSON.stringify(await line({ state: placement, summaries: { state: status } }));

        expect(written).not.toContain('ferry');
        expect(written).not.toContain('Current scene');
    });

    it('records why no state went in, with no depth', async () => {
        const entry = await line({
            state: { ...placement, injected: false, reason: 'behind-step', depth: 3, chars: 0, tokens: 0, changeKinds: [], text: '' },
        });

        expect(entry).toMatchObject({ state_injected: false, state_reason: 'behind-step', state_depth: null, state_in_flight: null });
    });

    it('says so plainly when nothing reported a state', async () => {
        expect(await line({})).toMatchObject({ state_reported: false, state_injected: false, state_reason: null, state_calls: null });
    });
});

/**
 * The cap's own accounting (docs/decisions.md D-0052). The P6 run is read off
 * this file: whether the cap held still, and what the margin actually had to
 * cover. Neither can be told from `memory_cap` alone.
 */
describe('disk log — P6 the cap and its reserves', () => {
    const memory = {
        source: 'cairn', cairnScenes: 40, stepWaiting: false, scenes: 84, included: 38,
        summarisedThrough: 73, stepped: false, stepReason: 'held', evicted: 0,
        cap: 4_090, floor: 2_045, maxPromptTokens: 23_040, chars: 17_000, tokens: 4_000,
        budget: {
            share: 8_063, room: 4_090, minimum: 2_304, margin: 1_152, limitedBy: 'room',
            card: 4_500, lore: 5_000, loreBound: 'books', window: 7_968, windowNow: 5_120, state: 439,
        },
        change: { stabilityPercent: 100, divergenceAt: null, divergencePercent: null },
    };

    async function line(overrides) {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(overrides), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        return JSON.parse(writtenLines().at(-1));
    }

    it('carries every reserve and which of the two limits bound the cap', async () => {
        expect(await line({ memory })).toMatchObject({
            memory_cap: 4_090,
            budget_reported: true,
            budget_limited_by: 'room',
            budget_share: 8_063,
            budget_room: 4_090,
            budget_minimum: 2_304,
            budget_margin: 1_152,
            budget_card: 4_500,
            budget_lore: 5_000,
            budget_lore_bound: 'books',
            budget_window: 7_968,
            budget_window_now: 5_120,
            budget_state: 439,
        });
    });

    /**
     * The margin check: everything the prompt carried that is not the block or
     * the state should be the card, the lore and this turn's raw window. What is
     * left over is what the margin had to cover.
     */
    it('leaves the margin check computable from one line', async () => {
        const entry = await line({ memory, promptTokens: 19_500 });
        const unexplained = entry.prompt_tokens - entry.memory_tokens - (entry.state_tokens ?? 0)
            - entry.budget_card - entry.budget_lore - entry.budget_window_now;

        expect(unexplained).toBe(19_500 - 4_000 - 4_500 - 5_000 - 5_120);
        expect(unexplained).toBeLessThan(entry.budget_margin);
    });

    it('says so plainly when the reserves could not be read', async () => {
        const unknown = { ...memory, cap: 8_063, budget: { ...memory.budget, limitedBy: 'unknown', card: null } };

        expect(await line({ memory: unknown })).toMatchObject({
            budget_reported: true, budget_limited_by: 'unknown', budget_card: null,
        });
    });

    it('says so plainly when no block was planned', async () => {
        expect(await line({})).toMatchObject({ memory_planned: false, budget_reported: false });
    });
});

/**
 * Each phase's check names the log fields it is read from (docs/p5-plan.md §3). A check
 * whose field is missing is a check nobody can run, and the gap is invisible until the
 * run — so the field list is a test (CLAUDE.md §9.35).
 */
describe('the fields a run is read from', () => {
    const memory = {
        writing: true, included: 43, cap: 6_000, sceneCap: 6_362, tokens: 2_400,
        evicted: 6, rebuilt: true, stepReason: 'step',
        // Stage 1 — the reclaim (docs/decisions.md D-0068).
        examplesStripped: true, examplesLatched: true,
        // Stage 2.5 — the compact tier (D-0075).
        blockFull: 43, blockCompact: 39, demoted: 6, compactMissing: 0, compactCap: 998,
        // Stage 3 — the pick (D-0071).
        canonFacts: 10, canonAdmitted: 10, canonSlots: 10, canonPicked: 10,
        canonRederived: true, canonLostSources: 0, canonReason: 'covered',
        indexRecords: 85, indexKinds: { description: 38, major: 24, filler: 21, cast: 2 },
        budget: { card: 1_200, lore: 800, window: 2_000, state: 100, margin: 64, limitedBy: 'room' },
    };
    // Every key the two queues actually report, so a renamed one shows up as a null
    // below rather than as a quiet gap in the log — which is what `status.promoted`
    // becoming `status.picked` did (docs/decisions.md D-0079).
    const summaries = {
        canon: {
            gate: 'ready', reason: 'covered', inFlight: null, pending: null, givenUp: false,
            calls: 2, picked: 10, duplicates: 1, refused: 0, clipped: 1, failures: 0, lastReason: 'none',
            ms: 9_000, lastMs: 4_400, tokensIn: 10_600, tokensOut: 800,
        },
        index: {
            gate: 'ready', inFlight: null, pending: null, waiting: 0, givenUp: false,
            calls: 6, records: 85, dropped: 0, clipped: 3, missed: 0, failures: 0, lastReason: 'none',
            ms: 26_000, lastMs: 4_100, tokensIn: 18_000, tokensOut: 6_400,
        },
    };

    const line = async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({ memory, summaries }), getContext);
        await vi.waitFor(() => expect(uploads().length).toBeGreaterThan(0));
        return JSON.parse(writtenLines().at(-1));
    };

    it('carries the reclaim\'s two fields, which have to agree or it did not happen', async () => {
        const entry = await line();

        expect(entry.memory_examples_stripped).toBe(true);
        expect(entry.memory_examples_latched).toBe(true);
        expect(entry.budget_card).toBe(1_200);
    });

    it('carries the compact tier\'s fields, including the demotion invariant', async () => {
        const entry = await line();

        expect(entry.memory_block_full).toBe(43);
        expect(entry.memory_block_compact).toBe(39);
        expect(entry.memory_demoted).toBe(6);
        // A demotion may only land on a rebuild turn, so both have to be readable.
        expect(entry.memory_rebuilt).toBe(true);
        expect(entry.memory_compact_missing).toBe(0);
    });

    it('carries the pick\'s fields, in the pick\'s own vocabulary', async () => {
        const entry = await line();

        expect(entry.memory_canon_slots).toBe(10);
        expect(entry.memory_canon_picked).toBe(10);
        expect(entry.memory_canon_rederived).toBe(true);
        expect(entry.memory_canon_lost_sources).toBe(0);
        expect(entry.memory_canon_reason).toBe('covered');
        expect(entry.memory_index_records).toBe(85);
        expect(entry.memory_index_kinds).toEqual({ description: 38, major: 24, filler: 21, cast: 2 });
        expect(entry.compaction_picked).toBe(10);
        expect(entry.compaction_reason).toBe('covered');
        expect(entry.index_records).toBe(85);
    });

    it('leaves no field the queues report as null when they have reported it', async () => {
        // A null where a queue gave a number means the log is reading a key that moved.
        const entry = await line();
        const named = Object.entries(entry)
            .filter(([key]) => key.startsWith('compaction_') || key.startsWith('index_'))
            .filter(([key, value]) => value === null && !key.includes('pending') && !key.includes('last'));

        expect(named.map(([key]) => key)).toEqual([]);
    });
});
