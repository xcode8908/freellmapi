import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
export const BLOCKRUN_BASE_URL = 'https://api.blockrun.ai/v1';
function checkModel(requested, returned) {
    // Free capacity can silently substitute a different model with HTTP 200.
    // Reject before returning/yielding so the router can try another route.
    if (returned !== requested) {
        throw Object.assign(new Error('BlockRun returned a different or missing model identity'), { status: 502 });
    }
}
/** API-key gateway, NOT the separate wallet/x402 endpoint. Only tested $0
 * routes enter the signed catalog; the public roster also includes paid IDs. */
export class BlockRunProvider extends OpenAICompatProvider {
    constructor() {
        super({ platform: 'blockrun', name: 'BlockRun', baseUrl: BLOCKRUN_BASE_URL,
            validateUrl: `${BLOCKRUN_BASE_URL}/account` });
    }
    async validationResult(response) {
        if (!response.ok && ![401, 403].includes(response.status)) {
            throw providerHttpError(response, 'BlockRun key validation is temporarily inconclusive');
        }
        return super.validationResult(response);
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
//# sourceMappingURL=blockrun.js.map