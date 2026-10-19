// Runtime copy of shared/types.ts SEARCH_PLATFORMS. The server only ever
// imports types from @freellmapi/shared (it is not compiled into dist), so the
// list lives here too; a test pins the two together.
export const SEARCH_PLATFORMS = ['tavily', 'exa', 'firecrawl', 'linkup', 'parallel', 'serpsearch'];
const SEARCH_PLATFORM_SET = new Set(SEARCH_PLATFORMS);
/** True for platforms whose keys serve web search only, never chat. */
export function isSearchPlatform(platform) {
    return SEARCH_PLATFORM_SET.has(platform);
}
//# sourceMappingURL=search-platforms.js.map