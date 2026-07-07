/**
 * Knowledge-base RAG engine: the seam the KB collaborator's Lambda uses to answer a
 * knowledge/policy/how-to question from an indexed document corpus.
 *
 * Two backends, chosen at runtime (mirrors shared/user-directory.ts and src/mock/data.ts):
 *   - Postgres + pgvector (production): when DATABASE_URL is set, embed the query with Bedrock
 *     Titan embeddings, retrieve the nearest passages via fedline.search_kb() (cosine over an HNSW
 *     index), then ground an answer in them. See db/schema.sql for the vector tables/function.
 *   - In-memory corpus (default): a small hand-maintained document set scored by lexical overlap,
 *     so the whole pipeline — tests, ORCHESTRATION_MODE=local, the api-entrypoint fallback — runs
 *     with zero infra and no Bedrock/AWS calls. Deterministic.
 *
 * Answer generation is EXTRACTIVE by default (compose the answer from the retrieved passages, with
 * citations) so it is deterministic and always grounded. Set KB_GENERATE=true to synthesise the
 * answer with a Bedrock model instead (production quality; requires model access + Bedrock reach).
 *
 * `embedText()` is shared with the ingest Lambda so query embeddings and chunk embeddings come from
 * the exact same model + dimension — a mismatch silently breaks similarity search.
 */
import { createLogger } from "./logger.js";
import { hasDatabase, query } from "./pg.js";

const log = createLogger({ mod: "kb" });

// ── Config (single source of truth for the embedding model + dimension) ─────────
/** Bedrock embedding model. Titan Text Embeddings V2 is available in GovCloud (us-gov-west-1). */
export const KB_EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "amazon.titan-embed-text-v2:0";
/** Embedding dimension — MUST match the vector(N) column in db/schema.sql (Titan v2 supports 1024). */
export const KB_EMBED_DIM = Number(process.env.KB_EMBED_DIM ?? "1024");
/** Generation model for the optional synthesised-answer path (defaults to the flow's foundation model). */
const KB_GEN_MODEL = process.env.KB_GEN_MODEL ?? process.env.FOUNDATION_MODEL ?? "";
/** Whether to synthesise the answer with a Bedrock model (else deterministic extractive). */
const KB_GENERATE = (process.env.KB_GENERATE ?? "").toLowerCase() === "true";
const DEFAULT_TOP_K = 6;

// ── Public shapes ───────────────────────────────────────────────────────────────
export interface KbPassage {
  docId: string;
  title: string;
  content: string;
  sourceUri?: string;
  /** Cosine similarity 0..1 (higher is closer). */
  score: number;
}

export interface KbAnswer {
  /** Grounded natural-language answer (extractive by default). */
  answer: string;
  /** The passages the answer is grounded in, best-first. */
  passages: KbPassage[];
  /** De-duplicated human citations (title — sourceUri) for the passages used. */
  citations: string[];
  /** Which backend served the retrieval. */
  source: "postgres" | "memory";
}

// ── In-memory corpus (the no-database path — mirrors what would be ingested to pgvector) ──
interface CorpusDoc {
  docId: string;
  title: string;
  sourceUri: string;
  content: string;
}

const CORPUS: ReadonlyArray<CorpusDoc> = [
  {
    docId: "edd-overview",
    title: "Enhanced Due Diligence (EDD): Overview",
    sourceUri: "kb://policies/edd-overview.md",
    content:
      "Enhanced Due Diligence (EDD) is the heightened review applied to higher-risk deposit " +
      "differences. An EDD summary report lists difference records across institutions for a period; " +
      "each record carries an eddLoadID and an ncdwRecordID. To open the line-level detail for a " +
      "record, the detail report is requested with a reportId composed as `${eddLoadID}_${ncdwRecordID}`. " +
      "Summary reports are paginated; export variants return the full result set.",
  },
  {
    docId: "edd-reportid-rule",
    title: "How the EDD detail reportId is derived",
    sourceUri: "kb://policies/edd-reportid.md",
    content:
      "The EDD detail reportId is never stored and never fixed. It is derived from a selected summary " +
      "record by joining its two identifiers with an underscore: reportId = eddLoadID + '_' + " +
      "ncdwRecordID (for example 2233_3003696182). For several records at once, join the pairs with " +
      "commas and request the export detail report, whose endpoint accepts the whole comma-joined list.",
  },
  {
    docId: "xship-fee-waiver",
    title: "XShip Fee Waiver Policy",
    sourceUri: "kb://policies/xship-fee-waiver.md",
    content:
      "Shipping (XShip) fees may be waived for a rollup ABA within a reporting period when the waiver " +
      "criteria are met. The XShip Waiver report lists fee waivers granted for a rollup ABA and period. " +
      "Fee detail, fee summary and total-fee reports are available per rollup ABA, zone and period, and " +
      "each is exportable in a chosen format (csv or pdf).",
  },
  {
    docId: "xship-download",
    title: "XShip Activity Downloads",
    sourceUri: "kb://guides/xship-download.md",
    content:
      "XShip activity downloads return shipping activity detail for a prepared request. Activity can be " +
      "downloaded by ABA, by ABA rollup, by zone, or by an encoded criteria token over a period. A " +
      "download is requested against a prepared requestId (activity) or an encoded criteria token.",
  },
  {
    docId: "relationship-file",
    title: "ABA Relationship File (XSHI)",
    sourceUri: "kb://guides/relationship-file.md",
    content:
      "The XSHI relationship file resolves relationships for an ABA or an ABA group. A group lookup " +
      "returns the member ABAs of a group; a single-ABA lookup returns the relationships for one " +
      "9-digit routing number.",
  },
  {
    docId: "signin-identifiers",
    title: "Signing in and identifier resolution",
    sourceUri: "kb://guides/signin.md",
    content:
      "After you sign in, your identity and stored identifiers (office id, ABA, rollup ABA, zone, " +
      "period and others) are attached automatically to every request, so you do not need to type your " +
      "name or IDs. Report requests use those identifiers to fill the backend API paths.",
  },
];

// ── Lexical scoring (the in-memory retrieval; deterministic, dependency-free) ────
const STOP = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "in", "on", "how", "do", "i",
  "what", "does", "with", "by", "my", "me", "can", "you", "it", "this", "that", "as", "at", "be",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function lexicalScore(queryTokens: string[], docTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hits++;
  return hits / queryTokens.length; // 0..1, share of query terms present
}

function retrieveInMemory(queryText: string, topK: number): KbPassage[] {
  const qTokens = tokenize(queryText);
  const scored = CORPUS.map((doc) => ({
    doc,
    score: lexicalScore(qTokens, new Set(tokenize(`${doc.title} ${doc.content}`))),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  return scored.map((s) => ({
    docId: s.doc.docId,
    title: s.doc.title,
    content: s.doc.content,
    sourceUri: s.doc.sourceUri,
    score: Number(s.score.toFixed(4)),
  }));
}

// ── Bedrock embeddings (shared by retrieval + ingestion) ────────────────────────
interface BedrockRuntimeLike {
  send(cmd: unknown): Promise<{ body: Uint8Array }>;
}
let _brt: BedrockRuntimeLike | undefined;
let _InvokeModelCommand: (new (input: unknown) => unknown) | undefined;

async function bedrock(): Promise<{ client: BedrockRuntimeLike; Cmd: new (input: unknown) => unknown }> {
  if (!_brt || !_InvokeModelCommand) {
    const mod = (await import("@aws-sdk/client-bedrock-runtime")) as unknown as {
      BedrockRuntimeClient: new (cfg: { region?: string }) => BedrockRuntimeLike;
      InvokeModelCommand: new (input: unknown) => unknown;
    };
    const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION;
    _brt = new mod.BedrockRuntimeClient({ region });
    _InvokeModelCommand = mod.InvokeModelCommand;
  }
  return { client: _brt!, Cmd: _InvokeModelCommand! };
}

/**
 * Embed a piece of text with the configured Bedrock embedding model. Used for both query embeddings
 * (retrieval) and chunk embeddings (ingestion) so the vector spaces match. Throws on failure so the
 * caller can decide whether to fall back (retrieval) or fail the ingest.
 */
export async function embedText(text: string): Promise<number[]> {
  const { client, Cmd } = await bedrock();
  const body = JSON.stringify({ inputText: text, dimensions: KB_EMBED_DIM, normalize: true });
  const res = await client.send(
    new Cmd({ modelId: KB_EMBED_MODEL, contentType: "application/json", accept: "application/json", body }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: number[] };
  if (!Array.isArray(parsed.embedding)) throw new Error("Bedrock embedding response had no 'embedding' array");
  return parsed.embedding;
}

/** pgvector text literal for an embedding: `[0.1,0.2,...]` cast to ::vector in SQL. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function retrievePostgres(queryText: string, topK: number): Promise<KbPassage[]> {
  const embedding = await embedText(queryText);
  const rows = await query<{
    doc_id: string;
    title: string;
    content: string;
    source_uri: string | null;
    score: number;
  }>("SELECT doc_id, title, content, source_uri, score FROM fedline.search_kb($1::vector, $2::int)", [
    toVectorLiteral(embedding),
    topK,
  ]);
  return rows.map((r) => ({
    docId: r.doc_id,
    title: r.title,
    content: r.content,
    sourceUri: r.source_uri ?? undefined,
    score: typeof r.score === "number" ? Number(r.score.toFixed(4)) : 0,
  }));
}

// ── Answer generation ───────────────────────────────────────────────────────────
function citationsOf(passages: KbPassage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of passages) {
    const c = p.sourceUri ? `${p.title} — ${p.sourceUri}` : p.title;
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** Deterministic extractive answer: lead with the top passage, grounded and cited. */
function extractiveAnswer(queryText: string, passages: KbPassage[]): string {
  if (passages.length === 0) {
    return "I couldn't find anything about that in the knowledge base.";
  }
  const top = passages[0]!;
  const supporting = passages.slice(1, 3).map((p) => p.title);
  const parts = [`Based on the knowledge base: ${top.content.trim()}`];
  if (supporting.length) parts.push(`See also: ${supporting.join("; ")}.`);
  void queryText;
  return parts.join(" ");
}

/** Optional Bedrock-synthesised answer, strictly grounded in the retrieved passages. */
async function generatedAnswer(queryText: string, passages: KbPassage[]): Promise<string> {
  const context = passages
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.content}`)
    .join("\n\n");
  const prompt =
    "You are a knowledge-base assistant. Answer the user's question using ONLY the passages below. " +
    "If the passages do not contain the answer, say you don't have that information. Cite passages " +
    `by their [number].\n\nPassages:\n${context}\n\nQuestion: ${queryText}\n\nAnswer:`;
  const { client, Cmd } = await bedrock();
  // Bedrock InvokeModel bodies are model-family specific; this uses the Messages-style body that the
  // configured foundation model accepts. Kept behind KB_GENERATE so the default path never calls it.
  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  });
  const res = await client.send(
    new Cmd({ modelId: KB_GEN_MODEL, contentType: "application/json", accept: "application/json", body }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  const text = parsed.output?.message?.content?.map((c) => c.text ?? "").join("").trim();
  return text || extractiveAnswer(queryText, passages);
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface KbQueryInput {
  query: string;
  topK?: number;
}

/**
 * Answer a knowledge-base question. Retrieves passages (Postgres+pgvector when configured, else the
 * in-memory corpus) and grounds an answer in them. Best-effort: a Postgres/Bedrock failure degrades
 * to the in-memory corpus + extractive answer rather than throwing, so the flow always gets an answer.
 */
export async function runKbQuery(input: KbQueryInput): Promise<KbAnswer> {
  const queryText = (input.query ?? "").trim();
  const topK = input.topK && input.topK > 0 ? Math.min(input.topK, 20) : DEFAULT_TOP_K;

  let passages: KbPassage[] = [];
  let source: KbAnswer["source"] = "memory";

  if (hasDatabase()) {
    try {
      passages = await retrievePostgres(queryText, topK);
      source = "postgres";
    } catch (err) {
      log.warn("pgvector retrieval failed; falling back to in-memory corpus", { error: String(err) });
    }
  }
  if (source === "memory") {
    passages = retrieveInMemory(queryText, topK);
  }

  let answer: string;
  if (KB_GENERATE && passages.length > 0) {
    try {
      answer = await generatedAnswer(queryText, passages);
    } catch (err) {
      log.warn("Bedrock generation failed; using extractive answer", { error: String(err) });
      answer = extractiveAnswer(queryText, passages);
    }
  } else {
    answer = extractiveAnswer(queryText, passages);
  }

  return { answer, passages, citations: citationsOf(passages), source };
}

/** Test seam: drop the cached Bedrock client so env changes take effect. */
export function resetKbClientForTests(): void {
  _brt = undefined;
  _InvokeModelCommand = undefined;
}
