# P3 plan — Cairn keeps the world state

**Status: in progress, 2026-09-16.** Build steps 1–4 are built. As each part lands, its
decisions move into `decisions.md` and its mechanism into `how-it-works.md`, and
this page is deleted when P3 closes.

P3 adds Tier 1 (`DESIGN.md` §5): a small, structured record of what is true right
now, rewritten as a diff after each reply, stored on the message it was brought up
to date with, and placed in the prompt just below that message. It replaces
WTrackerLite. The memory block, the see-saw and the summary queue keep working as
P2 left them. P3 closes on mechanics, not quality (D-0041).

---

## What WTrackerLite does

Matt's fork, 0.2.0 (`~/workspaces/SillyTavern-WTrackerLite`, its `src/`). Cited as
`WTL file:line`.

**Take:**
- **State on the message.** `extra.WTrackerLite.value`, written straight onto the
  message it was generated for (`WTL index.tsx:272-274`). `DESIGN.md` §2 already
  names this as the idea to keep.
- **Update after the reply.** Auto mode runs on `CHARACTER_MESSAGE_RENDERED`
  (`WTL index.tsx:361-365`). Esin's 9 trackers are all on character replies, one per
  exchange, so Matt's habit is a state that includes the latest reply.
- **The previous state as input.** It sends the last tracker back with each
  request (`includeLastXWTrackerLiteMessages: 1`, `WTL config.ts:158`).
- **Labelled lines in the prompt, not JSON** (`formatTrackerForContext`,
  `WTL index.tsx:72-93`).
- **The fields Matt used** (see the corpus, below).

**Leave:**
- **It regenerates the whole state from the whole chat.** `includeLastXMessages`
  defaults to 0, which means every message (`WTL config.ts:157`, `index.tsx:235`).
  There's no diff, and the cost grows with the chat.
- **Splicing a fake user message into the interceptor's array**
  (`WTL index.tsx:120`). The inspector can't attribute it (`how-it-works.md`, "What
  it cannot see"), and a user role for scene notes misleads the model. Cairn parks
  an injection like every other writer.
- **A user-edited JSON schema and a Handlebars HTML template**, with the template
  copied into every message's `extra` (`WTL index.tsx:275`, 1,274 characters per
  message in Esin). Handlebars is deprecated for extensions (`st-context.js:177`).
- **Parsing that trusts the model.** It strips a fence and calls `JSON.parse`, with
  no schema check (`WTL parser.ts:1-13`). A missing field or wrong type is stored as is.
- **Fire-and-forget requests.** They run in parallel with no abort on chat change,
  a toast on every request (`WTL index.tsx:256`), and data *deleted from the chat*
  when its template fails to render on load (`WTL index.tsx:371-389`).

## What the corpus shows

Shapes and sizes only. Read from `~/workspaces/cairn-corpus`, never written.

- **Esin has `extra.WTrackerLite`** on 9 of 85 messages (indexes 68–84), all character
  replies, one every 2 messages. `chat_metadata.WTrackerLite` is `{schemaKey}`. The
  value is `{location, weather, charactersPresent[], characters[{name, hair, outfit}]}`:
  308–570 characters of JSON (median 469), 2–3 characters present.
- **Elizabeth and Risa have upstream `extra.WTracker`**, with the same envelope
  (`{value, html}`). Elizabeth: 60 of 123 messages, 59 of them on user messages, one
  per exchange, same four fields. JSON is 279–859 characters, with 1–5 characters
  present. Risa: 10 of 127 messages, at irregular gaps, with a richer schema
  (`time`, `topics{primaryTopic, emotionalTone, interactionTheme}`, and per character
  `makeup`, `stateOfDress` and `postureAndInteraction`). JSON is 868–1,274 characters.
- **No swipes are stored.** No `swipe_info` entry carries tracker data, and no
  message has more than one swipe.
- **How often state changes.** Across consecutive tracked exchanges, the whole value
  was identical in 23 of Elizabeth's 59, 1 of Esin's 8 and 0 of Risa's 9. Some
  changes were rewordings rather than news: Elizabeth's weather changed 10 times,
  and 7 of those were ≥ 0.85 similar to the old string. Location changed 30 times,
  9 of them ≥ 0.85 similar. Esin's and Risa's changes were all < 0.85 similar.
- **Message sizes** (from `extra.token_count`, the chat model's tokenizer), median:
  user 254 / 336 / 246 tokens and reply 289 / 339 / 350 for Elizabeth / Esin / Risa.
  One exchange is about 600–700 tokens. Esin's live chat has since become
  "continue"-only, so its user messages there are about 2 tokens.

---

## Decisions

1. **Place the state `IN_CHAT`, directly after the newest message it has read.**
   In normal play that's depth 1: between the reply the state includes and the
   user's new message. This supersedes `DESIGN.md` §6's depth 2.
   - **Why the depth matters more than the change rate.** ST inserts an `IN_CHAT`
     prompt *depth* messages from the end (`doChatInject`, `script.js:5628`,
     `:5665-5666`). Next turn, two messages go in below it, so the old position no
     longer matches, even if the state didn't change. So an in-chat state costs a
     re-read every turn: the state itself plus every message that was below it.
     Whether the text changed doesn't matter.
   - **Cost on D-0034's layout.** Held turns are at about 97% on a prompt of about
     17,000 tokens (15,666–17,762). The step turn breaks at the block's tail, above
     all of these, so it stays at about 67% whichever option is chosen. The figures
     use corpus sizes: user message U ≈ 300 tokens, reply R ≈ 320, state S ≈ 80
     (decision 4's typical two-character state).

     | Placement | Extra re-read per turn | Held turn | Cycle mean (4 held + 1 step) |
     |---|---|---|---|
     | Today, no state | — | ~97% | ~91% (D-0041) |
     | `IN_PROMPT` after the block | 0 if unchanged. A change re-reads from the block's tail, like a step | ~71–79%* | ~70–77% |
     | `IN_CHAT` depth 2 (§6) | R + U + S ≈ 700 (4.1%) | ~93% | ~87.5% |
     | **`IN_CHAT` depth 1 (recommended)** | U + S ≈ 380 (2.2%) | ~95% | ~89% |
     | `IN_CHAT` depth 0 | S ≈ 80 (0.5%) | ~96.5% | ~90.5% |

     \* The state changed in 7 of Esin's 8 exchanges and 36 of Elizabeth's 59.
   - **Why not depth 0.** It's the cheapest, but the state would sit below the
     user's newest message, which it hasn't read. A user message that moves the
     scene would be contradicted just before the reply. Depth 0 is also where §6
     puts per-turn retrieval (P5).
   - **Why not depth 2.** It costs one more reply per turn, and it only lines up in
     time if the state is a reply behind.
   - **"After the newest message read", not a fixed depth.** That's depth 1 in
     normal play. On a swipe, ST drops the last message from the prompt
     (`script.js:4498`), so the state before it is used, still at depth 1. When the
     queue falls behind, the depth grows, and the state stays in the right order.
     Over a run, this costs about the same as a fixed depth.
   - **On Esin**, user messages are about 2 tokens, so depth 1 will measure like
     depth 0 there. The real-chat figure above is a prediction (§8).

2. **The state includes the latest reply.** The queue brings it up to date through
   the newest message, including the last one, which P2's summaries never touch.
   - **Why.** The state tier exists to be current, and the reply the user answers is
     where the scene moved. WTrackerLite already worked this way (above). It also
     saves one reply of re-read per turn (decision 1).
   - **Cost.** A swipe, continue or edit of the reply wastes one call (D-0037:
     105 calls cost $0.08). The hash check (decision 7) catches the change. A new
     swipe keeps the old `extra` and changes only `mes` (`script.js:6671-6684`), and
     a continue appends to `mes` (`:6701`).
   - **Free rollback.** Swiping away saves the current `extra` into that swipe
     (`script.js:10340` → `:6939`), and swiping back restores it (`:7015`). An old
     swipe's state comes back with it.

3. **One state update per reply.** It runs after the reply arrives, in the same run
   as the summaries, and reads every message since the last state (normally 2).
   - **Why not every N replies.** Under decision 1, cadence doesn't change the
     cache cost: the placement costs the same every turn. Updating every N would
     only save calls that cost almost nothing, and it would leave the state up to N
     replies behind. Both of Matt's auto-mode chats updated once per exchange.
   - **Load.** A real exchange becomes 3 calls (2 summaries and 1 state), about 21 s
     at D-0037's median of 6.9 s per call. Matt's median gap between turns is 12
     minutes, and p10 is 2.2 minutes.

4. **WTrackerLite's fields, and nothing else: the hard facts a description gets
   stuck on.** Capped by construction at about 330 tokens, and typically about 55.

   ```js
   {
     location: string,    // ≤ 120 chars  most specific place first
     weather: string,     // ≤ 80         or indoor conditions
     characters: {        // ≤ 5 entries, keyed by name (≤ 40), present characters only
       [name]: {
         hair: string,    // ≤ 80         hairstyle and its condition
         outfit: string,  // ≤ 120        the complete outfit, underwear included
       },
     },
   }
   ```
   - **What the tier is for** (Matt, from hundreds of roleplays). A card's
     description fixes facts like "wears a combat uniform". When the story changes
     them, the change is easily lost, because summaries leave it out, and ten
     messages later the character is "wiping sweat off their combat uniform" in
     the gym. The state carries the latest hair and outfit forward until they
     change again. Location and who is present cement that, and weather has never
     caused trouble.
   - **Why nothing more.** Mood, time of day and scenario are dynamic. The card's
     Description and Personality already give a range of emotions the roleplay
     model expects to evolve, and no decent model reads five messages of trauma and
     writes a happy character. Extra fields gridlock the roleplay model. It
     "narrates the dictated lane", keeps characters frozen in a recorded mood, and
     won't move the time forward until the user does. The memory model would then
     be steering the story instead of the roleplay model telling it with the user.
     Upstream WTracker tracked all of that. Matt forked WTrackerLite from it to fix
     its bugs and cut the fields down to these.
   - **Revised 2026-09-16, before release.** The first draft had `time`, and per
     character `appearance`, `condition`, `mood` and `intent`, plus `threads`. Part
     of its case was Risa's upstream-WTracker schema, which is the evidence above
     discounts. A new field needs a stuck-hard-fact case from play, not a
     might-help one.
   - **Caps from the corpus.** WTrackerLite-shaped trackers (Esin, Elizabeth) peak
     at hair 60, outfit 109, location 81 and weather 69 characters. Only Risa's
     verbose upstream schema goes past a cap (hair 99, outfit 138), and that is the
     verbosity to avoid. The corpus peaks at 5 characters present.
   - **The bound.** The worst case renders to 1,754 characters, labels included,
     which is about 330 tokens at about 5.3 characters per token (the current block
     is 21,287 characters in 4,015 tokens). Two characters with typical values come
     to about 290 characters, about 55 tokens.
   - **Who is present renders as its own line**, as WTrackerLite's template did, so
     a character with nothing recorded yet still counts as there.
   - **The token bound sits outside the block's 35% cap** (D-0038). It's small and
     fixed, and `prompt_near_limit` still covers the whole prompt.

5. **Diffs are JSON Merge Patch** (RFC 7386) against the current state. The parser
   rejects what can't be read and drops only the fields that break the schema.
   - **The format.** Changed fields get new values, `null` clears a field or removes
     a character who left, and `{}` means no change.
     Characters are keyed by name, so a merge reaches the right one.
   - **Why a patch, not a full state.** Fields the reply leaves out keep their bytes,
     so rewording can't creep in. Elizabeth's regenerate-everything tracker reworded
     weather in 7 of its 10 changes. A reply of `{}` means *no change*, which the log
     needs. And a model that ignores the instruction and sends the whole state still
     merges correctly.
   - **Why JSON, unlike D-0037.** ST returns no finish reason
     (`custom-request.js:60`), and a cut-off JSON reply fails to parse. That is the
     check D-0037 gave up for plain text. §3.2 asks for structured state anyway.
   - **Why not an op list or `Field: value` lines.** Paths in an op list are one more
     thing to get wrong. Lines can't mark a cut-off reply, and they need an escape
     for clearing a field.
   - **Parser.**
     - **Cleanup:** strip `<think>` blocks as the summary parser does (shared,
       `memory/model-reply.js`). Take the first fenced block if there is one. The
       patch is the first bracketed span that parses as JSON, with brackets inside
       strings skipped, so braces in a preamble or sign-off can't swallow it.
     - **Rejects the whole reply** (writes nothing, counts as a failure): empty,
       a refusal, no JSON (`truncated` when a bracket is still open at the end),
       not an object.
     - **Drops one field and keeps the rest:** an unknown key, a wrong type, a value
       over its cap, a 6th character, or an unknown character sub-key. Key names
       match case-insensitively. Each drop is counted and logged as
       `state_dropped_fields`.
     - **No clamping or truncating** a value. What's stored is what the model wrote
       or nothing.
   - **Applied, not claimed** (CLAUDE.md §4.18). Cairn works out what changed by
     comparing the state before and after the merge, so a patch that sets a field
     to its current value records no change.

6. **The state prompt is built in, and there's one setting: World state on/off.**
   - **Why not editable.** The prompt is tied to the schema and the parser, so
     editing it can only break them. D-0039's reasons for making the summary prompt
     editable don't apply here: a prompt already proven in play, and pasting in a
     qvink prompt.
   - **Why a switch.** *"Keep track of the current scene and put it in the prompt."*
     It passes CLAUDE.md §4.15. It's also the control for measuring decision 1, as
     `holdWorldInfo` and `ownMemoryBlock` were in P1. On by default, and inert until
     a memory profile is chosen.

7. **Edits: each state hashes the messages it read. The newest valid state wins, and
   invalidation doesn't cascade.**
   - **The check.** D-0037's approach, widened from one message to the update's read
     range. A state stores how many messages it read, ending at its own message, and
     a hash of them as `name: mes`, skipping hidden ones. It counts only while that
     range still hashes the same. Editing, hiding, unhiding or deleting a message in
     the range, or swiping the state's own message, makes it stale.
   - **The newest valid state wins.** The reader walks back from the newest message
     in the prompt to the first valid state, and the queue brings the state forward
     from there.
   - **No cascade.** An edit to an older message invalidates only the state that
     read it. Later states were built on the old text and stay valid.
     - **Why:** the most common edit is to the newest reply, which is in the newest
       state's range. A cascade would redo every later state, one call each, over a
       story that has usually overwritten that fact since. State is overwritten by
       design (§5).
     - **Cost we accept:** a fact from an edited old message stays wrong until the
       story touches that field again.

8. **Read nothing from WTrackerLite, and don't inject state while WTracker or
   WTrackerLite is loaded.**
   - **Why not migrate.** Only Esin has the data, and its newest tracker is
     message 84. The live chat is now about 60 messages past that (the current log
     blanks 136). A state that old is the wrong seed, and the schema differs. A
     cold start from recent messages costs one call.
   - **Why the gate.** Two state writers in one prompt is the problem this project
     exists to end. The check asks whether either extension is loaded, not what
     its settings say (D-0040's lesson), under `third-party/SillyTavern-WTrackerLite`
     and `third-party/SillyTavern-WTracker`. Neither is installed (D-0014). The panel
     names the one it's waiting on.

---

## 1. What Cairn writes

On the newest message the update read, beside the scene:

```js
message.extra.cairn = {
    v: 2,                       // STORE_VERSION
    scene: { … },               // unchanged (D-0037)
    state: {
        value: { location, weather, characters: { [name]: { hair, outfit } } },
        read: 2,                // messages this update read, ending at this one (hidden ones skipped)
        hash: 'h:…',            // hash of those messages as `name: mes`, in order
        changed: ['location', 'characters.outfit'],  // kinds only, worked out by Cairn
        prompt: 'h:…',          // hash of the built-in prompt that wrote it
        at: '2026-…Z',
    },
}
```

- **A full snapshot on each message, not a chain of patches.** Each state stands
  alone, so a deletion, a branch (`bookmarks.js:173`) or a stale state in the middle
  never breaks the ones around it. The cost is about 1 KB per reply in the chat
  file, which is less than WTrackerLite's template copy alone.
- **`read` in place of an index.** Indexes shift when an earlier message is deleted,
  but a count ending at the state's own message doesn't.
- **`changed` holds kinds, not names**, so the log can report it without chat
  content.
- **Schema v2** (CLAUDE.md §8.32). The migration from v1 is a no-op, because v1 has
  no state. `test/fixtures/store-v1.js` stays as the old shape, and a `store-v2.js`
  literal is added. `writeScene` and `writeState` each keep the other's key.
  *Consequence:* a downgraded Cairn reads a v2 store as `future`
  (`store/chat-store.js`), so it stops reading its own summaries until upgraded.

## 2. The state call

`src/memory/state-strategy.js`, pure, with the same `build` / `parse` shape as
`perMessage`. It sits on the strategy boundary `DESIGN.md` §11 names.

**Input.**
- The current state as JSON (`{}` on a cold start).
- The messages to read, as `Name: text`, oldest first, at most 6.
- If there are more than 6 to read (a cold start, or catching up after the tier was
  off or failing), only the newest 6 are read. The 5 valid scenes before them go in
  as `Earlier events`, so a cold start on a long chat is still one call.
- ST macros are expanded on the template before chat text goes in, as D-0039 does.
- `maxTokens` is 2,048, as for summaries.
- Estimate: about 1,200 tokens in, 30–150 out.

**Prompt** (`STATE_PROMPT` in `state-strategy.js` is the source; `DESIGN.md` §12
structure: positive instructions, `IMPORTANT:`, an example, a tiebreaker). It
opens by saying what the record is for, and it gives each field's cap, taken from
the schema, because a value over its cap is dropped. Its instructions, with the
caps filled in:

```
You keep a short record of the hard facts of a roleplay scene: where it is, who
is in it, and what each character's hair and outfit are right now. Character
descriptions often fix these, so the record carries forward whatever the story
has since changed. […] Reply with a JSON merge patch that brings the record up to
the end of the messages.

IMPORTANT: Include only what the messages change. Leave every other field out of
the patch, so its wording stays exactly as it is.

Fields, with the most characters each value may use:
- location: where the scene is, most specific place first (120)
- weather: weather and temperature, or the conditions indoors (80)
- characters: the characters actually present in the scene, at most 5, keyed by name (40), each with:
  - hair: hairstyle and its condition (80)
  - outfit: the complete outfit, underwear included (120)

Patch rules:
- A changed field gets its new value. A field that no longer applies gets null.
- A character who leaves the scene gets null. A character who arrives gets an
  entry, with hair and outfit if the messages describe them.
- Values are short, plain phrases stating what the messages say. […]
- When nothing changed, reply {}.
```

**Rendering into the prompt** (`src/memory/state-schema.js`, pure). Fixed field
order. Characters keep insertion order, so a newcomer is appended. Empty fields are
omitted. The same state always renders to the same bytes.

```
[Current scene]
Time: …
Location: …
Weather: …
Present: Aster, Wren
Aster — hair: …; outfit: …
Wren — hair: …; outfit: …
```

## 3. When it runs

The summarizer stays the only file that calls a model (D-0037). It gets a second
kind of job, not a second queue.

- **Triggers:** `MESSAGE_RECEIVED` (`script.js:6781`, `:3799`, and `:6691` for a
  swipe) and `CHAT_CHANGED`, as now. `MESSAGE_EDITED` is new (`script.js:8405`):
  `updateMessage` has already written the new `mes` (`:8139`). So an edit no longer
  waits for the next reply, for summaries too. Still nothing on `MESSAGE_SENT`.
- **Order in a run:** the state job first, then summaries oldest first, one request
  at a time. The state goes into the very next prompt. A summary is needed only when
  its message reaches a step, 10 or more messages later.
- **The state job:** when the newest valid state isn't on the newest non-hidden
  message, read everything after it, up to 6 messages (§2). There's at most one
  state job per run. If a reply lands during the run, `again` picks it up, as now.
- **Gate:** summaries' gate (profile, Connection Manager, group chat, no chat), plus
  the World state setting and decision 8's check. The qvink gate stays with
  summaries alone.
- **Before writing:** the chat still holds the message object, and the read range
  still hashes the same. Otherwise the reply is discarded, not failed, as D-0037
  does.

## 4. Where it goes in the prompt

`prompt/injector.js` parks a second key, `cairn_state`, from the same interceptor:
`setExtensionPrompt('cairn_state', text, IN_CHAT, depth, false, SYSTEM)`
(`script.js:8926`, roles `:494`).

- **Which state:** the newest valid state whose message is in the prompt. The
  interceptor's `chat` is `coreChat`: hidden messages filtered out
  (`script.js:4496`), the last one popped on a swipe (`:4498`), and each entry
  rebuilt with `extra` shared by reference (`:4525`). So the injector finds the
  state's message by `extra` identity, never by index.
- **Depth** = the number of `coreChat` entries after that message. Blanked messages
  are still in `coreChat` when `doChatInject` runs (`:4745`), and the `IGNORE`
  flag only empties them at formatting (`:5841`). They are all older than the raw
  window, so they don't affect a depth that low. On a continue, ST moves a depth-0
  injection up one message (`:5665`).
- **Behind the step, not injected.** A state whose message is at or before the
  see-saw's `summarisedThrough` is older than the newest summary in the block, so it
  isn't current. Cairn parks nothing and logs why.
- **Read-only on `chat`.** The interceptor reads the array and writes nothing to it
  (§9, D-0037). `release()` clears `cairn_state` along with `cairn_memory`.
- **One writer** (`inventory.js` `classifySource`). Both keys belong to `cairn`, so
  `writers` stays 1.

## 5. Failure and rollback

- **A failure writes nothing** (CLAUDE.md §4.17), and the previous valid state stays
  in the prompt at its own depth. The streak and give-up count are separate for
  each kind. A failed state job toasts once per streak. After 3 failures on the
  same read range, the state tier gives up on it for the session, and the panel
  says so. The state then only goes stale, and at the step it drops out (§4).
- **Rollback needs no code.** Deletion, branching, swipes and edits all come down
  to "the newest valid state wins" (decisions 2 and 7). Nothing lives in
  `chatMetadata`.

## 6. What the inspector and the log show

**Log** (per generation, counts and kinds, never the state's text):
- `state_injected`, and `state_reason` (`injected`, `off`, `wtracker-loaded`,
  `none-yet` or `behind-step`)
- `state_depth` (1 in normal play; more than 1 means the queue is behind)
- `state_chars`, `state_tokens`
- `state_changed` (the injected text differs from last turn's), `state_change_kinds`
- `state_in_flight` (the state counterpart of `summary_in_flight`), `state_pending`
- `state_calls`, `state_written`, `state_failures`, `state_last_reason`,
  `state_dropped_fields`, `state_ms`, `state_tokens_in`, `state_tokens_out`
  (running totals, as `summary_*` are)
- `divergence_in` already names `cairn_state` when the prefix breaks inside it.
  That makes decision 1's cost directly readable.

**Panel.** A **World state** section shows what Cairn is doing (up to date, writing,
waiting on WTrackerLite, or gave up), then the current state as it's injected. The
panel is local and it's the user's own chat. It also shows depth, tokens, calls,
failures, average time, and the last change's kinds.

## 7. Tests that guard the invariants (CLAUDE.md §3.10)

| Invariant | Test |
|---|---|
| Single writer | Both keys parked → `writers: 1`. The interceptor's `chat` has the same length and identities afterwards |
| Volatility ordering (§6) | State A vs state B in a text-completion assembly mock → the two prompts share every byte through the message above the state, and the block is untouched |
| No clone | A Symbol flag on a neighbouring `extra` survives an intercept. The existing `structuredClone` lint rule covers `src/` |
| Swipe rollback | A new swipe keeps `extra` and changes `mes` (mirrors `script.js:6671-6684`) → stale → the previous state is used. Swiping back restores `extra` (`:7015`) → valid |
| Swipe generation | `type: 'swipe'` with the last message popped → a state on that message is not injected |
| Branch rollback | A chat truncated anywhere → the newest valid state at or before the cut, at the right depth |
| Edit invalidation | Editing, hiding or deleting a message inside a state's range → stale. Outside the range → still valid, with no cascade |
| Behind the step | A state message ≤ `summarisedThrough` → nothing parked |
| Applied, not claimed | A patch that repeats current values → `changed: []`. Dropped fields are counted and never applied |
| Bound | Random patches, valid and not → the rendered state never exceeds the ceiling |
| Deterministic render | The same state always gives the same bytes, and a new character is appended |
| Failure writes nothing | Every `badStateOutputs` entry that must be rejected, and a throw → no `state`, one toast per streak |
| Late reply discarded | A chat change, an edit in range or a swipe during a request → nothing written |
| Generation never waits | `MESSAGE_SENT` starts nothing, and the interceptor never awaits the queue |
| Store migration | The v1 fixture reads with no state. `writeScene` keeps `state` and `writeState` keeps `scene` |

**`badStateOutputs`** (in `test/mocks/llm.js`): fenced JSON, a preamble and a sign-off,
leaked `<think>`, cut-off JSON, a refusal, prose with no JSON, a full state instead of
a patch, an array at the top, a `time` field anyway, a wrong type, an over-long
value, 6 characters, a `mood` beside a character's change, capitalised keys, `{}`,
and `null` removals. A model that tracks what the schema leaves out has those
fields dropped and counted.

**Mocks:** the `coreChat` shape (`script.js:4496-4530`), the swipe and continue
paths in `saveReply` (`:6671-6701`), and `MESSAGE_EDITED` (`:8405`).

## 8. Cutover, and what we measure

**For the user:**
0. Back up the chats (CLAUDE.md §3.14). This build writes a new key and bumps the
   store version.
1. Update. World state is on, and the memory profile is already chosen.
2. On Esin, play 15–20 turns covering at least 2 steps. Include a swipe, an edit to
   the last reply, and one continue sent within seconds of a reply.
3. Then 5 turns with World state off, as the control.

**Measure:**
- **Held turns:** the break lands in `cairn_state`, and stability drops by about the
  state's share of the prompt. On Esin that's about 0.5 points, because its user
  messages are about 2 tokens. The real-chat figure (about 2 points, decision 1) is
  predicted from corpus sizes. *Optional:* 3–4 turns on a chat with real user
  messages would confirm it. That's mechanics only, not a quality run.
- **Step turns:** unchanged, still breaking at the block's tail (about 67%).
- **Depth:** `state_depth` is 1 on every normal turn. The swipe turn is still 1,
  from the previous state.
- **Calls:** one state call per reply, with 0 failures in normal play. Record
  `state_dropped_fields`.
- **Size:** `state_tokens` never exceeds about 330. Record the median.
- **Timing:** the burst after each reply (state plus summaries), and how many turns
  overlap a request (`state_in_flight`, `summary_in_flight`).
- **Rollback:** the swipe discards or ignores the old state, and the new swipe gets
  one. The edit makes the state stale, and it's rewritten before the next reply.

## Build order

1. Store v2: `readState` / `writeState`, range hashing, the migration, the v2 fixture.
2. `memory/state-schema.js`: fields, caps, `applyPatch` (merge, drops, changed kinds),
   `renderState`. Property tests for the bound.
3. `memory/state-strategy.js`: the prompt and the patch parser, with
   `badStateOutputs`. Move the `<think>` and fence cleanup out of
   `scene-strategy.js` into a shared helper, with no change to summary behaviour.
4. `memory/state.js`: the newest valid state for a prompt, the pending state job, and
   the WTracker check.
5. The queue: a state job ahead of summaries, per-kind stats and streaks, the
   `MESSAGE_EDITED` trigger. Split `summarizer.js` if it goes past the ~400-line
   ceiling.
6. The injector's `cairn_state` placement, the step clamp and release. Then the log,
   panel and World state setting.
7. The run (§8), decision entries, `DESIGN.md` §5–6 (depth 1, the schema),
   `how-it-works.md`, `st-api-surface.md` rows, CHANGELOG.

**New `st-api-surface.md` rows:** `doChatInject` depth placement (`script.js:5628`,
`:5665`), `coreChat.pop()` on a swipe (`:4498`), `extension_prompt_roles` (`:494`),
a new swipe keeping `extra` (`:6671`), `syncMesToSwipe` / `syncSwipeToMes` (`:6939`,
`:7015`), `MESSAGE_EDITED` (`:8405`, `events.js:10`), the continue shift (`:5665`).

## Not in P3

- Editing, regenerating or deleting a state by hand. Showing the state under each
  message
- An editable schema or prompt
- Mood, time of day, intentions, open threads and relationship axes (decision 4)
- Promoting state changes to canon (P4)
- Reading WTracker or WTrackerLite data
- Cascading invalidation after an edit to an old message
- Group chats
