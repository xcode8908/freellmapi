import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
export const APINEX_BASE_URL = 'https://api.apinex.bond/v1';
function checkModel(requested, returned) {
    if (requested !== returned) {
        throw Object.assign(new Error('APINex returned a different or missing model identity'), { status: 502 });
    }
}
/** Free-category chat shares a weighted daily allowance with decisions.
 * Preserve free/ exactly; never retry a paid alias. Eligibility and model
 * rows belong exclusively in the signed, tier-selected catalog. */
export class ApinexProvider extends OpenAICompatProvider {
    constructor() {
        super({ platform: 'apinex', name: 'APINex', baseUrl: APINEX_BASE_URL, validateUrl: `${APINEX_BASE_URL}/balance` });
    }
    async validationResult(response) {
        if ([401, 403].includes(response.status))
            return super.validationResult(response);
        if (!response.ok)
            throw providerHttpError(response, 'APINex key validation is temporarily inconclusive');
        const body = await response.json().catch(() => null);
        if (body?.object !== 'balance' || body.error || typeof body.balance_usd !== 'number' || !Number.isFinite(body.balance_usd)) {
            throw Object.assign(new Error('APINex returned an invalid balance response'), { status: 502 });
        }
        // A zero-dollar wallet is valid: free-category calls use the daily pool.
        return true;
    }
    async chatCompletion(apiKey, messages, modelId, options, quotaContext) {
        const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
        checkModel(modelId, response.model);
        return response;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options, quotaContext) {
        let identified = false;
        for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
            if ('error' in chunk || !Array.isArray(chunk.choices)) {
                throw Object.assign(new Error('APINex returned an upstream stream error or malformed event'), { status: 502 });
            }
            // Usage-only terminal frames may omit model, but every content-bearing
            // frame must carry the exact route. Do not accept an empty stream.
            if (chunk.model || chunk.choices.length) {
                checkModel(modelId, chunk.model);
                identified = true;
            }
            if (!identified)
                checkModel(modelId, chunk.model);
            yield chunk;
        }
        if (!identified)
            checkModel(modelId, '');
    }
}
//# sourceMappingURL=apinex.js.map