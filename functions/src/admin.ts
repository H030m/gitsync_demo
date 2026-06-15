// Single firebase-admin init point. Every handler / trigger / tool imports
// `db` from here. Calling initializeApp twice throws — keep it here only.
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp();
}

export const db = getFirestore();

// All Cloud Functions are pinned to this region. Must match the Firestore
// database location (currently asia-east1, Taiwan) to avoid cross-region
// trigger latency. See MEMORY.md 2026-05-27 "region locked to asia-east1".
export const REGION = 'asia-east1';
