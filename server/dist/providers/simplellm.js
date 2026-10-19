import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
export const SIMPLELLM_BASE_URL = 'https://api.simplellm.eu/v1';
const RETURNED_ALIASES = {
    'free-gemma-4-E4B': 'gemma-4-E4B',
    'free-Llama-3.1-8B-Instruct': 'Llama-3.1-8B',
};
function checkModel(requested, returned) {
    if (returned !== requested && (!RETURNED_ALIASES[requested] || returned !== RETURNED_ALIASES[requested])) {
        throw Object.assign(new Error('SimpleLLM returned a different or missing model identity'), { status: 502 });
    }
}
function wireOptions(options) {
    // SimpleLLM accepts stop arrays, not a scalar stop string.
    return typeof options?.stop === 'string' ? { ...options, stop: [options.stop] } : options;
}
export class SimpleLLMProvider extends OpenAICompatProvider {
    constructor() {
        super({ platform: 'simplellm', name: 'SimpleLLM', baseUrl: SIMPLELLM_BASE_URL,
            validateUrl: `${SIMPLELLM_BASE_URL}/rate-limit` });
    }
    async validationResult(response) {
        if ([401, 403].includes(response.status))
            return super.validationResult(response);
        if (!response.ok)
            throw providerHttpError(response, 'SimpleLLM key validation is temporarily inconclusive');
        const body = await response.json().catch(() => null);
        if (typeof body?.limit_rpm !== 'number' || !Number.isFinite(body.limit_rpm)) {
            throw Object.assign(new Error('SimpleLLM returned an invalid rate-limit response'), { status: 502 });
        }
        return true;
    }
    async chatCompletion(apiKey, messages, modelId, options, quotaContext) {
        const response = await super.chatCompletion(apiKey, messages, modelId, wireOptions(options), quotaContext);
        checkModel(modelId, response.model);
        return response;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options, quotaContext) {
        let identified = false;
        for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, wireOptions(options), quotaContext)) {
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
//# sourceMappingURL=simplellm.js.map