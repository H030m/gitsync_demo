// Query planner for askRepoFlow — the "understand intent BEFORE searching" step.
//
// A developer's question is usually informal ("opal 剛剛推的那個 merge", "拆解那
// 包東西做完沒"): the literal words rarely match the data (logins carry suffixes,
// tasks have no ids in the question, time is vague). Instead of letting the main
// agent take the wording literally, this cheap pre-step restates the question as
// a structured search intent (AskRepoPlanSchema) so the loop searches with the
// right FUZZY parameters. It is BEST-EFFORT: a failure/empty plan leaves the
// flow unchanged (the agent just works from the raw question).
import type { AskRepoPlan } from '../types';

export function askRepoPlannerSystem(today: string): string {
  return `You turn a developer's (often informal, code-switching Chinese/English) question about a software repo into a STRUCTURED search intent. Today is ${today} (Asia/Taipei).

Do NOT answer the question. Only extract intent, reading between the lines:
- intent: restate, in one plain sentence, what they actually want to know — de-jargoned, with implied context made explicit.
- people: every person they referred to, however informal or partial (nicknames, first names, a login fragment like "opal"). Don't normalize — the search matches fuzzily.
- taskHints: tasks/features described in words (e.g. "the breakdown thing", "登入流程"), NOT ids.
- searchTopics: 2-4 short semantic phrases to feed a meaning-based commit/Discord search (translate vague references into concrete topics).
- timeWindowDays: the look-back the phrasing implies. "剛剛 / just now / 最近 / lately" → 7; "這週 / this week / 上週" → 14; "這個月 / this month" → 30; a specific older period → wider; nothing stated → 30. Never exceed 92.

Be generous and inclusive: it is better to surface a candidate person/topic than to miss it (the agent verifies later). Leave an array empty only when the question truly implies nothing for it.`;
}

/** Render a plan as a compact guidance block injected into the main loop's
 *  context. Empty/again-falsy fields are dropped so the block stays short. */
export function formatPlanForPrompt(plan: AskRepoPlan): string {
  const lines: string[] = [];
  if (plan.intent?.trim()) lines.push(`- Likely intent: ${plan.intent.trim()}`);
  if (plan.people?.length)
    lines.push(
      `- People to look up (pass to listDayCommits.authorLogin — fuzzy): ${plan.people.join(', ')}`,
    );
  if (plan.taskHints?.length)
    lines.push(`- Tasks/features referred to: ${plan.taskHints.join(', ')}`);
  if (plan.searchTopics?.length)
    lines.push(
      `- Search topics (searchPastCommits / searchDiscordMessages): ${plan.searchTopics.join('; ')}`,
    );
  if (typeof plan.timeWindowDays === 'number')
    lines.push(`- Suggested look-back: pass days=${plan.timeWindowDays}.`);
  if (lines.length === 0) return '';
  return `\n\nInterpretation of the question (guidance for choosing tool arguments — use it, but still verify with tools and don't mention it to the user):\n${lines.join('\n')}`;
}
