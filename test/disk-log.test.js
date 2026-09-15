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
        inventory: [
            { key: 'qvink_memory_short', owner: 'qvink', label: 'Qvink Memory (short)', positionName: 'in-prompt', depth: 16, tokens: 120 },
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
