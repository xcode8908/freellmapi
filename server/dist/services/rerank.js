import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { parseRetryAfterMs } from '../providers/base.js';
import { secondsUntilNextMonth } from './key-budget.js';
export class RerankError extends Error {
    status;
    code;
    retryAfterMs;
    constructor(message, status, code, retryAfterMs) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOCUMENTS = 100;
function candidates() {
    const rows = getDb().prepare("SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') AND platform IN ('cohere', 'custom') ORDER BY platform, created_at").all();
    const out = [];
    for (const row of rows) {
        if (row.platform === 'custom' && !row.base_url)
            continue;
        try {
            out.push({ id: row.id, platform: row.platform, key: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url });
        }
        catch { /* undecryptable row is not a candidate */ }
    }
    // Custom endpoints (the operator's explicit rerank relays) go first.
    return out.sort((a, b) => (a.platform === 'custom' ? -1 : 0) - (b.platform === 'custom' ? -1 : 0));
}
async function upstreamError(r) {
    const retryAfterMs = parseRetryAfterMs(r.headers?.get('retry-after') ?? null);
    return new RerankError(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`, r.status, undefined, retryAfterMs);
}
async function callProvider(cand, model, query, documents, topN) {
    // ponytail: cohere + jina-shaped custom only; per-provider adapters when a
    // provider needs a different wire shape.
    const url = cand.platform === 'cohere'
        ? 'https://api.cohere.com/v2/rerank'
        : `${cand.baseUrl.replace(/\/$/, '')}/rerank`;
    const modelId = model
        || (cand.platform === 'cohere' ? 'rerank-v3.5' : 'rerank');
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cand.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, query, documents, top_n: topN }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
        throw await upstreamError(res);
    const body = await res.json();
    if (!Array.isArray(body.results))
        throw new RerankError('upstream returned malformed rerank results', 502);
    const results = body.results.map(r => ({
        index: r.index ?? -1,
        relevanceScore: r.relevance_score ?? 0,
        document: typeof r.document === 'string' ? r.document : r.document?.text ?? documents[r.index ?? -1] ?? '',
    })).filter(r => r.index >= 0 && r.index < documents.length);
    // An upstream answer with no in-range hit serves nobody — treat it as a
    // malformed response so the chain moves on to the next provider.
    if (results.length === 0)
        throw new RerankError('upstream returned no valid rerank hits', 502);
    return { modelId, results };
}
export async function runRerank(model, query, documents, topN) {
    if (documents.length > MAX_DOCUMENTS) {
        throw new RerankError(`Too many documents: ${documents.length} (max ${MAX_DOCUMENTS})`, 400);
    }
    const chain = candidates();
    if (chain.length === 0) {
        throw new RerankError('No rerank-capable key configured. Add a Cohere key or a custom rerank endpoint.', 503);
    }
    const n = topN ?? documents.length;
    let lastError = null;
    for (const cand of chain) {
        try {
            const out = await callProvider(cand, model, query, documents, n);
            return { platform: cand.platform, modelId: out.modelId, results: out.results };
        }
        catch (err) {
            lastError = err instanceof RerankError ? err : new RerankError(String(err?.message ?? err), 502);
        }
    }
    throw new RerankError(`All rerank providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : ''}.`, lastError?.status === 429 ? 429 : 502, lastError?.code, lastError?.status === 429 ? lastError?.retryAfterMs : undefined);
}
/** Whole seconds the client should wait before retrying: the upstream back-off
 *  when the chain was rate limited, else the monthly-budget reset. */
export function rerankRetryAfterSec(err) {
    if (err.retryAfterMs !== undefined)
        return Math.ceil(err.retryAfterMs / 1000);
    if (err.code === 'quota_exceeded')
        return secondsUntilNextMonth();
    return undefined;
}
//# sourceMappingURL=rerank.js.map