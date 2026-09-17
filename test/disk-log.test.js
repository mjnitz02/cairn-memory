import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_FILENAME, createDiskLog } from '../src/util/disk-log.js';
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

beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ path: `user/files/${LOG_FILENAME}` }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = createContext();
    context.getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
    getContext = () => context;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

/** Decode what was POSTed back into the lines it represents. */
function writtenLines() {
    const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
    return Buffer.from(body.data, 'base64').toString('utf8').trim().split('\n');
}

describe('disk log', () => {
    it('writes nothing until enabled', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(log.count).toBe(0));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts the run to ST\'s file endpoint', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/files/upload');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body).name).toBe(LOG_FILENAME);
    });

    it('writes one flat JSON line per generation', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        log.append(snapshot({ promptTokens: 300 }), getContext);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        expect(writtenLines()).toHaveLength(2);
    });

    it('survives non-Latin-1 text, which plain btoa would throw on', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot({
            stability: { ...snapshot().stability, divergence: { index: 1, previous: 'café — ✓', current: '日本語' } },
        }), getContext);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(JSON.parse(writtenLines()[0]).divergence_current).toBe('日本語');
    });

    it('swallows a failed upload rather than breaking the turn', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'nope' });
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);

        log.append(snapshot(), getContext);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(log.count).toBe(1); // kept, so the next write retries it
    });

    it('drops the run on reset, because a new chat is a new run', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);
        log.reset();

        expect(log.count).toBe(0);
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
        expect(fetchMock).toHaveBeenCalledTimes(1);
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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

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

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(JSON.parse(writtenLines().at(-1)).world_info_held).toBe(29);
    });

    it('carries null when the holder was off, not zero', async () => {
        const log = createDiskLog({ delayMs: 0 });
        log.setEnabled(true);
        log.append(snapshot(), getContext);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
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
