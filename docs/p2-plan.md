# P2 plan — Cairn writes its own scene summaries

**Status: proposal, revised 2026-09-16 after Matt's answers.** Nothing here is
built. As each part lands, its decisions move into `decisions.md` and its
mechanism into `how-it-works.md`, and this page is deleted when P2 closes.

P2 means qvink leaves the path entirely: Cairn decides when to summarise, calls
the memory model, stores the result, and reads what qvink already wrote without
ever rewriting it. The assembler, the budgeter and D-0033's planning rules stay
as they are.

---

## Decisions

1. **One summary per message, in plain text.** *Decided by Matt, 2026-09-16.
   This reverses the first draft, which proposed one JSON delta summary per step.*
   - **Why.** Each request is one message plus the 5 summaries before it, so the
     prompt is small, the reply is short, and there's nothing to unpack.
     Batching risks blending summaries together and losing detail. It also
     builds up a backlog that gets paid off in one lump every step. And it needs
     a structured format that the model can get wrong.
   - **Evidence.** Matt's OpenRouter export, 2026-09-12 to 09-16: 105 qvink
     summary calls to GLM-4.7, excluding 5 calls that weren't summaries (2 test
     pings, 2 calls of about 12k tokens, and one chat message sent to this key
     by mistake).
     - **Size:** 1,012 tokens in and 111 out at the median, 2,408 in and 161 out
       at p90. The longest reply was 199 tokens, and none used reasoning tokens.
     - **Speed and cost:** a whole call took 6.9 s at the median, 13.9 s at p90
       and 21.2 s at most. The 105 calls cost $0.08 in total.
     - **Truncation:** all 105 finished with `stop`.
     - **Bursts:** calls ran one at a time with no overlaps, mostly in bursts of
       2–3 after each turn. A burst took 23 s at the median and 41 s at p90.
       Between bursts, Matt's own time was 12 min at the median and 2.2 min at
       p10. No burst in 30 lasted longer than the pause that followed it.
   - **What it changes.** The block grows at the same rate it does today,
     because qvink already writes one summary per message. So D-0034's
     measurements still apply (5 summaries and 462 tokens in a step). A scene
     still covers exactly one message, so the assembler's input doesn't change
     shape: no ranges and no batch clamp.
   - **Cost we accept.** ST returns no finish reason (`custom-request.js:60`).
     JSON would have caught a cut-off reply by failing to parse. Plain text needs
     a heuristic check instead (§4).
2. **The budget is a fixed 35% of the max prompt, with no setting.** *Decided by
   Matt, 2026-09-16.* Today's cap is qvink's `short_term_context_limit`, which
   for Esin is 7,500 tokens (34% of 22,016), and that value goes away with qvink.
   - **Why 35%, not 30%.** 35% keeps Esin at least the history it has today. At
     30% the cap would drop to 6,605 tokens. Summaries grow at the same rate as
     now (decision 1), and a percentage scales with context size.
   - **Cutover.** Esin's cap moves to 7,705 tokens. That's one rebuild, and it
     falls on the same turn as the uninstall rebuild.
   - **What it can't see.** On a small context with a large card and lorebook,
     text completion silently drops the oldest raw messages
     (`script.js:4920`). The log flags any turn whose `prompt_tokens` reaches the
     limit.
   - **Deferred to P6.** A budget worked out from the chat's own parts
     (`DESIGN.md` §13 P6). It's a separate phase so it doesn't reopen D-0033
     while the rest is being built.
3. **The summary prompt is editable.** *Decided by Matt, 2026-09-16.* It is
   better to handle this now than to add it later. The default is Matt's current
   qvink prompt (§4). This supersedes what the first draft proposed and settles
   the question D-0036 left open.
4. **Retire the qvink mirror at the end of P2.** *Decided by Matt, 2026-09-16.*
   The fidelity proof, the placement mirroring and the rendering read from
   qvink's settings are replaced with Cairn constants equal to qvink's defaults:
   the template, the `\n* ` separator, and `IN_PROMPT` at depth 2 with the
   system role. What stays is the read-only reader of `extra.qvink_memory`, plus
   one gate check that qvink is neither injecting nor excluding, in case someone
   turns it back on.

---

## 1. What Cairn writes

Stored on the summarised message itself:

```js
message.extra.cairn = {
    v: 1,                   // STORE_VERSION
    scene: {
        text: '…',          // the summary, exactly as injected
        hash: 'h:1a2b3c…',  // hash of this message's `mes` when summarised
        prompt: 'h:9f8e…',  // hash of the template that wrote it
        at: '2026-…Z',
    },
}
```

- **Validity is checked on read, every turn.** A scene counts only if the hash
  of its message's current `mes` still matches. After an edit, the scene is not
  injected, its message is not blanked, and the message is summarised again.
- **Deletions and branches need no handling.** The scene lives on its message
  object, so deleting a message removes its scene and shifts nothing else. A
  branch (`bookmarks.js:173`, which is a `structuredClone` of
  `chat.slice(0, mesId + 1)`) keeps exactly the messages it has, along with their
  summaries.
- **Swipes.** Only the last message can be swiped (`script.js:9195`), and Cairn
  never summarises the last message (§3). If a later message is deleted and an
  older one becomes swipeable again, ST keeps a separate copy of `extra` for each
  swipe (`:10340` → `:6939`, and `:10148` → `:7015`). The hash check would catch
  a mismatch regardless.
- **Which messages get summarised** is a pure rule, `summarisable(message)`,
  applied when reading. Hidden and system messages (`is_system`) are skipped.
  So are messages under 50 tokens, which matches Matt's qvink
  `message_length_threshold`. Skipped messages are never blanked and never hold
  the step. Because the rule is a constant computed when reading, nothing is
  stored for a skipped message. User messages are summarised, the same as
  Matt's qvink profile does today.
- **Hash.** A small pure string hash in `util/hash.js`. ST's `getStringHash` is
  not on `getContext()`.
- **Schema.** `STORE_VERSION` stays 1, and this is v1's first shape. The v1
  fixture lands now (CLAUDE.md §8.32).

### Migration: a read, never a write

`readScenes` reads two sources, one scene per message. If both exist, the Cairn
scene wins.

- `extra.qvink_memory.memory` gives `source: 'qvink'`. This is the reader we
  already have, including its `remember`/`exclude` rule. It has no hash, so it
  is trusted the way P1 trusts it.
- `extra.cairn.scene` gives `source: 'cairn'`, subject to the hash check.

**Cairn's queue starts after the newest qvink summary.** Earlier messages that
qvink skipped stay as qvink left them. Summarising them now would insert new
scenes into the middle of the block. qvink's data is never modified, and it
survives uninstalling qvink because ST saves unknown `extra` keys untouched.

## 2. `summarizer.js` and the strategy boundary

`DESIGN.md` §11's interface stays. The queue, the transport and the store never
see what the prompt says.

```js
// src/memory/scene-strategy.js (pure)
export const perMessage = {
    id: 'per-message-v1',
    build({ message, history, names, template }) { return { messages, maxTokens }; },
    parse(content) { return { ok: true, text } | { ok: false, reason }; },
};
```

`src/pipeline/summarizer.js` is the only file that calls a model:

- It calls `ConnectionManagerRequestService.sendRequest(profileId, messages,
  maxTokens, { stream: false, signal, includePreset: true, includeInstruct: true })`
  (`extensions/shared.js:423`), which returns `{ content, reasoning }`
  (`custom-request.js:60`).
- The profile is `memoryProfileId`. If it's empty, Cairn never summarises
  (D-0006). If it's the same as the chat's own profile, Cairn shows one warning.
- `maxTokens` is a constant of about 2,048: enough for a reasoning model's
  thinking plus a paragraph. It is not a setting.
- Requests run one at a time, never in parallel. An `AbortController` fires on
  `CHAT_CHANGED`.

**Failure behaviour (CLAUDE.md §4.17).** A throw, refusal, parse failure or
abort writes **nothing**. The first failure in a streak shows one toast; later
failures only log. A message that fails 3 times isn't retried again this
session. The inspector names it, and the step holds before it (§3), so the raw
window grows instead of memory being lost. Before writing, the summarizer checks
that the chat id is unchanged, that the target is still the same message object,
and that the hash still matches. That way, a reply that arrives after you've
left the chat is discarded.

## 3. When to summarise

- **Trigger: `MESSAGE_RECEIVED`** (`script.js:6691`, and `:3799` for streaming),
  plus `CHAT_CHANGED` to work through any backlog. Nothing runs on
  `MESSAGE_SENT`, because that's when the chat model starts generating, and on a
  shared or local backend a memory call would compete with it. A reply arriving
  is what starts the user's reading and writing time.
- **Queue:** summarisable messages after the start point that have no valid
  scene, excluding the last message (which can still be swiped, regenerated or
  edited), oldest first. On an ordinary turn that's two calls: the user's
  message and the reply before it. It's the same thing Matt's qvink
  `summarization_delay: 1` does.
- **History for each call:** the 5 valid scenes before that message, from either
  source. Matt's qvink profile already sends summaries 1–5 back, from both user
  and character, with no raw messages.
- **The step clamp.** `advance()` keeps its rule. The new threshold is clamped
  to just before the first summarisable message that has no valid scene. If the
  queue is behind, the step waits: the block doesn't change, and nothing is
  blanked without its summary. A message becomes summarisable when it's 1
  message old, and a step needs it at 11 or more (`RAW_WINDOW`), so a step waits
  only if the queue falls about 5 exchanges behind.
- **Generation is never blocked.** qvink's `auto_summarize_block_generation` is
  on in Matt's profile. Cairn uses the held step in its place.

## 4. The prompt

**Setting `summaryPrompt`.** An empty value means the built-in default, so
users who never edit the prompt get improvements to the default automatically.
It is a textarea with a "Reset to default" button. The description:
*"The instructions the memory model gets for summarising one message:
`{{message}}` is the message, `{{history}}` the summaries just before it."* If
the prompt has no `{{message}}`, Cairn uses the default and shows one warning.

**Default:** Matt's qvink prompt, verbatim, which has already been proven in
play on the D-0036 model floor.

```
Summarize the following fictional message as a single paragraph of 2-3 sentences in past tense. Do not use bullet points or numbered lists.

Include: character names (not pronouns), actions taken, dialogue points, emotional shifts, decisions made, and new information revealed.

{{#if history}}
Recent summary context (for reference only, do not re-summarize):
{{history}}
{{/if}}

Message to summarize:
{{message}}
```

`DESIGN.md` §12's structure (one `IMPORTANT:`, examples, a tiebreaker) is not
applied to this prompt, because a prompt measured in play beats one written to
rules. §12 gets a line saying so when this lands.

**Macros and rendering.**
- `{{message}}` is `Name: mes`, and `{{history}}` is the summaries, one per line.
  `{{#if history}}…{{/if}}` uses qvink's syntax, so an existing qvink prompt can
  be pasted in unchanged. ST's `{{char}}` and `{{user}}` also work.
- ST's macros are expanded on the template (`substituteParams`,
  `st-context.js:163`) **before** the message and history are inserted. That
  way, a `{{…}}` inside chat text is never expanded.
- Cairn's three macros go through a small pure renderer of its own:
  - ST's `{{if}}` exists only behind `experimental_macro_engine`
    (`script.js:2997`, `macros/definitions/core-macros.js:134`), and its syntax
    is different.
  - qvink's route, Handlebars (its `index.js:3119`), is deprecated for
    extensions (`st-context.js:177`).
- The prompt is sent as one user-role message.
- Editing the prompt doesn't rewrite existing summaries. `scene.prompt` records
  which template wrote each one.

**Parser (plain text).**
- **Cleanup:** strip `<think>…</think>` (including an unterminated leading one),
  code fences, and a leading `Summary:` label. Matt's qvink profile prefills
  `Summary: `, and Cairn sends no prefill. Line breaks are collapsed into one
  paragraph.
- **Rejected:**
  - an empty reply;
  - a reply over 1,500 characters;
  - a reply whose last character isn't sentence-ending punctuation (optionally
    followed by a closing quote or bracket). This is the truncation check that
    replaces JSON's.
  - a reply that opens like a refusal.
- **Known weakness:** a refusal worded in a way the check doesn't recognise gets
  stored as a summary. It stays visible in the inspector, and the hash lets a
  later edit-and-retry replace it.
- **Tests:** every entry in `badOutputs` (`test/mocks/llm.js`), rewritten for
  plain text.

## 5. How the assembler's input changes

Very little. `readScenes` merges both sources as described in §1. The
threshold comes from the clamped scheduler, and the cap comes from decision 2
instead of `resolveCap`. `covered`, `blank`, eviction, the floor and the
first-turn rebuild don't change, and all D-0033 rules hold. Rendering keeps
qvink's template and separator, so at cutover the qvink part of the block is
byte-identical.

An edited message that's already inside the block loses its scene until it's
summarised again. Its raw text comes back, and the new scene takes its old
position in the block. That breaks the prefix at that point. This is expected,
and edits are rare.

## 6. Tests that guard the invariants (CLAUDE.md §3.10)

| Invariant | Test |
|---|---|
| Nothing is blanked without a valid scene | Random chats with edits, deletions and truncations: every blanked index has a valid scene |
| A missing summary holds the step | Gap at the first summarisable message → `held`; filled → step. Skipped messages (short or hidden) don't hold it |
| The last message is never summarised | The queue never includes `chat.length - 1` |
| Branch rollback | Chat truncated → kept messages keep their valid scenes, nothing past the cut is blanked |
| Edit rollback | Mutated `mes` → hash mismatch → not blanked, requeued |
| No clone | The writer assigns `context.chat[i].extra.cairn`; message identity is kept, and a Symbol flag on a neighbouring message survives. **Plus a lint rule** banning `structuredClone` in `src/` (CLAUDE.md §9.35) |
| Replies to a chat you've left are discarded | Mock request resolves after `CHAT_CHANGED` → nothing written |
| Failure writes nothing, one toast per streak | Each `badOutputs` entry and a thrown error → no `extra.cairn`, toast count 1 |
| Chat text isn't macro-expanded | A message containing `{{user}}` reaches the request literally |
| Prompt fallback | A template without `{{message}}` → default used, one warning |
| Migration | A mixed fixture (qvink region, then Cairn scenes) → the qvink part of the block is byte-identical to P1's render |
| Single writer | The existing assertion, `writers: 1` |

Mocks: a `swipe_info` message shape checked against the corpus, and a
`MESSAGE_RECEIVED` payload (`script.js:6691`).

## 7. Cutover, and what we measure

**For the user:**

0. Back up the chats (CLAUDE.md §3.14). This is the first build that writes
   `message.extra`.
1. Leave qvink as P1 left it (Macro Only, exclude off), and turn off its
   **Auto Summarize**.
2. Pick Cairn's **Memory connection**. Summarising starts after the newest qvink
   summary.
3. Play through at least two steps and read the log.
4. Disable qvink, then uninstall it. Its summaries stay readable.

**Measure** (Esin, 15–20 turns, covering at least 2 steps and the uninstall):

- Held turns stay at 96% or better. Step turns still break at the block's tail,
  with a cycle mean of about 91% or better (D-0034).
- No step ever waits in normal play (`memory_step_waiting` stays 0).
- Summaries start and finish between generations, and none overlaps a
  generation.
- At most one rebuild at uninstall, recorded.
- New log fields (never summary text): `memory_source` (`qvink` / `mixed` /
  `cairn`), `memory_cairn_scenes`, `memory_step_waiting`, `summary_calls`,
  `summary_failures`, `summary_last_reason`, `summary_ms`, `summary_tokens_in`,
  `summary_tokens_out`, `summary_prompt_default` (whether the prompt was
  edited).

## Build order

1. `util/hash.js`, and `store/chat-store.js` to read, validate and write
   `extra.cairn`. The v1 fixture. `summarisable()`.
2. `readScenes` merging both sources, and the step clamp. No model calls yet;
   tested against hand-written `extra.cairn` fixtures.
3. The prompt renderer, `scene-strategy.js` and the parser, with their tests.
4. `summarizer.js` (queue, transport, failure handling) and the
   `MESSAGE_RECEIVED` / `CHAT_CHANGED` wiring in `index.js`.
5. The `summaryPrompt` setting, the budget from decision 2, the inspector and log
   fields. Then the cutover run, then a decision entry.
6. Retire the qvink mirror (decision 4) and the settings it read. Docs and
   CHANGELOG.

## Not in P2

- User editing of summaries, and remember/forget toggles
- Re-summarising when the prompt changes, and re-summarising qvink's old
  summaries
- A cap on backlog size for chats that have no summaries at all
- A prefill, parallel calls, and a manual retry button
- Long-term memory, compaction and merge (P4), world state (P3), group chats
