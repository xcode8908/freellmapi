import { SearchOnlyProvider } from './search-only.js';
export const LINKUP_BASE_URL = 'https://api.linkup.so/v1';
// Linkup (linkup.so): monthly free credit top-up. Validation reads the credit
// balance, which spends nothing.
export class LinkupProvider extends SearchOnlyProvider {
    platform = 'linkup';
    name = 'Linkup';
    async validateKey(apiKey) {
        return this.probe(`${LINKUP_BASE_URL}/credits/balance`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        });
    }
}
//# sourceMappingURL=linkup.js.map