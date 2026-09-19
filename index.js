/**
 * SillyTavern entry point. Bootstrap and wiring only — no logic lives here
 * (CLAUDE.md §1.1). Everything real is a module under src/.
 */
import { DISPLAY_NAME, SLUG } from './src/constants.js';
import { createDiskLog } from './src/util/disk-log.js';
import { createAssembler } from './src/prompt/assembler.js';
import { createInjector } from './src/prompt/injector.js';
import { createObserver } from './src/prompt/observer.js';
import { createStatePlacement } from './src/prompt/state-placement.js';
import { createSummarizer } from './src/pipeline/summarizer.js';
import { migrateSettings } from './src/store/schema.js';
import { createChatMarks } from './src/ui/chat-marks.js';
import { createInspector } from './src/ui/inspector.js';
import { renderSettingsPanel } from './src/ui/panel.js';
import { installResummariseButton } from './src/ui/resummarise-button.js';
import { error, info, setDebugEnabled } from './src/util/log.js';

(async function init() {
    try {
        const context = SillyTavern.getContext();

        // Settings are migrated on every load, so an old install lands on the
        // current shape before anything reads it.
        const settings = migrateSettings(context.extensionSettings[SLUG]);
        context.extensionSettings[SLUG] = settings;
        context.saveSettingsDebounced();
        setDebugEnabled(settings.debugLogging);

        const getContext = () => SillyTavern.getContext();

        const diskLog = createDiskLog();
        diskLog.setEnabled(settings.logToDisk);

        // Plans the memory block every turn. Whether the plan is written is the
        // handover gate's call (src/prompt/handover.js, docs/decisions.md D-0027).
        // `settings` is read for the world state's reserve, which is 0 while the
        // state is off (src/prompt/reserves.js).
        const assembler = createAssembler(getContext, {
            own: settings.ownMemoryBlock,
            settings: () => settings,
        });

        // ST resolves the manifest's `generate_interceptor` off globalThis
        // (extensions.js:2035), so the name here must match manifest.json. It is
        // the only hook still ahead of prompt assembly, so every write happens in
        // it: the World Info hold, the memory block and the world state.
        const statePlacement = createStatePlacement(getContext, { settings: () => settings });
        const injector = createInjector(getContext, { memory: assembler, state: statePlacement });
        injector.setHoldEnabled(settings.holdWorldInfo);
        globalThis.cairn_intercept = injector.intercept;

        // Writes Cairn's own summaries and world state after each reply. Each kind gates
        // itself (src/pipeline/gates.js), so only `enabled` starts and stops it here.
        let inspector;
        const summarizer = createSummarizer(getContext, {
            settings: () => settings,
            // The budget a compaction pass needs lives in the assembler, so the pass it
            // works out each turn comes through rather than being derived twice
            // (docs/p4-plan.md decision 6).
            memory: () => assembler.pendingPass,
            onUpdate: () => {
                inspector?.summaries(summarizer.status);
                marks.refresh();
            },
        });
        // The summaries and states under their messages, and the only in-chat sign one is being written.
        const marks = createChatMarks(getContext, { status: () => summarizer.status, settings: () => settings });
        installResummariseButton(summarizer);

        const observer = createObserver(getContext, {
            onSnapshot: (snapshot) => {
                inspector?.render(snapshot);
                diskLog.append(snapshot, getContext);
            },
            holding: () => (settings.holdWorldInfo ? injector.remembered.size : null),
            // The plan the interceptor already acted on. Nothing measured here
            // flows back into the next plan (docs/decisions.md D-0033).
            memory: () => assembler.latest,
            summaries: () => summarizer.status,
            state: () => statePlacement.latest,
        });

        inspector = createInspector(await renderSettingsPanel(context, {
            onEnabledChange: (enabled) => {
                if (enabled) {
                    observer.start();
                    injector.start();
                    summarizer.start();
                    marks.start();
                } else {
                    observer.stop();
                    injector.stop();
                    summarizer.stop();
                    marks.stop();
                }
            },
            onLogToDiskChange: (enabled) => diskLog.setEnabled(enabled),
            onHoldWorldInfoChange: (enabled) => injector.setHoldEnabled(enabled),
            onOwnMemoryBlockChange: (enabled) => assembler.setOwnEnabled(enabled),
            // Off takes effect at the next generation; on may have a state to bring up to date.
            onWorldStateChange: () => {
                summarizer.drain();
                marks.refresh();
            },
            // Off takes effect at the next generation; on waits for the next pressure.
            onKeepCanonChange: () => summarizer.drain(),
            // A newly chosen profile may have a backlog waiting for it.
            onMemoryProfileChange: () => summarizer.drain(),
        }));
        inspector.render(observer.latest);
        inspector.summaries(summarizer.status);

        // Both follow `enabled` alone: observing is free, and holding degrades
        // to ST's own scan rather than to a broken prompt (CLAUDE.md §4.17).
        if (settings.enabled) {
            observer.start();
            injector.start();
            summarizer.start();
            marks.start();
        }

        // A new chat is a new baseline — stability across chats is meaningless.
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            observer.resetBaseline();
            injector.reset();
            assembler.reset();
            statePlacement.reset();
            diskLog.reset();
            inspector.render(null);
            inspector.summaries(summarizer.status);
        });

        info(`${DISPLAY_NAME} loaded.`);
    } catch (err) {
        // Cairn never breaks the chat (CLAUDE.md §4.17): fail loudly in the
        // console, quietly everywhere else.
        error('Failed to initialise.', err);
    }
})();
