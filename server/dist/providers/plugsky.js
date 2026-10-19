import { providerHttpError } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
export const PLUGSKY_BASE_URL = 'https://plugsky.com/v1';
/** Permanent free chat aliases are catalog-managed. Do not discover the whole
 * public roster: it also includes paid and seven-day trial models. */
export class PlugskyProvider extends OpenAICompatProvider {
    constructor() {
        super({
            platform: 'plugsky', name: 'Plugsky', baseUrl: PLUGSKY_BASE_URL,
            // /models is public; this read-only endpoint requires a real API key.
            validateUrl: `${PLUGSKY_BASE_URL}/plugsky/usage`,
        });
    }
    async validationResult(response) {
        if ([401, 403].includes(response.status))
            return super.validationResult(response);
        if (!response.ok) {
            throw providerHttpError(response, 'Plugsky key validation is temporarily inconclusive');
        }
        const body = await response.json().catch(() => null);
        if (!body || !Array.isArray(body.data)) {
            throw Object.assign(new Error('Plugsky returned an invalid usage response'), { status: 502 });
        }
        return true;
    }
}
//# sourceMappingURL=plugsky.js.map