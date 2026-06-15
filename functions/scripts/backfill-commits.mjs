// One-off backfill: ingest commit docs that the webhook missed.
//
// Before 06-05 D1 the githubWebhook skipped every non-default-branch push, so
// feature-branch commits never reached Firestore (gap: 6/3–6/5, all on
// `feature/summary-intel-hub`). This script lists commits per branch via the
// GitHub REST API and writes the missing docs in the SAME shape the webhook now
// writes (with `branch`, a Firestore Timestamp `committedAt`). Idempotent: skips
// shas that already have a doc; first branch to surface a sha wins.
//
// Env:
//   GITHUB_TOKEN        (required)  a token with repo read access
//   FIREBASE_PROJECT_ID (default 'gitsync-645b3')
//   REPO_ID             (default 'H030m_gitsync')
//
// Run from `functions/` with admin credentials:
//   gcloud auth application-default login   (or set GOOGLE_APPLICATION_CREDENTIALS)
//   GITHUB_TOKEN=ghp_xxx node scripts/backfill-commits.mjs [--dry-run]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'gitsync-645b3';
const REPO_ID = process.env.REPO_ID ?? 'H030m_gitsync';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Resolve owner/repo from the repo doc's `name` ("owner/repo"). repoId itself is
// `${owner}_${repo}`, ambiguous when names contain `_`.
const repoSnap = await db.doc(`apps/gitsync/repos/${REPO_ID}`).get();
if (!repoSnap.exists) {
  console.error(`repo doc apps/gitsync/repos/${REPO_ID} not found`);
  process.exit(1);
}
const slug = repoSnap.data()?.name ?? '';
const slash = slug.indexOf('/');
if (slash <= 0) {
  console.error(`repo doc has no owner/repo slug (name: "${slug}")`);
  process.exit(1);
}
const owner = slug.slice(0, slash);
const repo = slug.slice(slash + 1);
console.log(`backfilling ${owner}/${repo} (repoId ${REPO_ID})${DRY_RUN ? ' [dry-run]' : ''}`);

// First 20 branches.
const branches = await gh(`/repos/${owner}/${repo}/branches?per_page=20`);

// First-seen-wins across branches: track shas we've already handled this run.
const seen = new Set();
let scanned = 0;
let written = 0;
let skipped = 0;

for (const b of branches) {
  const branchName = b.name;
  // First page only (per_page=100), newest first.
  const commits = await gh(
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branchName)}&per_page=100`,
  );
  for (const c of commits) {
    const sha = c.sha;
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    scanned += 1;

    const docRef = db.doc(`apps/gitsync/repos/${REPO_ID}/commits/${sha}`);
    const existing = await docRef.get();
    if (existing.exists) {
      skipped += 1;
      continue;
    }

    const commitInfo = c.commit ?? {};
    const authorInfo = commitInfo.author ?? {};
    const dateStr = authorInfo.date;
    const parsed = dateStr ? new Date(dateStr) : null;
    const committedAt =
      parsed && !Number.isNaN(parsed.getTime())
        ? Timestamp.fromDate(parsed)
        : FieldValue.serverTimestamp();

    const doc = {
      repoId: REPO_ID,
      sha,
      message: commitInfo.message ?? '',
      author: {
        login: c.author?.login ?? '',
        name: authorInfo.name ?? '',
        email: authorInfo.email ?? '',
      },
      url: c.html_url ?? '',
      // The list endpoint carries no file list — leave empty (matches the
      // webhook's filesChanged shape; explainCommit's GitHub fallback fills in
      // files on demand for the detail view).
      filesChanged: [],
      added: [],
      removed: [],
      modified: [],
      committedAt,
      branch: branchName,
      createdAt: FieldValue.serverTimestamp(),
    };

    written += 1;
    console.log(
      `${DRY_RUN ? '[dry-run] would write' : 'writing'} ${sha.slice(0, 7)} (${branchName}) — ${(doc.message || '').split('\n')[0]}`,
    );
    if (!DRY_RUN) await docRef.set(doc);
  }
}

console.log(
  `done: scanned ${scanned} unique commits across ${branches.length} branches, ` +
    `${DRY_RUN ? 'would write' : 'wrote'} ${written}, skipped ${skipped} existing`,
);
