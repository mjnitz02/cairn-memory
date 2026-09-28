import { describe, expect, it } from 'vitest';
import { NO_REASONING, memoryProfile, profileSource, requestOverrides } from '../src/pipeline/request-options.js';
import { createContext } from './mocks/sillytavern.js';

/**
 * What Cairn asks of every memory request (docs/decisions.md D-0086). Profiles mirror
 * Connection Manager's shape (public/scripts/extensions/connection-manager/index.js):
 * `api` names a CONNECT_API_MAP entry and `model` is what the calls go to.
 */
const OPENROUTER = { id: 'or', name: 'OpenRouter GLM', mode: 'cc', api: 'openrouter', model: 'z-ai/glm-5.3' };
const CUSTOM = { id: 'custom', name: 'Custom GLM', mode: 'cc', api: 'custom', model: 'z-ai/glm-4.7' };
const LOCAL = { id: 'local', name: 'Local', mode: 'tc', api: 'generic', model: 'local-model' };

const context = () => createContext({ profiles: [OPENROUTER, CUSTOM, LOCAL] });

describe('the memory profile', () => {
    it('is found by id, and is null when missing or unset', () => {
        expect(memoryProfile(context(), 'or')).toBe(OPENROUTER);
        expect(memoryProfile(context(), 'gone')).toBeNull();
        expect(memoryProfile(context(), undefined)).toBeNull();
    });

    it('resolves its source through ST\'s own map (public/scripts/slash-commands.js:191)', () => {
        expect(profileSource(context(), OPENROUTER)).toBe('openrouter');
        expect(profileSource(context(), CUSTOM)).toBe('custom');
        expect(profileSource(context(), LOCAL)).toBeNull();
        expect(profileSource(context(), { id: 'x' })).toBeNull();
    });
});

describe('asking for no reasoning', () => {
    it('asks an OpenRouter profile for none, the value ST sends for "Minimum"', () => {
        expect(NO_REASONING).toBe('none');
        expect(requestOverrides(context(), OPENROUTER)).toEqual({ reasoning_effort: 'none' });
    });

    it('asks nothing of a source that would forward `none` unchecked', () => {
        expect(requestOverrides(context(), CUSTOM)).toEqual({});
        expect(requestOverrides(context(), LOCAL)).toEqual({});
        expect(requestOverrides(context(), null)).toEqual({});
    });
});
