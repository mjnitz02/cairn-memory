import { describe, expect, it, vi } from 'vitest';
import { createObserver } from '../src/prompt/observer.js';
import { createContext, extension_prompt_types, makeMessage } from './mocks/sillytavern.js';

function started(context, options) {
    const observer = createObserver(() => context, options);
    observer.start();
    return observer;
}

async function generate(context, prompt, { dryRun = false } = {}) {
    const eventData = typeof prompt === 'string'
        ? { prompt, dryRun }
        : { chat: prompt, dryRun };
    const type = typeof prompt === 'string'
        ? context.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS
        : context.eventTypes.CHAT_COMPLETION_PROMPT_READY;

    await context.eventSource.emit(type, eventData);
    return eventData;
}

describe('observer — invariants', () => {
    /**
     * P0 is read-only (DESIGN.md §13). If the observer can change the prompt,
     * every measurement it takes is of a prompt it perturbed.
     */
    it('never writes back to the text-completion payload', async () => {
        const context = createContext();
        started(context);

        const eventData = await generate(context, 'the prompt');
        expect(eventData).toEqual({ prompt: 'the prompt', dryRun: false });
    });

    it('never writes back to the chat-completion payload', async () => {
        const context = createContext();
        started(context);

        const chat = [{ role: 'user', content: 'hello' }];
        const eventData = await generate(context, chat);

        // Same array, not a replacement: ST keeps generating from this object.
        expect(eventData.chat).toBe(chat);
        expect(eventData.chat).toEqual([{ role: 'user', content: 'hello' }]);
    });

    /**
     * The regression this whole extension exists downstream of: structuredClone
     * drops Symbol keys silently, so a cloning interceptor destroys another
     * extension's flags and nothing errors (docs/decisions.md, Lessons).
     */
    it('leaves Symbol-keyed flags from other extensions intact', async () => {
        const context = createContext();
        started(context);

        const ignore = Symbol.for('ignore');
        const message = makeMessage({ mes: 'summarised already' });
        message.extra[ignore] = true;
        const chat = [message];

        await generate(context, chat);

        expect(chat[0]).toBe(message);
        expect(chat[0].extra[ignore]).toBe(true);
    });

    it('ignores dry runs, which are not real generations', async () => {
        const context = createContext();
        const observer = started(context);

        await generate(context, 'a dry run', { dryRun: true });
        expect(observer.snapshots).toHaveLength(0);
    });

    it('swallows its own failures rather than breaking generation', async () => {
        const context = createContext();
        // A broken tokenizer must not take the chat down with it.
        context.getTokenCountAsync = () => { throw new Error('tokenizer exploded'); };
        const observer = started(context);

        await expect(generate(context, 'a prompt')).resolves.toBeDefined();
        expect(observer.latest.promptTokens).toBeGreaterThan(0); // fell back to the estimate
    });

    it('stops listening when stopped', async () => {
        const context = createContext();
        const observer = started(context);
        observer.stop();

        await generate(context, 'a prompt');
        expect(observer.snapshots).toHaveLength(0);
        expect(observer.running).toBe(false);
    });

    it('does not double-register when started twice', async () => {
        const context = createContext();
        const observer = started(context);
        observer.start();

        await generate(context, 'a prompt');
        expect(observer.snapshots).toHaveLength(1);
    });
});

describe('observer — measurement', () => {
    it('has no stability baseline on the first turn', async () => {
        const context = createContext();
        const observer = started(context);

        await generate(context, 'first turn');
        expect(observer.latest.stability.stabilityPercent).toBeNull();
    });

    it('measures a growing prompt as near-total reuse', async () => {
        const context = createContext();
        const observer = started(context);
        const base = 'stable prefix '.repeat(50);

        await generate(context, base);
        await generate(context, `${base}one more turn`);

        expect(observer.latest.stability.stabilityPercent).toBeGreaterThan(95);
    });

    it('measures a shifted prefix as broken', async () => {
        const context = createContext();
        const observer = started(context);
        const tail = 'tail '.repeat(200);

        await generate(context, `state A${tail}`);
        await generate(context, `state B${tail}`);

        expect(observer.latest.stability.stabilityPercent).toBeLessThan(10);
    });

    it('records who is writing into the prompt', async () => {
        const context = createContext();
        context.setExtensionPrompt('qvink_memory_short', 'their memory', extension_prompt_types.IN_CHAT, 2);
        context.setExtensionPrompt('cairn_state', 'our state', extension_prompt_types.IN_CHAT, 2);
        const observer = started(context);

        await generate(context, 'a prompt');

        expect(observer.latest.summary.writers).toBe(2);
        expect(observer.latest.inventory.map(e => e.owner)).toContain('qvink');
    });

    it('attaches the World Info entries that fired for this turn', async () => {
        const context = createContext();
        const observer = started(context);

        await context.eventSource.emit(context.eventTypes.WORLD_INFO_ACTIVATED, [
            { world: 'Lorebook', uid: 3, comment: 'The lighthouse', position: 4, depth: 2 },
        ]);
        await generate(context, 'a prompt');

        expect(observer.latest.worldInfo).toEqual([
            { world: 'Lorebook', uid: 3, comment: 'The lighthouse', position: 4, depth: 2, outletName: '' },
        ]);
    });

    it('does not carry World Info activations into the next turn', async () => {
        const context = createContext();
        const observer = started(context);

        await context.eventSource.emit(context.eventTypes.WORLD_INFO_ACTIVATED, [{ world: 'L', uid: 1 }]);
        await generate(context, 'turn one');
        await generate(context, 'turn two');

        expect(observer.latest.worldInfo).toEqual([]);
    });

    it('reports the prompt as a share of the context window', async () => {
        const context = createContext();
        context.maxContext = 1000;
        const observer = started(context);

        await generate(context, 'x'.repeat(400)); // mock tokenizer: chars / 4
        expect(observer.latest.promptTokens).toBe(100);
        expect(observer.latest.contextPercent).toBe(10);
    });

    it('keeps history bounded', async () => {
        const context = createContext();
        const observer = started(context, { limit: 3 });

        for (let i = 0; i < 6; i++) await generate(context, `turn ${i}`);

        expect(observer.snapshots).toHaveLength(3);
        expect(observer.latest.promptChars).toBe('turn 5'.length);
    });

    it('drops the baseline on demand, because stability across chats is meaningless', async () => {
        const context = createContext();
        const observer = started(context);

        await generate(context, 'chat one prompt');
        observer.resetBaseline();
        await generate(context, 'a completely different chat');

        expect(observer.latest.stability.stabilityPercent).toBeNull();
    });

    it('notifies a listener for each observed generation', async () => {
        const context = createContext();
        const onSnapshot = vi.fn();
        started(context, { onSnapshot });

        await generate(context, 'a prompt');
        expect(onSnapshot).toHaveBeenCalledTimes(1);
    });
});

describe('observer — mixed backends', () => {
    /**
     * Switching connection profiles mid-chat changes the prompt shape entirely.
     * Comparing across that boundary reports a collapse caused by the switch,
     * which would read as a finding about the prompt and is not one.
     */
    it('keeps a separate baseline per API path', async () => {
        const context = createContext();
        const observer = started(context);
        const body = 'the shared body of the prompt '.repeat(20);

        await generate(context, `text ${body}`);                          // tc
        await generate(context, [{ role: 'user', content: `cc ${body}` }]); // cc

        // First chat-completion turn: no chat-completion baseline yet.
        expect(observer.latest.api).toBe('chat-completion');
        expect(observer.latest.stability.stabilityPercent).toBeNull();

        await generate(context, `text ${body} plus a new turn`);          // tc again

        // Compared against the earlier text-completion turn, not the cc one.
        expect(observer.latest.api).toBe('text-completion');
        expect(observer.latest.stability.stabilityPercent).toBeGreaterThan(90);
    });

    it('drops every API baseline on a new chat', async () => {
        const context = createContext();
        const observer = started(context);

        await generate(context, 'text one');
        await generate(context, [{ role: 'user', content: 'chat one' }]);
        observer.resetBaseline();
        await generate(context, 'text two');

        expect(observer.latest.stability.stabilityPercent).toBeNull();
    });
});

describe('observer — stale context', () => {
    /**
     * SillyTavern.getContext() is a snapshot, not a handle. ST reassigns
     * `extension_prompts` in clearChat (public/script.js:1590) and
     * `chat_metadata` in ten places, so a context captured at extension load
     * is orphaned the first time a chat opens. Holding one made the inspector
     * report "0 injections" while qvink was visibly injecting.
     */
    it('re-reads the context each turn instead of holding one', async () => {
        let context = createContext();
        const observer = createObserver(() => context);
        observer.start();

        // ST replaces the whole prompts object, as clearChat does.
        const replaced = createContext();
        replaced.setExtensionPrompt('qvink_memory_short', 'their memory', 1, 2);
        replaced.eventSource = context.eventSource; // same bus, new snapshot
        context = replaced;

        await generate(context, 'a prompt');

        expect(observer.latest.summary.count).toBe(1);
        expect(observer.latest.inventory[0].owner).toBe('qvink');
    });

    it('picks up a context window that changed after start', async () => {
        let context = createContext();
        const observer = createObserver(() => context);
        observer.start();

        const replaced = createContext();
        replaced.maxContext = 8000;
        replaced.eventSource = context.eventSource;
        context = replaced;

        await generate(context, 'x'.repeat(800));
        expect(observer.latest.maxContext).toBe(8000);
    });
});
