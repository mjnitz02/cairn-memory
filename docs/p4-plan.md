# P4 plan — canon, and somewhere for the dropped summaries to go

**Status: CLOSED, 2026-09-18** (`docs/decisions.md` D-0060). Built, run, and closed on mechanics.
This page is kept as the record of what was planned; **where it disagrees with D-0059 and D-0060,
they win.**

**Read this before the rest of the page.** Three of its predictions did not survive the run:

- **§1's table is wrong by an order of magnitude on canon.** It gives a cap of ~3,600, a canon
  cap of 720 and room for ~45 facts. The run measured 2,304, **72, and 5**. Esin on a 24k context
  is `starved` — the cap pinned to its 10% floor — and `canonCap` was **guard**-bound from the
  seventh generation on, so decision 5's 20% share never applied once.
- **Rebuilds came every step, not every ~1.4.** `sceneCap − floor` cleared `stepTokens` by six
  tokens; `recoupled` is false and very nearly meaningless at that margin.
- **"Canon fills on a long chat" was right for the wrong reason.** `canon_full` was true from
  generation 12 holding 7 facts, because the room shrank, not because facts piled up. Canon's
  room *falls* as a chat grows, so §5's deferred fill-rate measurement is unreachable by
  construction — see D-0061 on sizing a run.

**Still open:** §5's narrow quality read. Seven promoted facts are on the branch, unread.

The decisions below are logged as D-0055 to D-0058, corrected by D-0059 and closed by D-0060.

**Three things the build settled that this page left open.**

1. **A falling cap trims canon from the newest end**, on a rebuild turn only (D-0056). The page
   assumed a pass never promotes past the cap, which is true — but P6's cap *moves*, so admitted
   canon can exceed its share after the fact. Dropping from the newest end leaves the bytes above
   untouched, and it is what makes `sceneCap ≥ 2 × stepTokens` an invariant rather than a
   near-certainty.
2. **The assembler works out the pending pass and the summarizer reads it** through a getter, the
   way the observer already reads `latest`. Every number `pendingCompaction` needs is that turn's
   budget, so deriving it anywhere else would be a second copy of the cap arithmetic.
3. **The summarizer split** into `summarizer.js` (queue, transport, failure policy),
   `state-job.js` and `canon-job.js` (D-0058). It was 473 lines before the third kind.

P4 is the phase that fixes symptom B (`DESIGN.md` §1): memory that grows without bound and
still develops holes. Today a rebuild drops the oldest summaries out of the prompt and nothing
carries their content forward. P4 asks the memory model, one step before each rebuild, what in
the summaries about to be dropped became **permanently true**, and keeps those one-liners in a
canon section at the head of the block.

Scope, settled before this plan was written:

- **Canon lives per-message**, on the model D-0045 proved, not in `chatMetadata`. This
  supersedes `DESIGN.md` §9.
- **Promote and drop, not merge.** `DESIGN.md` §8 declares three operations. Drop needs no new
  machinery — the budgeter already drops the oldest summaries, and the originals stay on their
  messages either way. Merge waits for evidence from the run that the block still loses things
  worth keeping after promotion.

The see-saw (`RAW_WINDOW` 10, `STEP` 10), the half-cap floor, the cap itself and the block's
placement are all unchanged. P4 closes on mechanics, with one narrow quality read (§5).

---

## What the evidence says

From the P3 run (D-0049), the P6 arithmetic (D-0052) and the corpus.

- **The cap is about 3,600 on the P3 branch, 4,090 on the corpus chat** — about half what
  D-0038 gave it. At ~106 tokens a summary the block holds 33–38 and a rebuild keeps 17–19.
- **A rebuild now drops ~17 summaries**, about every 2 steps instead of about every 4. Under
  D-0038 the same chat only ever evicted on the first turn after a reload; under P6 eviction
  becomes the ordinary event. That is the pressure P4 was always meant to answer, and the
  reason P6 came first (D-0051).
- **Nothing is destroyed today.** An evicted summary stays on its message in
  `extra.cairn.scene` and its message stays blanked from the history. So compaction decides
  only what is *in the prompt*, and §8's "reversible because the source is archived" is already
  true without tier 4. P4 needs no episode store.
- **Summaries, not messages, are what a pass reads.** That inherits their loss, which is the
  honest cost of compacting a compressed transcript. It is also §8's own input shape.

---

## Decisions

1. **A canon batch is stored on the newest message it read** — `extra.cairn.canon`, the shape
   D-0045 proved for state.

   ```
   message[j].extra.cairn = { v: 3, scene: {…}, canon: {
     facts:   [{ text, entities }],
     covers:  [i, j],          // the summaries this pass read
     prompt:  "<hash of the prompt used>",
     at:      "<ISO>"
   }}
   ```

   - **The canon set is a scan and a fold**, oldest first, read fresh every turn. Nothing
     records which batch is current, so branches, swipes and deletions roll back with no code.
   - **`j` is an old message** — the newest summary the pass read, which is behind the raw
     window by construction. A batch is therefore written where swipes never reach, and a
     rollback past `j` correctly unmakes facts about events that had not happened.
   - **Why this supersedes `DESIGN.md` §9.** §9 puts canon in `chatMetadata` with checkpoints
     keyed to message index, and calls that "the single most likely source of quiet wrongness
     in the whole system". Per-message storage removes the checkpoint, the rollback code and
     the event wiring, and `index.js` gains nothing (CLAUDE.md §1.1). The one thing §9's shape
     buys — surviving a swipe on the batch's own message — is a case that cannot arise.
   - **Store v3**, with a migration (`canon` absent from a v2 store, so a v2 store is already a
     v3 one) and a v2 fixture kept in the suite (CLAUDE.md §8.32).

2. **A canon fact is not hashed against anything.** A scene and a state are caches of text and
   go stale when it is edited. A canon fact is a statement that something *happened*; editing
   the message afterwards does not unmake it. So a batch counts while it is present and
   well-formed, and no edit invalidates it.
   - **The cost, stated plainly:** a wrong fact is permanent for that branch. P4 gives no
     control to remove one — the lever is the same one the world state has, which is none. It
     is why §5 reads the promoted facts rather than only counting them.

3. **Canon enters the block only on a turn the block rebuilds.** This is D-0019 applied a
   second time.
   - Canon sits at the block's **head**, above the scene summaries (`DESIGN.md` §6 —
     volatility: rarely). Appending a fact therefore changes bytes above every summary, which
     would break the whole block on an ordinary turn.
   - But a compaction pass fires one step *before* the rebuild that drops its summaries, and a
     rebuild changes the block's head anyway. So the assembler holds a new batch back until the
     turn eviction fires, and the two head-changes land together and cost one break instead of
     two.
   - The admitted mark advances only on a rebuild turn and only forward, like `budget.oldest`.
     The first turn of a session is a rebuild, so a reload admits everything.
   - **Between rebuilds the canon text is byte-identical**, which also keeps the scene budget
     still (decision 5).

4. **No canon, no section.** The block renders exactly today's bytes until a chat has a batch:

   ```
   [Established facts]:
   * Her brother is dead.
   * They kissed at the lighthouse.

   [Following is a list of recent events]:
   * …
   ```

   Today's template and separator are qvink's verbatim (D-0040), and stay so. A byte-identical
   render for a chat with no canon is a test, not a hope.

5. **Canon's share of the cap is bounded, and the bound is derived, not a setting.**

   ```
   canonCap = min(CANON_FRACTION × cap,  cap − 2 × stepTokens)
   sceneCap = cap − canonTokens
   floor    = sceneCap / 2
   ```

   - **`CANON_FRACTION` is 0.20.** On Esin that is ~720 tokens, about 45 one-liners, against a
     block that holds 34 summaries. Conservative on purpose: the run's numbers are the evidence
     for moving it.
   - **The second term is the guard.** `recoupled()` says growth and eviction have collapsed
     into one cadence when the slack a rebuild buys cannot hold a step. Canon takes room from
     the scene budget, so it can cause exactly that. Reserving at least two steps of scene
     budget makes it arithmetically impossible: canon is squeezed to nothing before the see-saw
     recouples. A starved chat (D-0052) gets no canon at all, which is the right order of
     sacrifice.
   - **What it costs on Esin:** with canon full, the scene budget falls from 3,600 to 2,880 and
     rebuilds come about every 1.4 steps instead of about every 1.7 — roughly every 14 messages
     instead of 17. More passes, each cheap (§4).

6. **A pass is due under budget pressure, and its input is exactly what the next rebuild would
   evict.** Both are derived from the chat; nothing is stored about what has run.

   - **Pressure:** `sceneTokens + stepTokens > sceneCap` — one step before the overflow, so the
     pass has ~10 messages of wall-clock to finish.
   - **Its input:** simulate the budgeter's own drop-to-floor and take the summaries it would
     drop, plus the current canon so the pass does not repeat itself.
   - **Once per cycle, without a flag:** a pass is due only when the evict-set's newest index is
     past the newest `covers[1]` already in the chat. Pressure holding for ten turns yields one
     pass.
   - **Minimum of 3 summaries** in the evict-set, or the call is not worth making.
   - **No room, no call.** When canon is at `canonCap` the pass does not run at all, the log
     says `canon_full`, and the block keeps the facts it has. Making room — merging canon lines
     or moving the oldest to episodes — is P5's, with the run as its evidence.

7. **One structured call, through the existing transport.** `summarizer.js` stays the only file
   that calls a model (D-0037). Compaction is a third job kind, and the lowest priority: state
   first because the next prompt uses it (D-0044), then summaries because a missing one holds
   the step (D-0037), then compaction, which has a whole step of slack.

   ```
   input:  the summaries the next rebuild will evict + the canon as it stands + how many
           facts there is room for
   output: { "promote": [ { "fact": "…", "entities": ["…"] } ] }
   ```

   - **Prompt shape** follows `DESIGN.md` §12: an `IMPORTANT:` line, concrete include and
     exclude examples, a tiebreaker at the end. Built in, not a setting — it is tied to the
     parser, as the state prompt is (D-0044).
   - **What it is told to promote:** what stays true after the scene ends. Deaths, kinships,
     promises made, places learned, things permanently broken or given. **What it is told to
     leave:** anything the world state already carries (location, weather, who is present, hair,
     outfit — D-0043), anything the raw window still holds, mood, and plot the roleplay model
     should be free to steer (D-0043's reasoning applies here too, and more strongly: canon is
     permanent).
   - **Caps, enforced by the parser, and stated in the prompt:** at most the room allows and
     never more than 8 facts a pass, 160 characters a fact, 4 entities a fact, 32 characters an
     entity. **A fact over its cap is dropped, not cut**, as a state value is.
   - **Dedup on normalised text** against the canon already stored; a repeat is dropped and
     counted, not written.
   - **`entities` is stored and not read.** `store/entity-index.js` is a named interface
     boundary (`DESIGN.md` §11), the model gives the tags for free, and adding the field later
     would cost a store version and a migration. Strike it if you would rather P5 pay that.

8. **A failed pass changes nothing.** It writes no batch, toasts once per streak of its kind,
   and eviction proceeds exactly as it does today. Nothing reaches ST's generate path
   (CLAUDE.md §4.17). The tally counts passes, facts written, duplicates refused and facts
   dropped over their cap, so what the panel reports is the applied change (§4.18).

9. **No pass while the handover gate is shut.** `assessCompaction` joins `gates.js` beside the
   other two. While qvink is injecting, Cairn is measuring and nothing more (D-0020, D-0027),
   and a canon section would break the byte-for-byte comparison the gate turns on.

10. **One new setting — "Keep canon"** — mirroring "Keep the world state": default on, inert
    without a memory profile, and one plain sentence in `settings.html` (§4.16). It earns its
    place as the run's control, the way `worldState` did for D-0049.
    **This is the one knob in P4; strike it if you would rather canon simply be part of the
    block and "Write the memory block" be the only lever.**

---

## 1. On Esin, after P6

| | P3 branch |
|---|---|
| Cap (P6, D-0052) | ~3,600 |
| `CANON_FRACTION` × cap | 720 |
| Recoupling guard (`cap − 2 × stepTokens`) | ~1,480 |
| **Canon cap** | **720** — about 45 facts |
| Scene budget, canon empty → full | 3,600 → 2,880 |
| Floor | 1,800 → 1,440 |
| Slack against a ~1,060-token step | 1,800 → 1,440, `recoupled` false |
| Rebuilds | every ~1.7 steps → every ~1.4 steps |
| Summaries a pass reads | ~17 |

**Per pass:** ~1,800 tokens of summaries + up to 720 of canon + ~250 of prompt ≈ 2,800 in,
~100 out, once every ~14 messages. About twice a summary call (D-0041's ~1,200 in) at a
fourteenth of the frequency.

**Canon fills on a long chat.** ~43 passes over Esin's length at 2–4 facts each is 86–172
facts against room for 45. The 25–40 turn run will not reach it (§5 expects ~2 passes, ~6
facts), so P4 ships the ceiling, reports it, and leaves making room to P5. That is the known
limit, named rather than discovered.

---

## 2. Where it lives

- **`store/chat-store.js`:** `readCanon(message)` / `writeCanon(chat, j, batch)`, alongside the
  scene and state pairs and through the same `writeKey` envelope. `STORE_VERSION` 3 with a
  migration from 2.
- **`memory/canon.js` (new, tier 3):** `canonFor(chat)` — the scan and fold, oldest first —
  plus `canonRoom`, the dedup and the normaliser. Pure: plain data in, plain data out.
- **`memory/canon-strategy.js` (new):** the prompt and the parser, the same boundary
  `scene-strategy.js` and `state-strategy.js` sit on. Reuses `model-reply.js` for
  `stripThinking`, `unfence` and `looksLikeRefusal`.
- **`pipeline/compactor.js` (new):** `pendingCompaction({scenes, canon, sceneCap, floor,
  stepTokens})` — pressure, the evict-set simulation, the once-per-cycle test, the minimum —
  and `applyPass`. Pure. `DESIGN.md` §11 names this file.
- **`pipeline/budgeter.js`:** `canonCap({cap, stepTokens})` beside `deriveCap`, with
  `CANON_FRACTION`. `fit` takes `sceneCap` where it takes `cap` today; the floor follows it.
- **`pipeline/gates.js`:** `assessCompaction`.
- **`pipeline/summarizer.js`:** the third job kind and its tally, lowest priority.
- **`prompt/assembler.js`:** counts the admitted canon, passes `sceneCap` to `fit`, renders the
  canon section at the head, advances the admitted mark on a rebuild turn, and reports the
  `canon_*` fields.
- **`ui/canon-section.js` (new):** a collapsed **Established facts** section under the message
  that carries a batch, the way `state-section.js` draws the world state (D-0050), so the chat
  shows what the prompt carries.
- **`index.js` unchanged.** No new events, no new hooks.
- **No new `st-api-surface.md` rows.** P4 calls no ST API P3 did not.

## 3. What the inspector and the log show

- **Log fields:** `canon_facts`, `canon_tokens`, `canon_cap`, `canon_admitted` (the facts in
  this turn's block), `canon_full`, `canon_covers_through`, `scene_cap`, and per-pass
  `compaction_passes`, `compaction_promoted`, `compaction_duplicates`,
  `compaction_dropped_fields`, `compaction_failed`.
- **The check the run reads:** `canon_admitted` changes only on turns where `evicted > 0` or
  the step reason is `first-turn`. Any other turn where it moves is decision 3 failing.
- **The inspector's memory section** gains a canon line: how many facts, what they cost, how
  much room is left, and `canon_full` in words. The summaries section gains the pass tally,
  the way it carries the summary and state tallies today.

## 4. Tests that guard the invariants (CLAUDE.md §3.10)

| Invariant | Test |
|---|---|
| No canon, no change | A chat with no batch renders byte-identically to today's block |
| Canon enters only on a rebuild | A batch written between rebuilds leaves the block byte-identical; the rebuild turn admits it |
| The admitted mark is monotonic | It never falls within a session; a reload admits everything |
| Branch and swipe roll back | Truncating the chat past a batch's message removes its facts, with no rollback code called |
| An edit does not unmake a fact | Rewriting a covered message leaves the batch valid (decision 2) |
| Canon never recouples the see-saw | Property test over random caps and step sizes: `sceneCap ≥ 2 × stepTokens`, or canon is 0 |
| Canon is bounded | Canon tokens never exceed `canonCap`; at the cap no pass is due and no call is made |
| A pass reads what the rebuild drops | The evict-set simulation equals the set `budget.fit` drops on the next rebuild |
| One pass per cycle | Pressure holding for ten turns yields one pass; the next is due only past the newest `covers[1]` |
| Store v3 | A v2 and a v1 fixture read; a v3 store round-trips; a future store is refused, not overwritten |
| The parser against mess (§3.12) | Fenced JSON, preamble chatter, truncation mid-array, a refusal, a fact over 160 characters, an unknown key, `{"promote": null}`, a duplicate |
| Degrade | A failed or refused pass writes nothing, eviction is unchanged, one toast per streak |
| Gates | No pass while the handover gate is shut, with no memory profile, in a group chat, or with the setting off |

**Mocks:** `test/mocks/llm.js` gains plausible pass replies, including the bad kinds.
Fixtures stay synthetic in content and real in shape (§3.13): a canon batch's shape is
invented here, so the first run's log is what confirms it.

## 5. Cutover, and what we measure

**P6's run has closed** (`docs/decisions.md` D-0054), and P4 is built and green on `make check`.

**For the user:**
1. Update. **Keep canon** is on by default.
2. On the P3 branch, play 30–40 turns, enough to cover at least 2 rebuilds and therefore 2
   passes, with one reload mid-run.

**Measure:**
- **Passes.** One per cycle, none while a gate is shut, none when there was no pressure.
- **Promotions.** Facts written, duplicates refused, facts dropped over their cap, failures.
- **Canon moves only on rebuild turns.** Count the turns `canon_admitted` changed against the
  turns `evicted > 0`. They must be the same turns.
- **Stability.** Held turns against D-0049's 95.9% with the state on. A rebuild turn still
  breaks at the block's head and only there — canon must not add a second break.
- **Cadence.** Steps between rebuilds (predicted ~1.4), and `recoupled` stays false.
- **No overflow.** `prompt_near_limit` silent, and the turn before each step at or under 95%.
- **One quality read, and it is narrow.** Read the promoted facts. Are they durable facts
  rather than plot, mood or something the world state already carries? Is any of them *wrong*?
  This is not the deferred summary-quality test (D-0041, D-0049) — it is here because a wrong
  fact is permanent and P4 gives no way to remove one.

**The gate.** If canon moves on turns decision 3 does not name, or the promoted facts read as
plot rather than fact, P4 stops here rather than proceeding on faith (CLAUDE.md §7.29).

## Build order

1. `chat-store.js`: `readCanon` / `writeCanon`, `STORE_VERSION` 3, the migration, the v3
   fixture beside the v1 and v2 ones.
2. `canon.js`: the fold, the room, the dedup, with tests.
3. `canon-strategy.js`: the prompt and the parser, tested against mess before the caller exists
   (the lesson in `decisions.md` about "first `{` to last `}`").
4. `budgeter.js`: `canonCap` and the scene budget. Property tests for the guard.
5. `compactor.js`: pressure, the evict-set, once-per-cycle, the minimum.
6. `gates.js` + `summarizer.js`: the third job kind, its tally and its failure behaviour.
7. `assembler.js`: the canon section, the admission rule, `sceneCap`, the `canon_*` fields.
   The byte-identical tests.
8. `inspector.js`, `canon-section.js`, `settings.html`.
9. The run (§5), then `decisions.md` (a new entry per settled decision above, including the one
   that supersedes `DESIGN.md` §9), `DESIGN.md` §13 P4 as built and §9 corrected, `how-it-works.md`
   ("Compaction" and "Storage and branching" rewritten), `CHANGELOG.md` at **0.10.0**.

## Not in P4

- **Merge.** `DESIGN.md` §8's second operation. It needs a record that supersedes the scenes it
  covers, which changes `readScenes`, the renderer and the blanking logic. The run's numbers
  say whether promotion alone leaves enough behind to be worth it.
- **Making room when canon is full.** Merging canon lines, or moving the oldest facts to
  episodes. P5, with this run's fill rate as its evidence.
- **Episodes and the entity index** (tier 4, P5). `entities` is stored and unread.
- **Editing or removing a canon fact from the UI.** D-0050's pattern makes this a small,
  separate change once the shape is proven.
- **Promoting from the messages rather than the summaries.** More faithful, several times the
  tokens. Only if the quality read in §5 says the summaries lost what mattered.
- **Changing `RAW_WINDOW`, `STEP`, the floor, the 35% ceiling or the block's placement.**
- **Canon in a lorebook.** `DESIGN.md` §5 calls this canon's long-term home. It is a separate
  decision and a separate measurement.
- **Group chats.**
