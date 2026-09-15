/**
 * SillyTavern entry point. Bootstrap and wiring only — no logic lives here
 * (CLAUDE.md §1.1). Everything real is a module under src/.
 */
import { DISPLAY_NAME, SLUG } from './src/constants.js';
import { createDiskLog } from './src/util/disk-log.js';
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

        let inspector;
        const observer = createObserver(getContext, {
            onSnapshot: (snapshot) => {
                inspector?.render(snapshot);
                diskLog.append(snapshot, getContext);
            },
        });

        inspector = createInspector(await renderSettingsPanel(context, {
            onEnabledChange: (enabled) => (enabled ? observer.start() : observer.stop()),
            onLogToDiskChange: (enabled) => diskLog.setEnabled(enabled),
        }));
        inspector.render(observer.latest);

        // P0 is read-only instrumentation: observing costs nothing and risks
        // nothing, so it follows `enabled` alone (DESIGN.md §13).
        if (settings.enabled) observer.start();

        // A new chat is a new baseline — stability across chats is meaningless.
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            observer.resetBaseline();
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
