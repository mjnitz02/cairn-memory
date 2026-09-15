import { afterEach, describe, expect, it, vi } from 'vitest';
import { debug, info, isDebugEnabled, resetToasts, setDebugEnabled, toastOnce } from '../src/util/log.js';

afterEach(() => {
    setDebugEnabled(false);
    resetToasts();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('log', () => {
    it('suppresses debug output by default', () => {
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        debug('quiet');
        expect(spy).not.toHaveBeenCalled();
    });

    it('emits debug output once enabled', () => {
        const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
        setDebugEnabled(true);
        debug('loud');
        expect(spy).toHaveBeenCalledWith('[cairn]', 'loud');
    });

    it('namespaces every line', () => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        info('hello');
        expect(spy).toHaveBeenCalledWith('[cairn]', 'hello');
    });

    it('coerces the enabled flag', () => {
        setDebugEnabled('yes');
        expect(isDebugEnabled()).toBe(true);
    });
});

describe('toastOnce', () => {
    /**
     * A failing generate hook can fail on every turn. CLAUDE.md §4.17 asks for
     * one toast, and one toast is not "one per turn".
     */
    it('shows a given message once, however often it is raised', () => {
        const warning = vi.fn();
        vi.stubGlobal('toastr', { warning });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        for (let turn = 0; turn < 5; turn++) toastOnce('the same failure');

        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith('the same failure', 'Cairn-Memory');
    });

    it('still shows a different failure', () => {
        const warning = vi.fn();
        vi.stubGlobal('toastr', { warning });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        toastOnce('one thing');
        toastOnce('another thing');

        expect(warning).toHaveBeenCalledTimes(2);
    });

    it('still logs, and does not throw, outside SillyTavern', () => {
        // The pure modules have to stay runnable without a browser (CLAUDE.md §1.3).
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => toastOnce('no toastr here')).not.toThrow();
        expect(spy).toHaveBeenCalledWith('[cairn]', 'no toastr here');
    });
});
