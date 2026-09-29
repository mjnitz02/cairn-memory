/**
 * Adopting a chat (docs/decisions.md D-0090): walking it from the first message as if
 * Cairn had been on all along, so a chat played under Qvink — or before Cairn — gets
 * index records and canon built at the pace of its story rather than in one pick over
 * the finished thing.
 *
 * Three phases, in order. **Import**: a Qvink summary becomes Cairn's own where Cairn has
 * none, since index records hang off Cairn's summaries — free, no call. **Summarise**:
 * whatever still waits, through the queue's own summary job. **Replay**: every `every`
 * summaries, index the new ones and re-pick canon *carrying the canon so far forward*,
 * each pick stored on the newest record it read, so the history shows how it grew.
 *
 * The queue's jobs do every write, so what it stores and how it fails are theirs. This
 * file owns only the order. `adoptionPlan` is pure; `createAdoption` is the driver.
 */
import { canonFor, MIN_SLOTS } from '../memory/canon.js';
import { readScenes } from '../memory/scenes.js';
import { readCanon, readIndex, readScene, writeScene } from '../store/chat-store.js';
import { MAX_BATCH } from '../memory/index-strategy.js';
import { MIN_INDEX_RECORDS, indexRecords } from './compactor.js';
import { debug } from '../util/log.js';

/** What an imported summary stores as its prompt: it came from Qvink, not from a prompt of ours. */
export const IMPORTED_PROMPT = 'qvink-import';

const readers = { readCanon, readIndex };

/**
 * What an adoption would do to this chat, before it does any of it: what it can import,
 * how many messages it must summarise, and how many index and canon calls the replay makes.
 *
 * @param {Array<object>} chat
 * @param {{every: number, pending: number[]}} options `pending` is `pendingScenes(chat)`.
 * @returns {{imports: number[], summaries: number, steps: number, calls: number}}
 */
export function adoptionPlan(chat, { every, pending }) {
    const imports = importable(chat);
    const importing = new Set(imports);
    const summaries = pending.filter((index) => !importing.has(index)).length;
    const scenes = readScenes(chat).filter((scene) => scene.source === 'cairn' || importing.has(scene.index)).length
        + summaries;
    const steps = Math.ceil(scenes / every);
    return { imports, summaries, steps, calls: summaries + 2 * steps };
}

/** Messages carrying a Qvink summary the block reads, and no Cairn summary of their own. */
function importable(chat) {
    return readScenes(chat)
        .filter((scene) => scene.source === 'qvink' && scene.eligible && readScene(chat[scene.index]).status === 'none')
        .map((scene) => scene.index);
}

/**
 * @param {{getContext: () => object, summarise: Function, indexer: object, canon: object,
 *          save: Function, clock: () => number}} machinery The summarizer's jobs and helpers.
 */
export function createAdoption({ getContext, summarise, indexer, canon, save, clock }) {
    /**
     * Run it. Never throws for a failed call: that job's own failure policy has already
     * reported it, and the adoption carries on with what it has.
     *
     * @param {object} config The settings.
     * @param {{every: number, slots: number, pending: () => number[],
     *          cancelled: () => boolean, progress: (update: object) => void}} options
     * @returns {Promise<{imported: number, summarised: number, steps: number, cancelled: boolean}>}
     */
    async function run(config, { every, slots, pending, cancelled, progress }) {
        const result = { imported: 0, summarised: 0, steps: 0, cancelled: false };
        const stop = () => {
            result.cancelled = cancelled();
            return result.cancelled;
        };

        const context = getContext();
        const at = new Date(clock()).toISOString();
        for (const index of importable(context.chat)) {
            const text = readScenes([context.chat[index]])[0]?.text;
            if (text && writeScene(context.chat[index], { text, prompt: IMPORTED_PROMPT, at })) result.imported++;
        }
        if (result.imported) await save(context, 'imported summaries');
        progress({ phase: 'import', imported: result.imported });

        const waiting = pending();
        for (const [done, index] of waiting.entries()) {
            if (stop()) return result;
            progress({ phase: 'summarise', done, of: waiting.length });
            if (await summarise(getContext(), config, index)) result.summarised++;
        }

        const summarised = () => getContext().chat.flatMap((message, index) => (readScene(message).status === 'valid' ? [index] : []));
        const all = summarised();
        const steps = Math.ceil(all.length / every);
        for (let step = 0; step < steps; step++) {
            if (stop()) return result;
            const through = all[Math.min((step + 1) * every, all.length) - 1];
            progress({ phase: 'replay', step: step + 1, of: steps, through });
            await indexThrough(config, through);
            if (stop()) return result;
            if (slots >= MIN_SLOTS) await pickThrough(config, through, slots);
            result.steps++;
        }
        return result;
    }

    /** Index every summary up to `through` that has no record, a batch at a time. */
    async function indexThrough(config, through) {
        const { chat } = getContext();
        const waiting = chat.flatMap((message, index) => {
            if (index > through) return [];
            const scene = readScene(message);
            if (scene.status !== 'valid' || readIndex(message).status === 'valid') return [];
            return [{ index, text: scene.scene.text }];
        });
        for (let start = 0; start < waiting.length; start += MAX_BATCH) {
            await indexer.run(getContext(), config, waiting.slice(start, start + MAX_BATCH));
        }
    }

    /** One pick over the records up to `through`, starting from the canon they last had. */
    async function pickThrough(config, through, slots) {
        const { chat } = getContext();
        const records = indexRecords(chat, readers).filter((entry) => entry.index <= through);
        if (records.length < MIN_INDEX_RECORDS) return;
        const rowOf = new Map(records.map((entry, at) => [entry.index, at + 1]));
        const previous = canonFor(chat, readers, { through }).facts.map((fact) => ({
            text: fact.text,
            rows: fact.from.map((index) => rowOf.get(index)).filter(Boolean),
        }));
        const covers = [records[0].index, records[records.length - 1].index];
        debug(`Adopting: picking canon over ${records.length} records through #${covers[1]}, carrying ${previous.length} fact(s).`);
        await canon.run(getContext(), config, {
            due: true,
            reason: 'adopt',
            records: records.map((entry) => ({ ...entry, message: chat[entry.index] })),
            covers,
            slots,
            message: chat[covers[1]],
            previous,
        });
    }

    return { run };
}
