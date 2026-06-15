// Idempotency guard for Firestore triggers (which are at-least-once;
// MEMORY.md 2026-05-26 "all Firestore triggers must do idempotency check",
// ARCHITECTURE.md §4.4 Rule C).
//
// Usage inside a trigger:
//   const fresh = await markIdempotent(event.id);
//   if (!fresh) return; // already processed → skip
//   // ... business logic (may call OpenAI, etc.) ...
//
// IMPORTANT: do NOT put slow side-effects (OpenAI calls) inside the same
// transaction that writes the idempotency key — see Rule D.
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../admin';

/**
 * Returns `true` if the event has not been processed before (caller should
 * proceed). Returns `false` if it has been seen — caller should return.
 */
export async function markIdempotent(eventId: string): Promise<boolean> {
  const ref = db.doc(`apps/gitsync/idempotencyKeys/${eventId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.set(ref, { processedAt: FieldValue.serverTimestamp() });
    return true;
  });
}
