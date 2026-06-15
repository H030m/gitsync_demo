// OpenAI text-embedding-3-small wrapper. Returns a 1536-dim vector ready for
// `FieldValue.vector(...)` storage in Firestore.
import { FieldValue } from 'firebase-admin/firestore';

import { getOpenAI, MODELS } from '../config';

export async function embed(text: string): Promise<number[]> {
  const res = await getOpenAI().embeddings.create({
    model: MODELS.embedding,
    input: text,
  });
  return res.data[0].embedding;
}

export async function embedToFieldValue(text: string): Promise<FirebaseFirestore.VectorValue> {
  const vec = await embed(text);
  return FieldValue.vector(vec);
}
