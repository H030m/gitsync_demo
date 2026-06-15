// Rolling project brief (W3a) — the "project memory" that visibly grows each day.
//
// A single per-repo markdown doc at `repos/{repoId}/meta/projectBrief` that the
// daily-report flow re-summarizes every run (old brief + today's report → new
// brief). Day 1 it is empty; over time it accumulates the team's conventions,
// recurring blockers and tech choices. Downstream agent flows prepend it as a
// stable, cache-friendly context prefix so every agent benefits.
//
// Design mirrors tools/repoDocs.ts / tools/assignTools.ts:
//   - pure read/format helpers + one merge helper, no `onCall` wrapper;
//   - BEST-EFFORT throughout — every function tolerates failure (logger.warn)
//     and NEVER throws, so it can never fail the host report/flow (Rule D).
//
// `meta/` is the established Admin-SDK-only subcollection for repo-scoped
// singleton caches (W4 uses `meta/repoDocsCache`); no client rule / index needed.
import { logger } from 'firebase-functions/v2';
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import {
  projectBriefMergeSystem,
  projectBriefMergeUser,
} from '../prompts/projectBrief';

/** The accumulated project memory for one repo. */
export interface ProjectBrief {
  /** Markdown, hard-capped at MAX_BRIEF_CHARS. */
  content: string;
  /** Server timestamp of the last successful merge. */
  updatedAt: unknown;
  /** 0 → 1 → 2 …; increments on every successful merge (display/debug counter). */
  version: number;
}

/** Hard cap (~500 words at ~7 chars/word). The deterministic backstop that does
 *  NOT trust the model to respect the 500-word prompt instruction. */
export const MAX_BRIEF_CHARS = 3500;

function briefRef(repoId: string) {
  return db.doc(`apps/gitsync/repos/${repoId}/meta/projectBrief`);
}

/**
 * Best-effort read of the project brief. Returns null on a missing doc OR any
 * read error (logger.warn). NEVER throws.
 */
export async function readProjectBrief(
  repoId: string,
): Promise<ProjectBrief | null> {
  try {
    const snap = await briefRef(repoId).get();
    if (!snap.exists) return null;
    const d = snap.data() ?? {};
    return {
      content: (d.content as string | undefined) ?? '',
      updatedAt: d.updatedAt ?? null,
      version: (d.version as number | undefined) ?? 0,
    };
  } catch (err) {
    logger.warn('readProjectBrief failed; returning null (best-effort)', {
      repoId,
      err: String(err),
    });
    return null;
  }
}

/**
 * Pure formatter. null / empty content → '' (byte-identical prompt, no behavior
 * change). Otherwise wraps the content in a STABLE labelled block suitable for
 * placing at the TOP of a system/context message so the prompt-cache prefix is
 * preserved across requests on the same repo+day (the label only changes when
 * `version` bumps).
 */
export function formatBriefForPrompt(brief: ProjectBrief | null): string {
  const content = brief?.content.trim();
  if (!content) return '';
  return (
    `## Project memory (accumulated over ${brief!.version} daily report(s))\n\n` +
    `${content}\n`
  );
}

/**
 * A compact, deterministic text rendering of today's report, used as the merge
 * input. Includes the durable narrative (summary / highlights / blockers /
 * commit themes); intentionally EXCLUDES memberContributions — per-member counts
 * are day-specific noise for long-term memory, not durable knowledge.
 */
export function renderReportForBrief(report: {
  summary: string;
  highlights: string[];
  blockers: string[];
  commitThemes: Array<{ theme: string; summary: string }>;
}): string {
  const lines: string[] = [];
  if (report.summary.trim()) lines.push(`Summary: ${report.summary.trim()}`);
  if (report.highlights.length > 0) {
    lines.push('Highlights:');
    for (const h of report.highlights) lines.push(`- ${h}`);
  }
  if (report.blockers.length > 0) {
    lines.push('Blockers:');
    for (const b of report.blockers) lines.push(`- ${b}`);
  }
  if (report.commitThemes.length > 0) {
    lines.push('Commit themes:');
    for (const t of report.commitThemes) lines.push(`- ${t.theme}: ${t.summary}`);
  }
  return lines.join('\n');
}

/** Deterministic truncation to MAX_BRIEF_CHARS, appending a `…` marker when cut. */
function truncate(text: string): string {
  if (text.length <= MAX_BRIEF_CHARS) return text;
  return text.slice(0, MAX_BRIEF_CHARS - 1) + '…';
}

/**
 * Roll the project brief forward by one daily report. BEST-EFFORT — swallows all
 * errors (logger.warn) and NEVER throws; the caller's report is already
 * persisted before this runs.
 *
 * Skips entirely (no model call, no write) when there is nothing to merge: no
 * existing brief AND a trivially-empty report. Otherwise one MODELS.fast merge
 * call produces the next brief, which is deterministically truncated to
 * MAX_BRIEF_CHARS and written with an incremented `version`.
 */
export async function mergeProjectBrief(
  repoId: string,
  reportText: string,
): Promise<void> {
  try {
    const old = await readProjectBrief(repoId);
    const oldContent = old?.content.trim() ?? '';

    // Skip guard: nothing durable yet and nothing to merge → don't create an
    // empty brief or burn a model call.
    if (!oldContent && !reportText.trim()) return;

    const completion = await getOpenAI().chat.completions.create({
      model: MODELS.fast,
      messages: [
        { role: 'system', content: projectBriefMergeSystem },
        {
          role: 'user',
          content: projectBriefMergeUser({ oldBrief: oldContent, report: reportText }),
        },
      ],
    });

    const next = truncate((completion.choices[0]?.message?.content ?? '').trim());
    if (!next) return; // model returned nothing usable — keep the old brief.

    await briefRef(repoId).set({
      content: next,
      updatedAt: FieldValue.serverTimestamp(),
      version: (old?.version ?? 0) + 1,
    });

    logger.info('mergeProjectBrief: rolled brief', {
      repoId,
      version: (old?.version ?? 0) + 1,
      chars: next.length,
    });
  } catch (err) {
    logger.warn('mergeProjectBrief failed (best-effort)', {
      repoId,
      err: String(err),
    });
  }
}
