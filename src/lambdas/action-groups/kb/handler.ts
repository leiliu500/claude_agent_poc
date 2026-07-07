/**
 * KB (knowledge base / RAG) action group — the collaborator the Supervisor invokes to answer a
 * knowledge/policy/how-to question from the indexed document corpus.
 *
 * Operation: POST /run with { useCase: "kbSearch", params: { query, topK? } }.
 * Returns a DispatchResult whose `meta.answer` is the grounded answer, `meta.citations` the sources,
 * and `data` the retrieved passages (title/source/score/snippet).
 *
 * The retrieval + grounding lives in shared/kb.ts (Bedrock Titan embeddings + Postgres pgvector when
 * DATABASE_URL is set, else an in-code corpus), reached through the shared executeTask dispatcher —
 * so this Lambda is the same thin Bedrock-contract adapter every type Lambda uses.
 */
import { makeActionGroupHandler } from "../../../shared/action-group.js";

export const handler = makeActionGroupHandler("KB");
