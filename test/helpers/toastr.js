import { afterEach, beforeEach, vi } from 'vitest';
import { resetToasts } from '../../src/util/log.js';

/**
 * Stub ST's `toastr` for every test in the file (or `describe`) that calls this, and quiet
 * the console Cairn warns into. Each test starts with no toast shown, so a once-per-session
 * toast is seen again.
 *
 * @returns {{warning: import('vitest').Mock}} `warning` is the current test's mock.
 */
export function stubToastr() {
    const toastr = { warning: null };
    beforeEach(() => {
        toastr.warning = vi.fn();
        vi.stubGlobal('toastr', { warning: toastr.warning });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        resetToasts();
    });
    afterEach(() => {
        resetToasts();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });
    return toastr;
}
