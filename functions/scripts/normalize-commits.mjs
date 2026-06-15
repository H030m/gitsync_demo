// One-off migration: normalize legacy commit docs written by the old
// githubWebhook handler.
//
//   committedAt   ISO string  →  Firestore Timestamp
//   filesChanged  number      →  [...added, ...removed, ...modified]
//
// Why: string-typed `committedAt` silently falls out of every Timestamp range
// query (Flutter Commits-tab range filter, dailyIntel listRangeCommits → range
// reports), and the Flutter model used to throw on both legacy shapes.
//
// Run from `functions/` with admin credentials:
//   gcloud auth application-default login   (or set GOOGLE_APPLICATION_CREDENTIALS)
//   node scripts/normalize-commits.mjs [--dry-run]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'gitsync-645b3';

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const repos = await db.collection('apps/gitsync/repos').get();
let scanned = 0;
let fixed = 0;

for (const repo of repos.docs) {
  const commits = await repo.ref.collection('commits').get();
  for (const doc of commits.docs) {
    scanned += 1;
    const data = doc.data();
    const update = {};

    if (typeof data.committedAt === 'string') {
      const parsed = new Date(data.committedAt);
      if (!Number.isNaN(parsed.getTime())) {
        update.committedAt = Timestamp.fromDate(parsed);
      }
    }

    if (typeof data.filesChanged === 'number') {
      update.filesChanged = [
        ...(Array.isArray(data.added) ? data.added : []),
        ...(Array.isArray(data.removed) ? data.removed : []),
        ...(Array.isArray(data.modified) ? data.modified : []),
      ];
    }

    if (Object.keys(update).length === 0) continue;
    fixed += 1;
    console.log(
      `${DRY_RUN ? '[dry-run] would fix' : 'fixing'} ${doc.ref.path}`,
      Object.keys(update).join(', '),
    );
    if (!DRY_RUN) await doc.ref.update(update);
  }
}

console.log(`done: scanned ${scanned} commit docs, ${DRY_RUN ? 'would fix' : 'fixed'} ${fixed}`);
