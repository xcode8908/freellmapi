import { SearchOnlyProvider } from './search-only.js';
export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2';
// Firecrawl (firecrawl.dev): 1,000 free credits a month. Validation reads the
// team's credit balance, which spends nothing.
export class FirecrawlProvider extends SearchOnlyProvider {
    platform = 'firecrawl';
    name = 'Firecrawl';
    async validateKey(apiKey) {
        return this.probe(`${FIRECRAWL_BASE_URL}/team/credit-usage`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
    }
}
//# sourceMappingURL=firecrawl.js.map