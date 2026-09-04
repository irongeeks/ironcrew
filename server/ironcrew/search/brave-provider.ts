/**
 * IronCrew — Brave Web Search SearchProvider.
 *
 * The hosted alternative to a self-hosted SearXNG (searxng-provider.ts), for
 * installations that would rather hold an API key than run a metasearch
 * instance. Brave has its own index, so it is a real second source rather than
 * a re-skin of somebody else's results — but every query does leave the
 * company's network, which is why SearXNG stays the default recommendation.
 *
 * The API is a single call: `GET https://api.search.brave.com/res/v1/web/search`
 * with the subscription key in the `X-Subscription-Token` header. The key
 * never appears in a URL and never appears in an error message — a
 * `testConnection()` result is shown to an operator and may end up in a
 * screenshot or a support ticket.
 *
 * `fetchImpl` is injectable exactly as in TelegramInboundChannel, so the tests
 * drive the real code path with no socket.
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

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1/web/search";

/** Brave's safesearch parameter takes these three words verbatim. */
const SAFE_SEARCH_VALUES: Record<SafeSearchLevel, string> = {
  off: "off",
  moderate: "moderate",
  strict: "strict",
};

export interface BraveProviderOptions {
  /** Subscription token from the Brave Search API dashboard. */
  apiKey: string;
  /** Injectable for tests — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Overridable for a proxy or a test double; defaults to the public endpoint. */
  apiBase?: string;
}

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  /** ISO-8601 when Brave knows the page's age, absent otherwise. */
  page_age?: unknown;
}

interface BraveResponse {
  web?: { results?: unknown };
  /** Present instead of `web` when Brave rejects the request. */
  error?: { detail?: unknown; meta?: unknown };
  message?: unknown;
}

export class BraveProvider implements SearchProvider {
  readonly kind = "brave" as const;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: BraveProviderOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? BRAVE_API_BASE;
  }

  private searchUrl(query: SearchQuery, limit: number): string {
    const params = new URLSearchParams({ q: query.query, count: String(limit) });
    if (query.language) params.set("search_lang", query.language);
    const safe = query.safeSearch ? SAFE_SEARCH_VALUES[query.safeSearch] : undefined;
    if (safe !== undefined) params.set("safesearch", safe);
    return `${this.apiBase}?${params.toString()}`;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const limit = boundedResultLimit(query.limit);
    let res: Response;
    try {
      res = await this.fetchImpl(this.searchUrl(query, limit), {
        headers: {
          Accept: "application/json",
          // Sent by header, never as a query parameter: URLs end up in proxy
          // logs and in error messages, and a key there is a leaked key.
          "X-Subscription-Token": this.apiKey,
        },
      });
    } catch (err) {
      throw new SearchProviderError(`Brave Search nicht erreichbar: ${errorText(err)}`);
    }

    const data = (await searchJson(res, "Brave Search")) as BraveResponse;
    const rows = Array.isArray(data?.web?.results) ? (data.web.results as BraveResult[]) : [];
    // No `web.results` is "nothing found", not a failure — see SearxngProvider.
    return sanitiseSearchResults(rows.map(toRaw), limit);
  }

  async testConnection(): Promise<SearchConnectionStatus> {
    try {
      const results = await this.search({ query: "ironcrew", limit: 1 });
      return { ok: true, message: `Brave Search erreichbar (${results.length} Treffer für Testabfrage).` };
    } catch (err) {
      return { ok: false, message: errorText(err) };
    }
  }
}

/** Brave calls the snippet `description` and the date `page_age`. */
function toRaw(row: BraveResult): RawSearchResult {
  return { title: row.title, url: row.url, snippet: row.description, publishedAt: row.page_age };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
