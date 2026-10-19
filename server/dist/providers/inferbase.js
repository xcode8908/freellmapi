import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
export const INFERBASE_BASE_URL = 'https://api.inferbase.ai/v1';
function checkModel(requested, returned) {
    // Pin explicit catalog IDs, including :fp8/:turbo variants. Never silently
    // accept an auto-routed substitute as the requested model.
    if (returned !== requested) {
        throw Object.assign(new Error('Inferbase returned a different or missing model identity'), { status: 502 });
    }
}
/** Free managed chat shares monthly request and daily usage allowances.
 * Model rows remain exclusively in the signed, tier-gated catalog. */
export class InferbaseProvider extends OpenAICompatProvider {
    constructor() {
        super({
            platform: 'inferbase', name: 'Inferbase', baseUrl: INFERBASE_BASE_URL,
            // /models is public. Read authenticated credits instead; a $0 balance
            // is valid on Free and must not disable the key.
            validateUrl: 'https://api.inferbase.ai/api/v1/inference/credits',
        });
    }
    async validationResult(response) {
        if ([401, 403].includes(response.status))
            return super.validationResult(response);
        if (!response.ok)
            throw providerHttpError(response, 'Inferbase key validation is temporarily inconclusive');
        const body = await response.json().catch(() => null);
        if (typeof body?.balance_micros !== 'number' || !Number.isFinite(body.balance_micros)) {
            throw Object.assign(new Error('Inferbase returned an invalid credits response'), { status: 502 });
        }
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
            // Inference failures may arrive as HTTP 200 SSE error events, including
            // after a valid role chunk. Never forward these as successful completions.
            if ('error' in chunk) {
                throw Object.assign(new Error('Inferbase returned an upstream stream error or malformed event'), { status: 502 });
            }
            // Inferbase interleaves routing and billing receipts with OpenAI chunks.
            // Validate their attribution but keep these provider-only frames out of
            // the client stream. The standard usage-only chunk is preserved below.
            if (['routing', 'usage'].includes(chunk.object)) {
                checkModel(modelId, chunk.model);
                continue;
            }
            if (!Array.isArray(chunk.choices)) {
                throw Object.assign(new Error('Inferbase returned a malformed stream event'), { status: 502 });
            }
            if (chunk.model || chunk.choices?.length) {
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
//# sourceMappingURL=inferbase.js.map