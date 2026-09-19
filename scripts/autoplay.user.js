// ==UserScript==
// @name         Cairn Autoplay
// @namespace    cairn-memory
// @version      0.1.0
// @description  Drives N unattended roleplay turns in SillyTavern, for Cairn's phase-gate runs.
// @match        http://127.0.0.1:8181/*
// @match        http://localhost:8181/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Dev harness, not shipped: manifest.json does not load it. See docs/development.md.
//
// A turn is `/impersonate await=true` (ST writes the generated user line into
// #send_textarea, public/script.js:5524) then a click on #send_but, which is the
// same path a hand-played turn takes (public/script.js:11160). Both generations run
// Cairn's interceptor, so an N-turn run logs ~2N generations.

(function () {
    'use strict';

    const KEY = 'cairnAutoplay';
    const POLL_MS = 250;
    const IMPERSONATE_TIMEOUT_MS = 5 * 60 * 1000;
    const REPLY_TIMEOUT_MS = 10 * 60 * 1000;

    const state = {
        remaining: 10,
        settleSec: 15,
        // Impersonation runs long: left alone it wrote user turns ~50% longer than
        // the hand-played ones, which inflates summaries and `stepTokens` and makes
        // the run measure a harsher chat than real play. 0 disables the cap.
        maxChars: 1600,
        mode: 'impersonate',
        running: false,
        status: 'idle',
    };

    class Paused extends Error {}

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ctx = () => globalThis.SillyTavern.getContext();

    /** ST sets this for the life of a generation (public/script.js:7088). */
    const isBusy = () => document.body.dataset.generating === 'true';

    async function waitFor(pred, timeoutMs, label) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            if (!state.running) throw new Paused();
            if (pred()) return;
            await sleep(POLL_MS);
        }
        throw new Error(`timed out waiting for ${label}`);
    }

    /** Interruptible sleep, so Pause lands during the settle rather than after it. */
    async function settle(seconds) {
        const end = Date.now() + seconds * 1000;
        while (Date.now() < end) {
            if (!state.running) throw new Paused();
            setStatus(`settling ${Math.ceil((end - Date.now()) / 1000)}s`);
            await sleep(POLL_MS);
        }
    }

    async function run(script) {
        const result = await ctx().executeSlashCommandsWithOptions(script, {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });
        return result;
    }

    /**
     * Cut to the last sentence that ends inside the limit, so a capped turn still
     * reads as prose. Falls back to the last word boundary when that would leave a
     * fragment, and only then to a hard cut.
     */
    function trimToSentence(text, maxChars) {
        if (!maxChars || text.length <= maxChars) return text;
        const head = text.slice(0, maxChars);
        const ends = /[.!?…][")'*\]”’]*(?=\s|$)/g;
        let cut = -1;
        for (let match; (match = ends.exec(head)) !== null;) cut = match.index + match[0].length;
        if (cut <= maxChars / 2) cut = head.search(/\s\S*$/);
        return (cut > 0 ? head.slice(0, cut) : head).trim();
    }

    async function impersonateTurn() {
        const textarea = document.getElementById('send_textarea');

        setStatus('impersonating');
        // A word budget the model can act on; `trimToSentence` is the backstop for
        // when it doesn't. No pipes or braces — the string is parsed as STscript.
        const words = state.maxChars ? Math.round(state.maxChars / 6) : 0;
        const brief = words ? ` Keep this reply to about ${words} words or fewer.` : '';
        await run(`/impersonate await=true${brief}`);
        await waitFor(() => !isBusy(), IMPERSONATE_TIMEOUT_MS, 'impersonation to finish');

        const line = String(textarea.value || '').trim();
        if (!line) throw new Error('impersonation produced nothing — refusal or empty reply');

        const trimmed = trimToSentence(line, state.maxChars);
        if (trimmed !== line) {
            textarea.value = trimmed;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            setStatus(`trimmed ${line.length} to ${trimmed.length} chars`);
        }

        const before = ctx().chat.length;
        setStatus('sending');
        document.getElementById('send_but').click();

        // Chat length is the signal, not the busy flag: a fast non-streaming reply can
        // open and close inside one poll interval.
        await waitFor(() => ctx().chat.length >= before + 2, REPLY_TIMEOUT_MS, 'the reply');
        await waitFor(() => !isBusy(), REPLY_TIMEOUT_MS, 'generation to unlock');
    }

    async function continueTurn() {
        setStatus('continuing');
        await run('/continue await=true');
        await waitFor(() => !isBusy(), REPLY_TIMEOUT_MS, 'the continuation');
    }

    async function loop() {
        try {
            while (state.running && state.remaining > 0) {
                if (isBusy()) {
                    setStatus('waiting for the chat to go idle');
                    await waitFor(() => !isBusy(), REPLY_TIMEOUT_MS, 'the chat to go idle');
                }

                await (state.mode === 'continue' ? continueTurn() : impersonateTurn());

                state.remaining -= 1;
                save();
                render();

                if (state.remaining === 0) break;
                await settle(state.settleSec);
            }
            setStatus(state.remaining === 0 ? 'done' : 'paused');
        } catch (err) {
            if (!(err instanceof Paused)) {
                setStatus(`stopped: ${err.message}`);
                globalThis.toastr?.error(err.message, 'Cairn Autoplay');
            } else {
                setStatus('paused');
            }
        } finally {
            state.running = false;
            render();
        }
    }

    // --- persistence -------------------------------------------------------

    function save() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                remaining: state.remaining,
                settleSec: state.settleSec,
                maxChars: state.maxChars,
                mode: state.mode,
            }));
        } catch { /* private window, or storage full — the run still works */ }
    }

    function load() {
        try {
            const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
            if (Number.isFinite(saved.remaining)) state.remaining = saved.remaining;
            if (Number.isFinite(saved.settleSec)) state.settleSec = saved.settleSec;
            if (Number.isFinite(saved.maxChars)) state.maxChars = saved.maxChars;
            if (saved.mode) state.mode = saved.mode;
        } catch { /* fall back to the defaults above */ }
    }

    // --- overlay -----------------------------------------------------------

    let els = null;

    function setStatus(text) {
        state.status = text;
        if (els) els.status.textContent = text;
    }

    function render() {
        if (!els) return;
        els.toggle.textContent = state.running ? '⏸ Pause' : '▶ Run';
        els.toggle.dataset.running = String(state.running);
        els.remaining.value = String(state.remaining);
        els.remaining.disabled = state.running;
        els.settleInput.disabled = state.running;
        els.maxChars.disabled = state.running;
        els.mode.disabled = state.running;
        els.status.textContent = state.status;
    }

    function buildOverlay() {
        const style = document.createElement('style');
        style.textContent = `
            #cairn-autoplay {
                position: fixed; right: 12px; bottom: 12px; z-index: 9999;
                display: flex; flex-direction: column; gap: 6px;
                padding: 10px 12px; min-width: 190px;
                font: 12px/1.4 var(--mainFontFamily, system-ui, sans-serif);
                color: #e8e8e8; background: rgba(20, 20, 24, 0.92);
                border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
            }
            #cairn-autoplay .cap-title {
                font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
                font-size: 10px; opacity: 0.65;
            }
            #cairn-autoplay .cap-row { display: flex; align-items: center; gap: 6px; }
            #cairn-autoplay .cap-row label { flex: 1; opacity: 0.8; }
            #cairn-autoplay input, #cairn-autoplay select {
                width: 68px; padding: 2px 4px; font: inherit; color: inherit;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px;
            }
            #cairn-autoplay select { width: 92px; }
            #cairn-autoplay button {
                padding: 5px 8px; font: inherit; font-weight: 600; color: inherit;
                background: rgba(90, 160, 110, 0.35); cursor: pointer;
                border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px;
            }
            #cairn-autoplay button[data-running="true"] { background: rgba(190, 140, 60, 0.4); }
            #cairn-autoplay .cap-status {
                opacity: 0.7; font-size: 11px; min-height: 15px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
        `;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'cairn-autoplay';
        root.innerHTML = `
            <div class="cap-title">Cairn autoplay</div>
            <div class="cap-row"><label>Turns left</label><input type="number" min="0" step="1" id="cap-remaining"></div>
            <div class="cap-row"><label>Settle (s)</label><input type="number" min="0" step="1" id="cap-settle"></div>
            <div class="cap-row"><label>Max user chars</label><input type="number" min="0" step="100" id="cap-maxchars"></div>
            <div class="cap-row"><label>Mode</label>
                <select id="cap-mode">
                    <option value="impersonate">impersonate</option>
                    <option value="continue">continue</option>
                </select>
            </div>
            <button id="cap-toggle" type="button"></button>
            <div class="cap-status" id="cap-status"></div>
        `;
        document.body.appendChild(root);

        els = {
            remaining: root.querySelector('#cap-remaining'),
            settleInput: root.querySelector('#cap-settle'),
            maxChars: root.querySelector('#cap-maxchars'),
            mode: root.querySelector('#cap-mode'),
            toggle: root.querySelector('#cap-toggle'),
            status: root.querySelector('#cap-status'),
        };

        els.settleInput.value = String(state.settleSec);
        els.maxChars.value = String(state.maxChars);
        els.mode.value = state.mode;

        els.remaining.addEventListener('change', () => {
            state.remaining = Math.max(0, Math.floor(Number(els.remaining.value) || 0));
            save();
            render();
        });
        els.settleInput.addEventListener('change', () => {
            state.settleSec = Math.max(0, Math.floor(Number(els.settleInput.value) || 0));
            save();
        });
        els.maxChars.addEventListener('change', () => {
            state.maxChars = Math.max(0, Math.floor(Number(els.maxChars.value) || 0));
            save();
        });
        els.mode.addEventListener('change', () => {
            state.mode = els.mode.value;
            save();
        });
        els.toggle.addEventListener('click', () => {
            if (state.running) {
                // Pause lands at the next checkpoint; an in-flight generation finishes.
                state.running = false;
                setStatus('pausing after this turn');
                render();
                return;
            }
            if (state.remaining <= 0) {
                setStatus('set a turn count first');
                return;
            }
            state.running = true;
            setStatus('starting');
            render();
            loop();
        });

        render();
    }

    async function main() {
        for (let i = 0; i < 600; i++) {
            if (globalThis.SillyTavern?.getContext) break;
            await sleep(500);
        }
        if (!globalThis.SillyTavern?.getContext) return;

        load();
        // A reload mid-run keeps the count but never resumes on its own.
        state.running = false;
        buildOverlay();
        setStatus('idle');
    }

    main();
})();
