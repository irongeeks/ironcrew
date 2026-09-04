/**
 * IronCrew — SearXNG SearchProvider.
 *
 * The one that matters most for a local-first product: SearXNG is a
 * metasearch engine an operator runs themselves, so a query never leaves the
 * company's own network to reach a third party who would log it. No API key,
 * no account, no per-query billing — just an HTTP endpoint the operator
 * controls. Brave (brave-provider.ts) is the hosted fallback for installations
 * that do not want to run one.
 *
 * The API is a single call: `GET {baseUrl}/search?q=…&format=json`. Note that
 * `format=json` is off by default in SearXNG's own settings.yml — an instance
 * that has not enabled it answers 403, which `testConnection()` surfaces to
 * the operator as-is rather than hiding behind "not reachable".
 *
 * SearXNG has no result-count parameter: it returns a page of results and the
 * caller takes what it needs, which is what the clamp to MAX_SEARCH_RESULTS
 * does here. `fetchImpl` is injectable for the same reason it is in
 * TelegramInboundChannel: the tests exercise this class's real code path —
 * URL building, mapping, sanitising, error surfacing — without a socket.
 */

import {
  boundedResultLimit,
  sanitiseSearchResults,
  searchJson,
  SearchProviderError,
  type RawSearchResult,
  type SafeSearchLevel,
  type SearchConnectionStatus,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from "./search-provider.ts";

export interface SearxngProviderOptions {
  /** Base URL of the instance, e.g. "https://searx.intern.example". */
  baseUrl: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** SearXNG's safesearch parameter is numeric: 0 none, 1 moderate, 2 strict. */
const SAFE_SEARCH_VALUES: Record<SafeSearchLevel, string> = {
  off: "0",
  moderate: "1",
  strict: "2",
};

interface SearxngResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  publishedDate?: unknown;
}

interface SearxngResponse {
  results?: unknown;
}

export class SearxngProvider implements SearchProvider {
  readonly kind = "searxng" as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SearxngProviderOptions) {
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private searchUrl(query: SearchQuery): string {
    const params = new URLSearchParams({ q: query.query, format: "json" });
    if (query.language) params.set("language", query.language);
    const safe = query.safeSearch ? SAFE_SEARCH_VALUES[query.safeSearch] : undefined;
    if (safe !== undefined) params.set("safesearch", safe);
    return `${this.baseUrl}/search?${params.toString()}`;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const limit = boundedResultLimit(query.limit);
    let res: Response;
    try {
      res = await this.fetchImpl(this.searchUrl(query), { headers: { Accept: "application/json" } });
    } catch (err) {
      // A DNS failure or a refused connection is the common case for a
      // self-hosted instance; it deserves the instance's name, not a bare
      // "fetch failed" the operator cannot act on.
      throw new SearchProviderError(`SearXNG (${this.baseUrl}) nicht erreichbar: ${errorText(err)}`);
    }

    const data = (await searchJson(res, "SearXNG")) as SearxngResponse;
    const rows = Array.isArray(data?.results) ? (data.results as SearxngResult[]) : [];
    // An empty result set is an answer, not a failure: "nothing found" is
    // exactly what a caller needs to hear, and turning it into an error would
    // make an agent retry a query that will keep returning nothing.
    return sanitiseSearchResults(rows.map(toRaw), limit);
  }

  async testConnection(): Promise<SearchConnectionStatus> {
    try {
      const results = await this.search({ query: "ironcrew", limit: 1 });
      return { ok: true, message: `SearXNG erreichbar (${results.length} Treffer für Testabfrage).` };
    } catch (err) {
      // Reported, never thrown: the Settings UI asks "does this work?" and an
      // exception there would be an outage in the page, not an answer.
      return { ok: false, message: errorText(err) };
    }
  }
}

/** SearXNG calls the snippet `content` and the date `publishedDate` (ISO-8601). */
function toRaw(row: SearxngResult): RawSearchResult {
  return { title: row.title, url: row.url, snippet: row.content, publishedAt: row.publishedDate };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
