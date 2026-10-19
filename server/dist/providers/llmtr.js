import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerTimeoutMs } from '../lib/provider-timeout.js';
import { recordQuotaObservationsFromResponse } from '../services/provider-quota.js';
export const LLMTR_BASE_URL = 'https://llmtr.com/v1';
const VALIDATION_MODEL = '__freellmapi_key_validation__';
/**
 * Floor between the START of two key-validation probes (#1369).
 *
 * NOT a published LLMTR rate limit — their docs state none for this endpoint.
 * It is the politeness floor for OUR probe traffic: the same nonexistent-model
 * POST, repeated back to back from one IP, is the burst pattern their security
 * system reads as automation, and an account flagged that way gets suspended.
 * Every caller of validateKey reaches the network through this one method, so
 * pacing here covers the health pass, the forced pass behind the dashboard's
 * "check all" button, the post-wake re-probe, the cooldown-probe job and the
 * 401-triggered revalidation alike. Operators who know their account tolerates
 * more can lower it; 0 disables pacing.
 */
export const LLMTR_VALIDATION_MIN_GAP_MS = 2_000;
export const LLMTR_VALIDATION_GAP_ENV = 'LLMTR_VALIDATION_MIN_GAP_MS';
function validationMinGapMs() {
    const raw = process.env[LLMTR_VALIDATION_GAP_ENV];
    if (raw !== undefined && raw.trim() !== '') {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0)
            return n;
        console.warn(`[config] Ignoring ${LLMTR_VALIDATION_GAP_ENV}="${raw}": expected a non-negative integer of milliseconds (0 disables pacing). Using the default ${LLMTR_VALIDATION_MIN_GAP_MS}ms.`);
    }
    return LLMTR_VALIDATION_MIN_GAP_MS;
}
function checkModel(requested, returned) {
    if (returned !== requested) {
        throw Object.assign(new Error('LLMTR returned a different or missing model identity'), { status: 502 });
    }
}
/** True when a 403 body says LLMTR refuses automated key-validation probes
 * (#1390) rather than rejecting the key. Reads a clone so the caller's
 * validationResult can still consume the body. */
async function blocksAutomatedValidation(res) {
    const body = await res.clone().json().catch(() => null);
    const text = [body?.error?.message, body?.message].filter((v) => typeof v === 'string').join(' ').toLowerCase();
    return text.includes('automated api key validation') || (text.includes('automated') && text.includes('validation'));
}
/** Selected zero-priced routes have renewable daily/rolling quotas, not a
 * monthly cash grant. Only the signed catalog supplies model rows: the public
 * roster also contains paid models, expiring promotions and BYOK-only rows. */
export class LlmtrProvider extends OpenAICompatProvider {
    validationMinGapMs;
    now;
    sleep;
    /** Tail of the probe queue. Resolves when the probe ahead of a caller is
     * done, so validation requests run one at a time, in arrival order. */
    validationTail = Promise.resolve();
    /** Start time of the last probe that got its turn, for the gap floor. */
    lastValidationStartedAtMs = 0;
    /** Probes already in flight, keyed by credential. Two callers asking about
     *  the same key at the same time (the health pass and the cooldown-probe job
     *  overlap easily) share one request instead of sending two identical ones. */
    inFlightValidations = new Map();
    /** #1459: LLMTR refuses automated key checks outright, so the health pass
     * and the cooldown probe never send one. Keys turn healthy on their first
     * served request instead. validateKey below stays for explicit callers. */
    get supportsKeyValidation() {
        return false;
    }
    constructor(opts = {}) {
        super({ platform: 'llmtr', name: 'LLMTR', baseUrl: LLMTR_BASE_URL });
        this.validationMinGapMs = opts.validationMinGapMs ?? validationMinGapMs();
        this.now = opts.now ?? Date.now;
        this.sleep = opts.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    }
    /**
     * validateKey, paced and coalesced. Returns the same promise to concurrent
     * callers asking about the same credential, so the shared verdict is the one
     * question answered once. The merged callers' quota contexts are not
     * summed — quota observations are booked per platform+key, and a single
     * response carries a single set of headers to book.
     */
    validateKey(apiKey, quotaContext) {
        const inFlight = this.inFlightValidations.get(apiKey);
        if (inFlight)
            return inFlight;
        const probe = this.queuedValidation(() => this.probeKey(apiKey, quotaContext));
        this.inFlightValidations.set(apiKey, probe);
        // Drop the entry once settled so the next question is a fresh probe, but
        // never before: a caller that arrives while this one is still open gets
        // the answer it would otherwise have to pay for again.
        void probe.then(() => { this.retireValidation(apiKey, probe); }, () => { this.retireValidation(apiKey, probe); });
        return probe;
    }
    retireValidation(apiKey, probe) {
        if (this.inFlightValidations.get(apiKey) === probe)
            this.inFlightValidations.delete(apiKey);
    }
    /**
     * Take a turn in the probe queue: wait for the probe ahead, then for the gap
     * floor to elapse, then stamp the start and run. The queue is released in a
     * finally so a rejected probe (timeout, 5xx) cannot stall the probes behind
     * it for the rest of the process's life.
     */
    async queuedValidation(probe) {
        const ahead = this.validationTail;
        let release;
        this.validationTail = new Promise(resolve => { release = resolve; });
        await ahead;
        try {
            const wait = this.lastValidationStartedAtMs + this.validationMinGapMs - this.now();
            if (wait > 0)
                await this.sleep(wait);
            this.lastValidationStartedAtMs = this.now();
            return await probe();
        }
        finally {
            release();
        }
    }
    /** The probe itself: one authenticated request, verdict classified below. */
    async probeKey(apiKey, quotaContext) {
        // /models is public; /api/usage expects a dashboard token. This nonexistent
        // model checks authentication without generating tokens: live controls on
        // 2026-09-29 returned 401/auth_error for an invalid key and
        // 404/model_not_found for the valid key. Do not accept generic 404s.
        const res = await this.fetchWithTimeout(`${LLMTR_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: VALIDATION_MODEL, messages: [{ role: 'user', content: 'key validation' }], max_tokens: 1, stream: false }),
        }, providerTimeoutMs(this.platform, 30_000), { timeoutBounds: 'request' });
        recordQuotaObservationsFromResponse(res, { ...quotaContext, platform: this.platform, endpoint: 'key-validation' });
        if ([401, 403].includes(res.status)) {
            // #1390: LLMTR answers the probe itself with 403 "Automated API key
            // validation tools are not supported." That is a verdict about the
            // request shape, not the key. Returning valid:false here would let the
            // health service's three-strike counter auto-disable a perfectly good
            // key purely because it was probed. Same shape as the Cloudflare
            // challenge guard in base.validationResult (#1298): inconclusive, never
            // a disable.
            if (res.status === 403 && await blocksAutomatedValidation(res)) {
                throw providerHttpError(res, 'LLMTR rejected the key-validation probe itself (automated validation not supported); the key was not checked');
            }
            return this.validationResult(res);
        }
        if (res.status === 404) {
            const body = await res.clone().json().catch(() => null);
            if (body?.error?.type === 'model_not_found')
                return true;
        }
        throw providerHttpError(res, 'LLMTR key validation is temporarily inconclusive');
    }
    async chatCompletion(apiKey, messages, modelId, options, quotaContext) {
        const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
        checkModel(modelId, response.model);
        return response;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options, quotaContext) {
        for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
            checkModel(modelId, chunk.model);
            yield chunk;
        }
    }
}
//# sourceMappingURL=llmtr.js.map