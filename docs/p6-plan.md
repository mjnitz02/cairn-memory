# P6 plan — a cap the chat can actually hold

**Status: proposal, 2026-09-17.** Nothing here is built. P6 moves ahead of P4
(D-0051). As each part lands, its decisions move into `decisions.md` and its
mechanism into `how-it-works.md`, and this page is deleted when P6 closes.

Today the memory block's cap is a fixed 35% of the max prompt (D-0038). P6 keeps 35%
as the ceiling and lowers the cap when the rest of the prompt doesn't leave that
much room. Every reserve is worked out from the chat and the settings, never
measured from a prompt that went out, so D-0033 stands: the same chat always gets
the same cap, a reload costs nothing extra, and nothing is stored. The see-saw
(`RAW_WINDOW` 10, `STEP` 10) and the half-cap floor stay as they are. P6 closes on
mechanics.

---

## What the P3 run shows

From the P3 branch's inspector log (25 generations) and the chat file, shapes and
sizes only.

- **The cap is bigger than the room.** The max prompt is 23,040. On the turn before
  the second step the prompt was 21,964 with a 4,945-token block, so everything
  else came to **17,019**. That leaves about 6,000 for the block at its fullest,
  against a cap of 8,063. The block is 6,017 now, and a step adds about 1,050 with
  real-length messages, so the cycle after the next step goes over by about 1,000.
- **What overflowing costs.** Text completion fills the chat newest-first until the
  limit (`script.js:4920`), then fits unpinned example messages into what is left
  (`:4960-4969`). So the first thing lost is Esin's 2,164 tokens of examples, then
  the oldest raw messages. The examples sit above the history, so a turn that loses
  them also re-reads the whole raw window, and the step that brings them back
  re-reads it again. Cairn sees none of this: the block is under its cap.
- **Eviction only happens on reloads.** The first turn after a reload trimmed the
  block to its floor and dropped 33 summaries (messages 0–32). Growth never reached
  the cap.
- **The raw window swings by about 5,000 tokens.** It holds 10 messages just after a
  step and 19 just before the next. That swing is the largest single cost, larger
  than the block's slack.

**The prompt at its fullest, split** (the turn before the second step):

| Part | Tokens | Source |
|---|---|---|
| Card: description 2,085, examples 2,164, persona 29, system prompt 222 | 4,500 | ST's prompt itemization on a later turn |
| Lore in the prompt (29 of 31 entries) | 4,634 | same |
| Card + lore, as the log measures it | 9,082 | prompt − block − raw window − state, on the last turn |
| Raw window, 19 messages (3 of them "continue") | ~7,860 | 17,019 − 9,082 − 77 |
| World state | 77 | `state_tokens` |

The card's fields and the lore add to 9,134, which is 52 tokens from what the prompt
carried. That's what makes working the reserves out from the chat viable.

**The heaviest 19 consecutive messages**, from `extra.token_count` in the corpus:
Esin 7,968, Risa 7,089, Elizabeth 5,970. The P3 branch, whose user messages were
written by Impersonate, reaches about 8,450 (estimated from characters).

**Lorebooks on this machine** (enabled entries): Esin's 31 entries, 21,812 characters
(about 5,000 tokens). Akane's 110, 187,098 characters. Eldoria's 4, 4,129. ST's World
Info budget is 25% with no cap, so 5,760 tokens at a 23,040 max prompt.

---

## Decisions

1. **The cap is `min(35% of the max prompt, the room)`**, and never below 10%.
   - **Room** = max prompt − card − lore − raw window − world state − margin.
   - **35% stays the ceiling.** A chat with room keeps exactly today's cap, so P6
     changes nothing where nothing was wrong. Raising the ceiling is a separate
     decision, for when P4 and P5 have something to fill it with.
   - **The 10% minimum** (2,304 on Esin) is for a chat that can't fit at all: a
     card, lore and raw window that already fill the prompt. The block keeps some
     memory, ST trims history as it does today, and the inspector says the chat is
     `starved`. It's a judgement call: an empty block would lose all memory to
     save a few raw messages.

2. **Every reserve is worked out from the chat and the settings. Nothing is
   measured from a prompt.** This keeps D-0033 as it stands.
   - **Why not measure.** D-0028 and D-0030–D-0032 measured the rest of the prompt
     and fed it into the next plan. Each piece had its own cold start, each error
     fed the next turn, and a reload settled on turn 4. D-0033 removed all of it.
   - **What this replaces in `DESIGN.md` §13.** P6 there reserves lore by
     watching it and "pauses and works the budget out again" when a check shows an
     overflow. Both depend on what has been seen. Working each reserve out from
     the chat needs no watching, no store and no pause.
   - **What it can't see.** Injections from other extensions (Author's Note, vector
     storage), the story string's own wording and the instruct wrappers around
     each message. The margin covers them, and the log checks it (§3).

3. **Card:** the card fields ST puts in the story string.
   - `getCharacterCardFields()` (`st-context.js:232`, fields at `script.js:3476`):
     `description`, `personality`, `scenario`, `persona`, `mesExamples`, `jailbreak`
     and `charDepthPrompt`.
   - **The system prompt** is the one ST uses: the character's own when "prefer
     character prompt" is on and it has one, otherwise the instruct system prompt
     if it's enabled (`script.js:5366`).
   - **Counted with ST's tokenizer** and cached by text, so an unchanged card is
     counted once.

4. **Lore:** `min(ST's World Info budget, every enabled entry in the books ST
   scans)`, plus the entries that ignore the budget.
   - **The budget** is `world_info_budget`% of the max prompt, limited by
     `world_info_budget_cap` if set (`world-info.js:4736-4741`). ST stops adding
     entries at it (`:5061`), so lore can't pass it.
   - **The books** are the global, character, chat and persona books,
     `getSortedEntries()` (`world-info.js:4590`), the same set the scan walks.
     Disabled entries don't count. An entry with `ignoreBudget` (`:5669`) is added
     on top, since the budget doesn't hold it.
   - **No lorebook, no reserve.** Esin gets about 5,000 (its whole book). Akane's
     book is far bigger than the budget, so it gets 5,760.

5. **Raw window:** the heaviest run of 19 consecutive visible messages in the
   chat.
   - **19** is `RAW_WINDOW + STEP − 1`: the most the window holds before a step
     (`pipeline/scheduler.js`).
   - **"The heaviest run the chat has had"** needs no guess about how long
     messages are. Across the whole chat, it can only rise as the chat grows, so it
     changes when a heavier run is written and at no other time. A deletion or a
     branch can lower it, which raises the cap, and that costs nothing.
   - **Hidden messages don't count**, as ST leaves them out (`coreChat`,
     `script.js:4496`). Each message is counted once and cached by its hash. ST
     already counts every message on every generation (`:4920`), so its own cache
     is warm.
   - **Known over-reserve:** a long greeting stays in the heaviest run until 19
     messages have passed it, and in the whole-chat maximum after that. Worth
     changing only if a run shows it.

6. **World state:** its bound, about 330 tokens (D-0043), while World state is on
   and no WTracker is loaded. 0 otherwise. It's the bound because the state's size
   changes every reply, and the cap must not.

7. **Margin: 5% of the max prompt** (1,152 on Esin).
   - It covers the instruct wrappers (about 10 tokens a message, so ~190 for the
     window), the story string's wording, ST's token padding (64), other
     extensions' injections, and the gap between ST's tokenizer and the model's.
   - **5% matches `prompt_near_limit`** (`util/context-size.js`). With every other
     reserve at its upper bound, a prompt at its fullest lands under that line.
     So **`prompt_near_limit` firing means a reserve missed something**, and the
     warning becomes a check.
   - Lore, window and state are all upper bounds already, so 5% is cautious. The
     run's peak prompts say whether to tighten it (§5).

8. **The cap changes only when an input does, and a change costs at most one
   rebuild.** It's worked out every turn, but its inputs are static between
   events:

   | Event | Cap | Cost |
   |---|---|---|
   | An ordinary turn | unchanged | none |
   | A heavier 19-message run is written | falls | a rebuild only if the block is over the new cap |
   | A card, book or World Info budget edit | either way | same |
   | Response length or context size changed | either way | same (as today, D-0038) |
   | A deletion or branch lowers the heaviest run | rises | none: the block has more room to grow |
   | A reload | unchanged | none beyond the first-turn rebuild every reload already pays |
   | World state switched on or off | ±330 | same as an edit |

   - **A rise never re-admits evicted summaries.** The budget's mark stays forward-only
     (D-0026, D-0028).
   - **The P6 gate from §13 still holds:** a trace must show the cap holding still
     between these events. If it can't, D-0038's fixed share stands.

---

## 1. On Esin

| | Corpus chat | P3 branch |
|---|---|---|
| Max prompt | 23,040 | 23,040 |
| Card | 4,500 | 4,500 |
| Lore (whole book, under the 5,760 budget) | ~5,000 | ~5,000 |
| Heaviest 19-message run | 7,968 | ~8,450 |
| World state bound | 330 | 330 |
| Margin (5%) | 1,152 | 1,152 |
| **Room** | **~4,090** | **~3,600** |
| 35% share | 8,063 | 8,063 |
| **Cap** | **~4,090** | **~3,600** |
| Floor (half) | ~2,040 | ~1,800 |

- **About half today's cap.** At ~106 tokens a summary, the block holds 33–38
  summaries, and a rebuild keeps 17–19.
- **Rebuilds come about every 2 steps** (20 messages) instead of about every 4. The
  slack (~1,800–2,040) still holds a step (~1,060), so `recoupled` stays false, but
  only just.
- **The first turn after updating** the branch finds a ~6,000–7,000-token block over
  a ~3,600 cap and rebuilds to the floor. That turn is a reload, which rebuilds
  anyway, but it keeps only the newest 17 or so summaries and drops 45–55 more, so
  the block starts somewhere around message 80.
- **This is the honest cost of a 24k context with a 9k card and lore.** Today the
  same space is taken silently from the examples and the oldest raw messages.
  P4's compaction is what gives the dropped summaries somewhere to go.

---

## 2. Where it lives

- **`pipeline/budgeter.js`:** `memoryCap(maxPrompt)` becomes
  `deriveCap({maxPrompt, card, lore, window, state})`. Pure arithmetic. It returns
  the cap, the share, the room, the parts, and `limitedBy`: `share`, `room` or
  `starved`. `CAP_FRACTION` stays as the ceiling, with `MARGIN_FRACTION` (0.05) and
  `MIN_CAP_FRACTION` (0.10) beside it.
- **`prompt/reserves.js` (new):** reads the card fields, the books and the World
  Info budget, and counts the messages. The pure parts (`heaviestRun`,
  `loreReserve`, `cardText`) take plain inputs and are tested alone.
  - `getSortedEntries`, `world_info_budget` and `world_info_budget_cap` aren't on
    `getContext()`. They come from a dynamic import of `/scripts/world-info.js`, the
    way `util/context-size.js` imports `getMaxPromptTokens`. The budget settings
    are live `let` exports, so they're read at the point of use (D-0016).
  - **If any read fails**, the cap falls back to today's 35% share with
    `limitedBy: 'unknown'`, and one warning goes to the console. Cairn never breaks
    the chat (CLAUDE.md §4.17).
- **`prompt/assembler.js`:** calls the reserves in place of `memoryCap`. The
  budgeter's `fit` and the see-saw are unchanged.
- **No store change**, so no schema bump and no migration.

## 3. What the inspector and the log show

- **Log fields `budget_*`:** `share`, `room`, `limited_by`, `card`, `lore`,
  `lore_bound` (`budget`, `books` or `none`), `window`, `state` and `margin`.
  `memory_cap` stays as the cap in use.
- **`budget_window_now`:** the tokens in this turn's raw window, counted from the
  same per-message cache. It's for the check below, not for the plan.
- **The check, done when the run is read, not in the plan:**
  `prompt_tokens − memory_tokens − state_tokens` against
  `budget_card + lore in the prompt + budget_window_now`. The difference is what
  the margin actually had to cover.
- **The inspector's memory section** shows the cap as "35% of the max prompt" or
  "what the chat leaves", with the four reserves beneath it, and says `starved` in
  words.

## 4. Tests that guard the invariants (CLAUDE.md §3.10)

| Invariant | Test |
|---|---|
| A function of the chat | The same chat and settings give the same cap. A fresh assembler on the same chat (a reload) gives the cap the old one had |
| Nothing measured feeds the plan | The observer's snapshots, fed garbage, don't change the cap (D-0033) |
| Ceiling and minimum | Random parts give a cap within 10–35% of the max prompt |
| The window only rises as the chat grows | Appending any message never lowers `heaviestRun`. Deleting one can |
| A lower cap costs at most one rebuild | Cap falls below the block → one eviction to the new floor. Cap falls but stays above it → the block is byte-identical |
| A higher cap costs nothing | Cap rises → the block is byte-identical, and evicted summaries stay out |
| Holds still between events | A simulated 200-message chat with corpus-sized messages: the cap changes only on turns where a heavier run is written, and eviction turns are counted against today's cap |
| Lore bound | No books → 0. Books under the budget → their total. Over → the budget. `world_info_budget_cap` applies. `ignoreBudget` entries are added on top. Disabled entries don't count |
| Degrade | A failed world-info import or a throwing `getCharacterCardFields` → the 35% share, `limitedBy: 'unknown'`, no throw |

**Mocks** (`test/mocks/sillytavern.js`, `world-info.js`): the `getCharacterCardFields`
return shape (`script.js:3476-3494`), `getSortedEntries` entries with `disable` and
`ignoreBudget` (`world-info.js:5669`), and the budget settings (`:73`, `:81`).
Message sizes follow the corpus: a median of 266–338 tokens, heaviest runs of
5,970–7,968.

## 5. Cutover, and what we measure

**For the user:**
1. Update. There's no new setting.
2. On the P3 branch, play 25–30 turns with real-length user messages (Impersonate is
   fine), covering at least 3 steps and 1 eviction. Include one reload mid-run.

**Measure:**
- **The cap holds still.** `memory_cap` changes only on the turns §8's table names.
  Count the changes.
- **No overflow.** `prompt_near_limit` never fires, and the turn before each step
  stays at or under 95% of the max prompt. Record the peak.
- **The margin.** The check in §3, on each turn before a step. If the prompt at its
  fullest sits well under 95% throughout, the margin or a reserve can come down.
- **Rebuilds.** Steps between evictions (predicted: about 2), and `recoupled` stays
  false.
- **Reload.** The first turn after the reload has the same cap as the turn before it.
- **Stability.** Held turns and step turns as in D-0049. An eviction turn breaks at
  the block's head, as a first turn does.

## Build order

1. `budgeter.js`: `deriveCap` and its constants. Property tests for the ceiling and
   minimum.
2. `reserves.js` pure parts: `heaviestRun`, `loreReserve`, `cardText`, with tests.
3. `reserves.js` ST glue: the world-info import, card fields, message-count cache,
   the fallback. Mocks with citations.
4. The assembler uses it. The simulation test. The report and the `budget_*` log
   fields.
5. The inspector's memory section.
6. The run (§5), decision entries, `DESIGN.md` §13 (P6 as built), `how-it-works.md`
   ("Planning the memory block"), `st-api-surface.md` rows, CHANGELOG.

**New `st-api-surface.md` rows:** `getCharacterCardFields` (`st-context.js:232`,
`script.js:3476`), the system prompt choice (`script.js:5366`), `getSortedEntries`
(`world-info.js:4590`), `world_info_budget` / `world_info_budget_cap` (`:73`, `:81`),
the budget calculation (`:4736`) and its stop (`:5061`), `ignoreBudget` (`:5669`),
history then examples filling to the limit (`script.js:4920`, `:4960`).

## Not in P6

- Changing `RAW_WINDOW`, `STEP` or the half-cap floor. The run's rebuild count is the
  evidence if they need it
- Raising the ceiling above 35%
- Measuring the prompt to adjust the cap, or storing anything in `chatMetadata`
- Counting other extensions' injections one by one
- Chat completion's prompt manager parts. Text completion is the primary path
  (D-0010). On chat completion the same card and lore reserves apply, and the margin
  covers the rest
- Compaction (P4)
- Group chats
