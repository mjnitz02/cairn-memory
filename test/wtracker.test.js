import { describe, expect, it } from 'vitest';
import { WTRACKERS, wtrackerLoaded } from '../src/interop/wtracker.js';
import { createContext } from './mocks/sillytavern.js';

describe('standing aside for WTracker', () => {
    const scope = {};

    it('is quiet when neither is installed, whatever their leftover settings say', () => {
        const context = createContext();
        context.extensionSettings.WTrackerLite = { autoMode: 'responses' };

        expect(wtrackerLoaded(context, { scope })).toBeNull();
    });

    it.each(WTRACKERS.map((tracker) => [tracker.name, tracker]))('names %s when it is installed and enabled', (name, tracker) => {
        const context = createContext({ extensions: [tracker.extension] });

        expect(wtrackerLoaded(context, { scope })).toBe(name);
    });

    it('ignores an installed but disabled one, which ST never loads (public/scripts/extensions.js:626)', () => {
        const context = createContext({ extensions: WTRACKERS.map((tracker) => tracker.extension) });
        context.extensionSettings.disabledExtensions.push(...WTRACKERS.map((tracker) => tracker.extension));

        expect(wtrackerLoaded(context, { scope })).toBeNull();
    });

    it('sees one installed under another folder name by its interceptor', () => {
        const context = createContext();

        expect(wtrackerLoaded(context, { scope: { wtrackerliteGenerateInterceptor: () => {} } })).toBe('WTrackerLite');
        expect(wtrackerLoaded(context, { scope: { wtrackerGenerateInterceptor: 'not a function' } })).toBeNull();
    });

    it('looks for them under their own folders, not qvink\'s', () => {
        expect(WTRACKERS.map((tracker) => tracker.extension)).toEqual([
            'third-party/SillyTavern-WTrackerLite',
            'third-party/SillyTavern-WTracker',
        ]);
    });
});
