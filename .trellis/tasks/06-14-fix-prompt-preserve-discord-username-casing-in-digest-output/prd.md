# fix(prompt): preserve Discord username casing in digest output

## Goal

Stop the LLM from capitalizing Discord usernames when they appear at the
start of a sentence or bullet in a generated/edited Discord digest.
Reported case: `whale_island` rendered as `Whale_island`. Names like
`whale_island` and `kai_t` must appear exactly as written, regardless of
position.

## Root cause (already diagnosed, 2026-06-14)

Two prompts under `functions/src/prompts/` produce the digest text:

* `discordDailyDigest.ts` — original generation (`discordDailyDigestFlow`).
* `editDiscordDigest.ts` — in-app / bot edit (`editDiscordDigestFlow`).

Neither system prompt instructs the model to preserve username casing.
The fast model (`gpt-4o-mini`) defaults to English grammar: capital
first letter at the start of a sentence / bullet, so `whale_island`
becomes `Whale_island` whenever it leads.

Same risk applies anywhere the digest text is composed:
`discordRangeDigest.ts` doesn't have its own prompt — it loops the
daily flow, so fixing the daily prompt fixes the range too.

## Decisions (locked 2026-06-14)

* **Fix surface**: two prompt files (`discordDailyDigest.ts` +
  `editDiscordDigest.ts`). No code-level transform; the LLM owns the
  text, so the rule belongs in its instructions.
* **Wording**: explicit + example, since `gpt-4o-mini` follows
  prompts more reliably with a concrete demo. Add a single line to
  each system prompt:

  > Preserve every chat author's username exactly as written — including
  > lowercase first letters and underscores — even when the username
  > opens a sentence, heading, or bullet (e.g. write `whale_island said …`,
  > never `Whale_island said …`).

  Phrased to cover sentence-start, heading-start, and bullet-start —
  all three positions where the model might apply auto-capitalization.
* **Scope**: only the two digest prompts. Other prompts (`discordChat`,
  `summarizeDay`, `dailyBrief`, etc.) are not part of the reported bug
  and stay untouched. If the same issue is seen there later, the same
  one-line rule applies.
* **Existing Firestore digests** are NOT regenerated. The fix is
  forward-looking — new digests will be correct. Users can refresh
  affected days via the app's existing refresh button to overwrite the
  stored doc.

## Requirements

* Update `functions/src/prompts/discordDailyDigest.ts` —
  add the rule under "Output rules" in the system prompt.
* Update `functions/src/prompts/editDiscordDigest.ts` —
  add the rule under "Rules" in the system prompt.
* No changes to flows, tools, schemas, or tests beyond keeping existing
  prompt-shape tests (if any) green.

## Acceptance Criteria

* [ ] Both system prompts contain a username-preservation rule with the
      `whale_island` example.
* [ ] `npm test` — full suite green; any test that snapshots the prompt
      text is updated.
* [ ] `npm run typecheck` + `npm run lint` green.
* [ ] Spot-check via the live generator path is **deferred to user**
      (run a digest, confirm `whale_island` stays lowercase).

## Definition of Done

* AC items pass.
* Single commit on develop.

## Out of Scope

* Migrating already-generated digest docs in Firestore (forward-only fix).
* Tightening other prompts (`discordChat`, etc.) — not reported broken.
* Adding a deterministic post-LLM regex fixer — overkill for one prompt
  rule; if the LLM still slips, a second-pass fixer can be added later.

## Technical Notes

* Both system prompts are short, plain strings; adding one bullet doesn't
  measurably affect token cost.
* No prompt snapshot tests exist for these two files (checked via grep);
  adding one is out of scope.
