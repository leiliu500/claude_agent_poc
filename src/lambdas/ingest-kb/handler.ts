/**
 * Knowledge-base ingestion Lambda (S3-triggered, VPC-attached).
 *
 *   S3 ObjectCreated ─► ingest-kb ─► chunk ─► Bedrock Titan embed ─► upsert into pgvector
 *
 * Event-driven and idempotent: on each upload we hash the source text and skip re-embedding when the
 * document is unchanged. Otherwise we (re)chunk the document, embed every chunk with the SAME model +
 * dimension the KB action Lambda uses at query time (shared/kb.embedText), and replace the document's
 * chunks in fedline.kb_chunk. For an initial backfill, invoke this Lambda over an S3 prefix.
 *
 * Runs inside the DB VPC (to reach RDS) with a Bedrock-runtime interface endpoint + an S3 gateway
 * endpoint so both Bedrock and S3 are reachable without a NAT. Requires DATABASE_URL.
 *
 * Text extraction here handles utf-8 text (.txt/.md/.json). Binary formats (e.g. PDF) should be
 * converted to text upstream; a binary object is logged and skipped rather than mis-embedded.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { query, hasDatabase } from "../../shared/pg.js";
import { embedText, toVectorLiteral } from "../../shared/kb.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger({ mod: "ingest-kb" });

// Chunking: paragraph-aware, ~1200 chars/chunk with a one-paragraph overlap for context continuity.
const MAX_CHUNK_CHARS = 1200;

interface S3EventRecord {
  s3?: { bucket?: { name?: string }; object?: { key?: string } };
}
interface S3Event {
  Records?: S3EventRecord[];
}
/** Direct-invoke shape for backfill: process an explicit bucket/key (or list). */
interface DirectInvoke {
  bucket?: string;
  keys?: string[];
  key?: string;
}

interface IngestOutcome {
  key: string;
  status: "ingested" | "skipped-unchanged" | "skipped-binary" | "error";
  chunks?: number;
  error?: string;
}

// ── S3 client (SDK provided by the Lambda runtime; lazily constructed) ──────────
interface S3Like {
  send(cmd: unknown): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>;
}
let _s3: S3Like | undefined;
let _GetObjectCommand: (new (input: unknown) => unknown) | undefined;

async function s3(): Promise<{ client: S3Like; Get: new (input: unknown) => unknown }> {
  if (!_s3 || !_GetObjectCommand) {
    const mod = (await import("@aws-sdk/client-s3")) as unknown as {
      S3Client: new (cfg: { region?: string }) => S3Like;
      GetObjectCommand: new (input: unknown) => unknown;
    };
    _s3 = new mod.S3Client({ region: process.env.AWS_REGION });
    _GetObjectCommand = mod.GetObjectCommand;
  }
  return { client: _s3!, Get: _GetObjectCommand! };
}

async function getObjectText(bucket: string, key: string): Promise<string | undefined> {
  const { client, Get } = await s3();
  const res = await client.send(new Get({ Bucket: bucket, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) return undefined;
  // Reject content with NUL bytes in the first KB (a cheap "is this binary?" check).
  const probe = bytes.subarray(0, 1024);
  if (probe.includes(0)) return undefined;
  return new TextDecoder("utf-8").decode(bytes);
}

/** Derive a human title: first markdown heading, else the file base name. */
function deriveTitle(key: string, text: string): string {
  const heading = text.match(/^\s*#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  return basename(key).replace(/\.[^.]+$/, "");
}

/** Paragraph-aware chunking with a one-paragraph overlap. */
export function chunkText(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  let prevPara = "";
  for (const para of paras) {
    if (buf && buf.length + para.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push(buf);
      buf = prevPara ? prevPara + "\n\n" + para : para; // carry one paragraph of overlap
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
    prevPara = para;
  }
  if (buf.trim()) chunks.push(buf);
  // Fallback: a single very long paragraph with no blank lines — hard-split by length.
  if (chunks.length === 0 && text.trim()) {
    for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) chunks.push(text.slice(i, i + MAX_CHUNK_CHARS));
  }
  return chunks;
}

async function ingestOne(bucket: string, key: string): Promise<IngestOutcome> {
  const text = await getObjectText(bucket, key);
  if (text === undefined) return { key, status: "skipped-binary" };

  const docId = key; // stable id
  const sourceUri = `s3://${bucket}/${key}`;
  const contentHash = createHash("sha256").update(text).digest("hex");

  // Skip re-embedding when the document is unchanged since the last ingest.
  const existing = await query<{ content_hash: string | null }>(
    "SELECT content_hash FROM fedline.kb_document WHERE doc_id = $1",
    [docId],
  );
  if (existing[0]?.content_hash === contentHash) {
    log.info("unchanged; skipping", { key });
    return { key, status: "skipped-unchanged" };
  }

  const title = deriveTitle(key, text);
  const chunks = chunkText(text);

  // Upsert the document row with a NULL content_hash first, then replace its chunks
  // (delete-then-insert). The hash is written only AFTER all chunks embed + insert successfully, so a
  // mid-ingest failure leaves the hash unset and the next upload re-ingests instead of being skipped.
  await query("SELECT fedline.upsert_kb_document($1,$2,$3,NULL,$4::jsonb)", [
    docId,
    title,
    sourceUri,
    JSON.stringify({ key }),
  ]);
  await query("DELETE FROM fedline.kb_chunk WHERE doc_id = $1", [docId]);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedText(chunks[i]!);
    await query(
      "INSERT INTO fedline.kb_chunk (doc_id, chunk_index, content, embedding) VALUES ($1,$2,$3,$4::vector)",
      [docId, i, chunks[i], toVectorLiteral(embedding)],
    );
  }

  // Mark the document fully ingested (records the hash that gates future skip-unchanged checks).
  await query("UPDATE fedline.kb_document SET content_hash = $2, updated_at = now() WHERE doc_id = $1", [
    docId,
    contentHash,
  ]);

  log.info("ingested", { key, chunks: chunks.length });
  return { key, status: "ingested", chunks: chunks.length };
}

/** Collect (bucket, key) pairs from either an S3 event or a direct backfill invoke. */
function targets(event: S3Event & DirectInvoke): Array<{ bucket: string; key: string }> {
  const out: Array<{ bucket: string; key: string }> = [];
  for (const r of event.Records ?? []) {
    const bucket = r.s3?.bucket?.name;
    const key = r.s3?.object?.key;
    if (bucket && key) out.push({ bucket, key: decodeURIComponent(key.replace(/\+/g, " ")) });
  }
  const bucket = event.bucket;
  if (bucket) {
    for (const key of event.keys ?? (event.key ? [event.key] : [])) out.push({ bucket, key });
  }
  return out;
}

export const handler = async (
  event: S3Event & DirectInvoke,
): Promise<{ ok: boolean; results: IngestOutcome[]; error?: string }> => {
  if (!hasDatabase()) {
    return { ok: false, results: [], error: "DATABASE_URL is not set — knowledge base ingestion needs the pgvector store." };
  }
  const items = targets(event);
  log.info("ingest invoked", { count: items.length });

  const results: IngestOutcome[] = [];
  for (const { bucket, key } of items) {
    try {
      results.push(await ingestOne(bucket, key));
    } catch (err) {
      log.error("ingest failed for object", { key, error: String(err) });
      results.push({ key, status: "error", error: String(err) });
    }
  }
  return { ok: results.every((r) => r.status !== "error"), results };
};
