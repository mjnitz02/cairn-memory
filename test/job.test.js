import { describe, expect, it, vi } from 'vitest';
import { createJob } from '../src/pipeline/job.js';
import { MAX_ATTEMPTS } from '../src/pipeline/tally.js';
import { stubToastr } from './helpers/toastr.js';

/**
 * The skeleton every kind of memory work runs on (pipeline/job.js). The kinds themselves
 * are driven through the summarizer in the queue tests; this pins the shared policy.
 */
const KIND = Object.freeze({
    log: 'probe',
    name: 'probe',
    article: 'a probe',
    key: (chatId, work) => `${chatId}\n${work.id}`,
    failed: (work) => `The probe ${work.id}`,
    gaveUp: (work, _at, count) => `Gave up on probe ${work.id} after ${count} failures.`,
});

const CONTEXT = Object.freeze({ chatId: 'chat-a' });
const WORK = Object.freeze({ id: 7 });
const REQUEST = Object.freeze({ messages: [], prompt: 'p' });

function probe(sent = { reply: { content: '{}' } }) {
    const send = vi.fn(async () => ({ signal: { aborted: false }, ...sent }));
    return { send, job: createJob(KIND, { send }) };
}

describe('the shared job', () => {
    const toastr = stubToastr();

    it('sends what was built, to the transport, as this job', async () => {
        const { send, job } = probe();
        const sent = await job.request(CONTEXT, 'memory', WORK, 3, () => REQUEST);

        expect(sent).toEqual({ request: REQUEST, reply: { content: '{}' } });
        expect(send).toHaveBeenCalledWith(CONTEXT, 'memory', REQUEST, job, 3);
    });

    it('counts a build that throws as a failure and never sends', async () => {
        const { send, job } = probe();
        const sent = await job.request(CONTEXT, 'memory', WORK, 3, () => { throw new Error('bad template'); });

        expect(sent).toBeNull();
        expect(send).not.toHaveBeenCalled();
        expect(job.record('chat-a', WORK)).toEqual({ count: 1, reason: 'error' });
    });

    it('counts a transport error as a failure, and an abort as a discard', async () => {
        const failing = probe({ error: new Error('502') });
        expect(await failing.job.request(CONTEXT, 'memory', WORK, 3, () => REQUEST)).toBeNull();
        expect(failing.job.tally.stats).toMatchObject({ failures: 1, discarded: 0 });

        const aborted = probe({ signal: { aborted: true } });
        expect(await aborted.job.request(CONTEXT, 'memory', WORK, 3, () => REQUEST)).toBeNull();
        expect(aborted.job.tally.stats).toMatchObject({ failures: 0, discarded: 1, lastDiscard: 'aborted' });
    });

    it('toasts the first failure of a streak only, and gives up at the limit', () => {
        const { job } = probe();
        for (let i = 0; i < MAX_ATTEMPTS; i++) expect(job.fail('chat-a', WORK, 'format')).toBe(false);

        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toMatch(/^The probe 7 failed \(format\)\. Cairn will try again/);
        expect(job.givenUp('chat-a', WORK)).toBe(true);
        expect(job.givenUp('chat-b', WORK)).toBe(false);
    });

    it('lets a kind fail its own way', async () => {
        const { job } = probe();
        const fail = vi.fn(() => false);
        await job.request(CONTEXT, 'memory', WORK, 3, () => { throw new Error('x'); }, { fail });

        expect(fail).toHaveBeenCalledWith('error', expect.any(Error));
        expect(job.tally.stats.failures).toBe(0);
    });

    it('keeps the status when a reader throws', () => {
        const { job } = probe();
        const status = job.status({ reason: 'no-profile' }, () => { throw new Error('no chat'); }, { extra: 1 });

        expect(status).toMatchObject({ gate: 'no-profile', pending: null, failed: null, givenUp: false, extra: 1 });
    });
});
