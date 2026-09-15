import { afterEach, describe, expect, it, vi } from 'vitest';
import { debug, info, isDebugEnabled, setDebugEnabled } from '../src/util/log.js';

afterEach(() => {
    setDebugEnabled(false);
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
