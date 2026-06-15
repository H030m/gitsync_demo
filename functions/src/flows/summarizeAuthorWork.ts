// summarizeAuthorWorkFlow — the 進度表 "what did this person work on?" call.
// Given a canonical author (a GitHub login and/or a set of git names), fetch all
// of that author's commits, ask the model for a short markdown work summary, and
// cache it under repos/{repoId}/authorSummaries/{key}. The cache hit is keyed on
// the author's current commit count, so it busts automatically when new commits
// land. Mirrors explainCommitFlow's doc-cache + single-completion shape.
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../admin';
import { getOpenAI, MODELS } from '../config';
import {
  summarizeAuthorWorkSystem,
  summarizeAuthorWorkContext,
} from '../prompts/summarizeAuthorWork';

export interface SummarizeAuthorWorkInput {
  repoId: string;
  /** Canonical GitHub login (may be empty for name-only buckets). */
  login?: string;
  /** Known git author names for this bucket (used for login-less commits). */
  names?: string[];
  /** Regenerate even when a fresh cache exists. */
  force?: boolean;
}

export interface SummarizeAuthorWorkResult {
  markdown: string;
  cached: boolean;
}

/** How many of the author's newest commits we feed the model. */
const COMMIT_LIMIT = 100;

/**
 * Derive a Firestore-safe cache doc id for an author bucket. Prefer the login
 * (lowercased, non [a-z0-9-] → '-'); for name-only buckets, hash the sorted,
 * normalized names into a stable key so the same bucket always maps to the same
 * doc.
 */
export function authorCacheKey(login: string, names: string[]): string {
  const trimmedLogin = login.trim().toLowerCase();
  if (trimmedLogin) {
    return `login-${sanitize(trimmedLogin)}`;
  }
  const norm = names
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
    .sort();
  return `name-${hash(norm.join('|'))}`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-]/g, '-') || 'x';
}

/** Small stable string hash (djb2) → base36, avoids non-ASCII doc ids. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** Tolerant committedAt → millis (Firestore Timestamp, ISO string, or absent). */
function committedMillis(value: unknown): number {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof value === 'string') {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export async function summarizeAuthorWorkFlow(
  input: SummarizeAuthorWorkInput,
): Promise<SummarizeAuthorWorkResult> {
  const { repoId, force } = input;
  const login = (input.login ?? '').trim();
  const loginLower = login.toLowerCase();
  const names = (input.names ?? [])
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0);
  const nameSet = new Set(names);

  const cacheKey = authorCacheKey(login, input.names ?? []);
  const cacheRef = db.doc(
    `apps/gitsync/repos/${repoId}/authorSummaries/${cacheKey}`,
  );

  // ---- Fetch all commits, filter to this author in code -------------------
  // The repo has at most a few hundred commits, so a full collection read is
  // simpler (and index-free) than the login/name query gymnastics needed to
  // merge login-keyed and name-only docs.
  const snap = await db
    .collection(`apps/gitsync/repos/${repoId}/commits`)
    .get();

  const matched = snap.docs
    .map((d) => ({ id: d.id, data: d.data() ?? {} }))
    .filter(({ data }) => {
      const author = (data.author as Record<string, unknown> | undefined) ?? {};
      const docLogin = ((author.login as string | undefined) ?? '')
        .trim()
        .toLowerCase();
      if (docLogin) {
        return loginLower !== '' && docLogin === loginLower;
      }
      // Login-less doc → fall back to git name matching.
      const docName = ((author.name as string | undefined) ?? '')
        .trim()
        .toLowerCase();
      return docName !== '' && nameSet.has(docName);
    });

  if (matched.length === 0) {
    throw new HttpsError('not-found', 'no commits for this author');
  }

  const commitCount = matched.length;

  // ---- Cache hit: same commit count and not forced ------------------------
  const cacheSnap = await cacheRef.get();
  const cached = cacheSnap.exists ? cacheSnap.data() ?? {} : null;
  if (
    !force &&
    cached &&
    typeof cached.markdown === 'string' &&
    cached.markdown.length > 0 &&
    (cached.commitCount as number | undefined) === commitCount
  ) {
    return { markdown: cached.markdown, cached: true };
  }

  // ---- Build prompt context from the newest commits -----------------------
  const newest = matched
    .sort(
      (a, b) =>
        committedMillis(b.data.committedAt) - committedMillis(a.data.committedAt),
    )
    .slice(0, COMMIT_LIMIT);

  const label = login || input.names?.find((n) => n.trim()) || 'unknown';
  const commits = newest.map(({ data }) => ({
    message: (data.message as string | undefined) ?? '',
    aiSummary: (data.aiSummary as string | undefined) ?? null,
    additions: (data.additions as number | undefined) ?? 0,
    deletions: (data.deletions as number | undefined) ?? 0,
  }));

  // ---- One OpenAI call ----------------------------------------------------
  const completion = await getOpenAI().chat.completions.create({
    model: MODELS.fast,
    messages: [
      { role: 'system', content: summarizeAuthorWorkSystem },
      {
        role: 'user',
        content: summarizeAuthorWorkContext({ label, commitCount, commits }),
      },
    ],
  });
  const markdown = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!markdown) {
    throw new HttpsError('internal', 'OpenAI returned an empty summary');
  }

  // ---- Cache write-back (best-effort) -------------------------------------
  try {
    await cacheRef.set({
      markdown,
      commitCount,
      login,
      names,
      generatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.warn('summarizeAuthorWork: cache write failed (best-effort)', {
      repoId,
      cacheKey,
      err: String(err),
    });
  }

  logger.info('summarizeAuthorWork: generated', {
    repoId,
    cacheKey,
    commitCount,
  });
  return { markdown, cached: false };
}
