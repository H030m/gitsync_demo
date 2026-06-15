// Prompts for summarizeAuthorWorkFlow — the 進度表 "what did this person work
// on?" per-author AI summary. Common rules (identity / grounding) come from the
// top-level base; this summary is always written in Traditional Chinese.
import { buildSystemPrompt } from './baseSystem';

const summarizeAuthorWorkBody = `你的任務：根據給你的某位作者的 commit 清單（commit 訊息、AI 摘要、增刪行數），用「非技術人也聽得懂」的中文，整理出這個人主要負責了哪些模組或功能。

規則：
- 輸出 3 到 6 個 markdown 條列（用「- 」開頭），每條一句話，聚焦在「做了哪個模組／功能」。
- 用平實的語言，避免艱深術語；可以把相近的 commit 歸納成一類。
- 不要前言、不要結語、不要標題，直接給條列。`;

export const summarizeAuthorWorkSystem = buildSystemPrompt({
  agentBody: summarizeAuthorWorkBody,
  language: 'Traditional Chinese',
});

export function summarizeAuthorWorkContext(args: {
  label: string;
  commitCount: number;
  commits: Array<{
    message: string;
    aiSummary: string | null;
    additions: number;
    deletions: number;
  }>;
}): string {
  const lines = args.commits.map((c) => {
    const firstLine = (c.message || '').split('\n')[0].trim() || '(no message)';
    const summary = c.aiSummary ? ` — ${c.aiSummary}` : '';
    return `- ${firstLine}${summary} (+${c.additions}/-${c.deletions})`;
  });

  return [
    `作者：${args.label}`,
    `commit 總數：${args.commitCount}（以下列出最新的 ${args.commits.length} 筆）`,
    ``,
    `Commits（最新在前）：`,
    lines.length ? lines.join('\n') : '- (none)',
  ].join('\n');
}
