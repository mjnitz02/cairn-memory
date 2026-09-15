/**
 * SillyTavern entry point. Bootstrap and wiring only — no logic lives here
 * (CLAUDE.md §1.1). Everything real is a module under src/.
 */
import { DISPLAY_NAME, SLUG } from './src/constants.js';
import { createDiskLog } from './src/util/disk-log.js';
import { createAssembler } from './src/prompt/assembler.js';
import { createInjector } from './src/prompt/injector.js';
import { createObserver } from './src/prompt/observer.js';
import { migrateSettings } from './src/store/schema.js';
import { createInspector } from './src/ui/inspector.js';
import { renderSettingsPanel } from './src/ui/panel.js';
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

        // ST resolves the manifest's `generate_interceptor` off globalThis
        // (extensions.js:2035), so the name here must match manifest.json.
        const injector = createInjector(getContext);
        injector.setHoldEnabled(settings.holdWorldInfo);
        globalThis.cairn_holdWorldInfo = injector.intercept;

        // Plans the memory block and measures it against qvink's live one. It
        // does not write yet — the handover waits on that comparison
        // (docs/decisions.md D-0020, D-0026).
        const assembler = createAssembler(getContext);

        let inspector;
        const observer = createObserver(getContext, {
            onSnapshot: (snapshot) => {
                inspector?.render(snapshot);
                diskLog.append(snapshot, getContext);
            },
            holding: () => (settings.holdWorldInfo ? injector.remembered.size : null),
            memory: (turn) => assembler.plan(turn),
        });

        inspector = createInspector(await renderSettingsPanel(context, {
            onEnabledChange: (enabled) => {
                if (enabled) {
                    observer.start();
                    injector.start();
                } else {
                    observer.stop();
                    injector.stop();
                }
            },
            onLogToDiskChange: (enabled) => diskLog.setEnabled(enabled),
            onHoldWorldInfoChange: (enabled) => injector.setHoldEnabled(enabled),
        }));
        inspector.render(observer.latest);

        // Both follow `enabled` alone: observing is free, and holding degrades
        // to ST's own scan rather than to a broken prompt (CLAUDE.md §4.17).
        if (settings.enabled) {
            observer.start();
            injector.start();
        }

        // A new chat is a new baseline — stability across chats is meaningless.
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            observer.resetBaseline();
            injector.reset();
            assembler.reset();
            diskLog.reset();
            inspector.render(null);
        });

        info(`${DISPLAY_NAME} loaded.`);
    } catch (err) {
        // Cairn never breaks the chat (CLAUDE.md §4.17): fail loudly in the
        // console, quietly everywhere else.
        error('Failed to initialise.', err);
    }
})();
