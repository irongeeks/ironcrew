/**
 * IronCrew — Nextcloud integration adapter (Knowledge pack).
 *
 * WHY THIS ADAPTER EXISTS
 *
 * The Knowledge pack's premise is that the company's own documents are the
 * best context an agent can have, and that they must not have to leave the
 * building to be useful. Nextcloud is the file server most of our target
 * shops already run, so "read what is in the Wissen folder" is a question we
 * can answer without a third-party sync, an upload to somebody's cloud, or a
 * second copy of the data that then has to be kept current. Three questions
 * cover it: is it reachable, what is in this folder, what does this file say
 * — `testConnection()`, `listFolder()` and `downloadText()`. Nothing more.
 *
 * WHY IT IS READ-ONLY, AND STAYS READ-ONLY
 *
 * There is no PUT, no MKCOL, no DELETE, no MOVE and no share creation here,
 * and adding one is not a small follow-up commit. A credential that can write
 * to the company's file server can also destroy the company's file server,
 * and an agent that misreads an instruction would do it at machine speed
 * across a tree a human would have taken a week to delete by hand. Creating a
 * *share* is worse still: it is a one-call path from "internal document" to
 * "public URL", and no amount of prompt care makes that safe to hand to a
 * language model. Read-only is also what the tool registry classes as risk
 * "read" (`packToolSchema.risk_class`), so the label an owner sees when
 * granting the tool matches what this code can physically do. A write method
 * here would silently make that label a lie.
 *
 * WHY AN APP PASSWORD, NOT THE ACCOUNT PASSWORD
 *
 * Nextcloud's own client documentation says to use one, and the reason is the
 * blast radius. An app password is issued per device, is revocable on its own
 * from Personal settings → Security without touching any other client, and
 * cannot be used to change the account itself — the settings pages that
 * change a password or an e-mail address demand the real login again. So a
 * leaked app password costs one revoke; a leaked account password costs the
 * account, and with it every other client, the 2FA enrolment and the recovery
 * addresses. It is also the only credential that works at all once the user
 * has two-factor authentication on, because the server then refuses the login
 * password to WebDAV clients outright.
 *
 * API AS PUBLISHED — NOTHING HERE IS INVENTED
 *
 *   WebDAV basics (base path, PROPFIND, multistatus):
 *     https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/basic.html
 *   OCS API overview (OCS-APIRequest header, format=json, ocs envelope):
 *     https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html
 *   `GET /ocs/v2.php/cloud/user` → Users#getCurrentUser, as routed in
 *     https://github.com/nextcloud/server/blob/master/apps/provisioning_api/appinfo/routes.php
 *   App passwords for WebDAV clients, and the 2FA rule:
 *     https://docs.nextcloud.com/server/latest/user_manual/en/files/access_webdav.html
 *     https://docs.nextcloud.com/server/latest/user_manual/en/session_management.html
 *   PROPFIND, Depth, 207 Multi-Status and the propstat/status rule:
 *     https://www.rfc-editor.org/rfc/rfc4918#section-9.1
 *     https://www.rfc-editor.org/rfc/rfc4918#section-13
 *
 * From that documentation: files live under
 * `{baseUrl}/remote.php/dav/files/{username}/{path}`; a `PROPFIND` with
 * `Depth: 1` answers `207` with a `d:multistatus` of `d:response` elements,
 * each carrying a `d:href` and one or more `d:propstat` blocks of `d:prop`
 * plus a `d:status`; the properties used here are `d:getcontentlength`,
 * `d:getlastmodified`, `d:getcontenttype` and `d:resourcetype` (a folder is
 * the one whose `d:resourcetype` contains `d:collection`). The OCS call needs
 * the header `OCS-APIRequest: true` and answers `{ ocs: { meta, data } }`,
 * where `data` holds `displayname` and a `quota` object.
 *
 * WHAT IS NOT CONFIRMED
 *
 * This adapter has never run against a live Nextcloud from this repository.
 * Its tests assert the request it builds and the mapping it performs — a
 * wrong method, a dropped `Depth` header or a mis-encoded umlaut fails a
 * test — which is a real guarantee and not the same guarantee.
 * `testConnection()` is what an operator runs on day one to find out.
 * Specifically unverified against a real server: the exact `d:` prefixes and
 * whitespace of a live multistatus body (the parser is prefix- and
 * layout-agnostic for that reason), and whether a reverse proxy in front of
 * the instance rewrites the `d:href` prefix (see `relativePath()`).
 */

import {
  integrationFetch,
  integrationJson,
  normaliseBaseUrl,
  PackIntegrationError,
  type HttpIntegrationOptions,
  type IntegrationStatus,
  type PackIntegrationAdapter,
} from "../pack-integration.ts";

export interface NextcloudAdapterOptions extends HttpIntegrationOptions {
  /** The Nextcloud login name (the uid), not the display name. */
  username: string;
  /**
   * An **app password** from Personal settings → Security, never the account
   * password. See the header: revocable on its own, useless for changing the
   * account, and the only thing that works with 2FA enabled.
   */
  appPassword: string;
}

export interface NextcloudEntry {
  /** The last path segment, decoded — "Angebot Müller.md", not "%20M%C3%BC". */
  name: string;
  /** Path relative to the user's files root, always leading-slash. */
  path: string;
  /** `d:getcontentlength`. Folders have no size, so `null` rather than 0. */
  sizeBytes: number | null;
  /** `d:getlastmodified` (an HTTP-date) as epoch milliseconds. */
  lastModifiedAt: number | null;
  /** `d:getcontenttype`. Folders report "httpd/unix-directory" or nothing. */
  contentType: string | null;
  isFolder: boolean;
}

/**
 * The default ceiling for `downloadText()`.
 *
 * A document read by this pack ends up in a model's context, and 512 KiB of
 * text is already several times more than any context window will take — so
 * the cap costs nothing a caller actually wanted. What it buys is that a
 * mistyped path pointing at a 4 GB disk image cannot buffer 4 GB into the
 * orchestrator's heap and take the whole server down with it. The cap is
 * enforced on *bytes off the wire*, not on the decoded string: an umlaut is
 * two bytes and a CJK glyph three, so a character count would let a document
 * be three times the size the operator thought they had allowed.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024;

/**
 * The PROPFIND body. Asking for named properties rather than sending an empty
 * body (which means `allprop`) keeps the response small and, more usefully,
 * stable: `allprop` grows whenever an installed app registers a property, and
 * a parser reading a fixed five is not affected by that.
 */
const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength />
    <d:getlastmodified />
    <d:getcontenttype />
    <d:resourcetype />
  </d:prop>
</d:propfind>`;

/** `GET /ocs/v2.php/cloud/user?format=json` → `{ ocs: { meta, data } }`. */
interface OcsUserResponse {
  ocs?: {
    meta?: { status?: unknown; statuscode?: unknown; message?: unknown };
    data?: {
      id?: unknown;
      displayname?: unknown;
      "display-name"?: unknown;
      quota?: NextcloudQuota;
    };
  };
}

export class NextcloudAdapter implements PackIntegrationAdapter {
  readonly key = "nextcloud";
  readonly label = "Nextcloud";

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly appPassword: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;

  constructor(opts: NextcloudAdapterOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    this.username = (opts.username ?? "").trim();
    this.appPassword = opts.appPassword ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * Reachability and auth, reported rather than thrown.
   *
   * `/ocs/v2.php/cloud/user` is the cheapest authenticated call Nextcloud
   * has: it needs valid credentials but no privilege on any file, and it
   * touches no storage backend. So a green answer here means "host up,
   * credentials accepted" and nothing else — a red `listFolder()` after a
   * green probe is then unambiguously a path or permissions problem, which is
   * a different conversation with the operator.
   *
   * The display name and the quota are reported back because they are the two
   * facts that tell an operator they authenticated as the account they *meant*
   * to: a probe that says only "ok" cannot catch a copy-pasted credential
   * belonging to a colleague.
   */
  async testConnection(): Promise<IntegrationStatus> {
    const url = `${this.baseUrl}/ocs/v2.php/cloud/user?format=json`;
    try {
      const res = await this.send(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          // Without this header Nextcloud answers 401 even for correct
          // credentials — it is a CSRF guard, not a formality.
          "OCS-APIRequest": "true",
          Authorization: this.authorization(),
        },
      });
      if (!res.ok) {
        throw new PackIntegrationError(`Verbindungstest: ${describeStatus(res.status, url)}`, res.status);
      }

      const body = await integrationJson<OcsUserResponse>(res, "Verbindungstest");
      const data = body?.ocs?.data;
      const displayName = text(data?.displayname) ?? text(data?.["display-name"]) ?? text(data?.id);
      const quota = describeQuota(data?.quota);
      const who = displayName ? `als "${displayName}"` : "als konfigurierter Benutzer";
      return {
        ok: true,
        message: `Nextcloud erreichbar, angemeldet ${who}${quota ? `. ${quota}` : "."}`,
        // Deliberately no `version`: the user endpoint does not report one,
        // and a second round-trip to /cloud/capabilities would make the
        // cheapest probe we have twice as expensive for a cosmetic field.
      };
    } catch (err) {
      // Reported, never thrown: the Settings UI asks "does this work?" and an
      // exception there would be an outage in the page rather than an answer.
      return { ok: false, message: errorText(err) };
    }
  }

  /**
   * One folder's direct children.
   *
   * `Depth: 1` is the whole reason this is one call: it returns the folder
   * itself plus its immediate children and nothing deeper. `Depth: infinity`
   * would walk the entire tree in one request, which Nextcloud disables by
   * default anyway, and which would be the wrong thing to ask for even if it
   * did not — a knowledge folder can hold a hundred thousand files.
   */
  async listFolder(path = "/"): Promise<NextcloudEntry[]> {
    const url = this.fileUrl(path);
    const res = await this.send(url, {
      method: "PROPFIND",
      headers: {
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
        Authorization: this.authorization(),
      },
      body: PROPFIND_BODY,
    });
    if (!res.ok) {
      throw new PackIntegrationError(`Ordnerinhalt: ${describeStatus(res.status, url)}`, res.status);
    }

    const xml = await res.text();
    if (!/<(?:[A-Za-z0-9_.-]+:)?multistatus[\s>]/i.test(xml)) {
      // An HTML login page with status 200 is what a misconfigured reverse
      // proxy returns; saying "no multistatus" is more actionable than
      // silently returning an empty folder.
      throw new PackIntegrationError(
        `Ordnerinhalt: die Antwort war kein WebDAV-Multistatus (HTTP ${res.status}). Zeigt die Basis-URL wirklich auf die Nextcloud-Instanz?`,
        res.status,
      );
    }

    const self = normalisePath(path);
    const entries: NextcloudEntry[] = [];
    for (const block of matchAll(xml, RESPONSE_RE)) {
      const entry = this.toEntry(block);
      // `Depth: 1` always includes the requested collection itself. A caller
      // asking "what is in this folder" does not want the folder in the list,
      // and a recursive walker that kept it would never terminate.
      if (entry === undefined || entry.path === self) continue;
      entries.push(entry);
    }
    return entries;
  }

  /**
   * One file as text, with a hard ceiling on the bytes taken off the wire.
   *
   * The cap is checked twice on purpose: once against `Content-Length`, so an
   * oversized file is refused before a single byte of it is read, and once
   * while streaming, because `Content-Length` is absent on a chunked response
   * and a header is in any case a claim by the server rather than a fact. A
   * cap that trusted the header would be a cap an oversized response could
   * simply lie its way past.
   */
  async downloadText(path: string, maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES): Promise<string> {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_DOWNLOAD_BYTES;
    const url = this.fileUrl(path);
    const res = await this.send(url, {
      method: "GET",
      headers: { Accept: "*/*", Authorization: this.authorization() },
    });
    if (!res.ok) {
      throw new PackIntegrationError(`Datei laden: ${describeStatus(res.status, url)}`, res.status);
    }

    const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
      await cancelBody(res);
      throw new PackIntegrationError(tooLargeMessage(path, limit, declared));
    }

    const bytes = await readCapped(res, limit, path);
    // `fatal: false` on purpose: a document in Latin-1 would otherwise throw
    // instead of coming back with a few replacement characters, and a mostly
    // readable document is worth more to a reader than an exception.
    return new TextDecoder("utf-8").decode(bytes);
  }

  /**
   * `Authorization: Basic base64(username:appPassword)`.
   *
   * Built per request and never stored anywhere a logger could reach. The
   * completeness check is here rather than in the constructor because a
   * half-configured integration must reach the operator through
   * `testConnection()`'s report, not as an exception thrown while the
   * Settings page renders.
   */
  private authorization(): string {
    if (this.username === "" || this.appPassword === "") {
      throw new PackIntegrationError(
        "Die Nextcloud-Zugangsdaten sind nicht vollständig konfiguriert (Benutzername und App-Passwort werden benötigt).",
      );
    }
    // A colon in the username would silently shift the split point in Basic
    // auth and send part of the name as the password. Nextcloud does not
    // allow one in a uid, so this is a configuration mistake worth naming.
    if (this.username.includes(":")) {
      throw new PackIntegrationError('Der Nextcloud-Benutzername darf keinen Doppelpunkt (":") enthalten.');
    }
    return `Basic ${Buffer.from(`${this.username}:${this.appPassword}`, "utf-8").toString("base64")}`;
  }

  /** The WebDAV root for this account, without a trailing slash. */
  private get davRoot(): string {
    return `${this.baseUrl}/remote.php/dav/files/${encodeURIComponent(this.username)}`;
  }

  /**
   * The absolute URL of a path below the user's files root.
   *
   * Each segment is percent-encoded separately: a space must become `%20` and
   * "Angebote Müller" must become `Angebote%20M%C3%BCller`, but the slashes
   * between segments must survive as slashes — encoding the whole path in one
   * go would turn them into `%2F` and address a single file with a slash in
   * its name, which is a 404 at best.
   */
  private fileUrl(path: string): string {
    const rel = encodePath(path);
    return rel === "" ? `${this.davRoot}/` : `${this.davRoot}/${rel}`;
  }

  /**
   * One request through the shared timeout wrapper, with the credential
   * scrubbed out of anything the transport throws.
   *
   * `integrationFetch()` turns a transport failure into
   * `Nicht erreichbar: ${err.message}`, and that message is written by the
   * fetch implementation, not by us — an HTTP client that includes the
   * outgoing headers in its error text would hand the Authorization header
   * straight to a log line. That is precisely the failure the contract's
   * "never log a credential" rule exists to prevent, and it is not a failure
   * the caller can be expected to remember to guard against, so it is guarded
   * here, once, on the only path out of this class.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      // The secrets are handed to the helper as well as scrubbed below: the
      // helper covers every adapter uniformly, this class's own `redact`
      // covers the paths that do not go through it. Belt and braces on the
      // one thing that must not leak.
      return await integrationFetch(this.fetchImpl, url, init, this.timeoutMs, [
        this.appPassword,
        this.authorization(),
      ]);
    } catch (err) {
      throw this.redact(err);
    }
  }

  /** Replaces the app password, in either spelling, with a marker. */
  private redact(err: unknown): unknown {
    if (this.appPassword === "") return err;
    // Both spellings: the plain secret, and the base64 of "user:secret" that
    // the Authorization header actually carries.
    const encoded = Buffer.from(`${this.username}:${this.appPassword}`, "utf-8").toString("base64");
    const scrub = (value: string): string => value.split(this.appPassword).join("***").split(encoded).join("***");
    if (err instanceof PackIntegrationError) {
      return new PackIntegrationError(scrub(err.message), err.status);
    }
    if (err instanceof Error) {
      // A fresh error rather than a mutated one: the original's `stack` also
      // embeds the message, and rewriting only `.message` would leave the
      // secret visible to anything that prints a stack trace.
      return new PackIntegrationError(scrub(err.message));
    }
    return err;
  }

  /** One `d:response` block → an entry, or `undefined` if it has no href. */
  private toEntry(block: string): NextcloudEntry | undefined {
    const rawHref = firstElementText(block, "href");
    if (rawHref === undefined) return undefined;
    const href = decodeHref(rawHref);
    const path = this.relativePath(href);

    const props = okProps(block);
    const resourceType = elementInner(props, "resourcetype") ?? "";
    const contentType = text(firstElementText(props, "getcontenttype")) ?? null;
    const isFolder =
      /<(?:[A-Za-z0-9_.-]+:)?collection[\s/>]/i.test(resourceType) || contentType === "httpd/unix-directory";

    // An empty element (`<d:getcontentlength/>`) is "no value", but
    // `Number("")` is 0 — the one place where being relaxed about types would
    // turn "unknown size" into the confident claim "zero bytes".
    const lengthText = firstElementText(props, "getcontentlength")?.trim();
    const size = lengthText === undefined || lengthText === "" ? Number.NaN : Number(lengthText);
    const modifiedText = firstElementText(props, "getlastmodified")?.trim();
    const modified = modifiedText === undefined || modifiedText === "" ? Number.NaN : Date.parse(modifiedText);

    const segments = path.split("/").filter((s) => s !== "");
    return {
      // The root of the account has no last segment; the account name is the
      // only honest thing to call it.
      name: segments.length > 0 ? (segments[segments.length - 1] as string) : this.username,
      path,
      // A folder carries no `d:getcontentlength` at all, and the property may
      // also be reported in a 404 propstat. "Absent" is not "zero bytes".
      sizeBytes: Number.isFinite(size) ? size : null,
      lastModifiedAt: Number.isFinite(modified) ? modified : null,
      contentType,
      isFolder,
    };
  }

  /**
   * A `d:href` from the response → a path relative to the user's files root.
   *
   * The href is server-absolute (`/remote.php/dav/files/anna/Wissen/`), so
   * the known prefix is stripped. If it does not match — which is what a
   * reverse proxy that rewrites paths would cause — the href is returned
   * as-is rather than mangled into something that looks right and is not.
   */
  private relativePath(href: string): string {
    const rootPath = decodeHref(new URL(this.davRoot).pathname);
    const withoutHost = href.startsWith("http") ? safeUrlPath(href) : href;
    const rest = withoutHost.startsWith(rootPath) ? withoutHost.slice(rootPath.length) : withoutHost;
    return normalisePath(rest);
  }
}

/* ------------------------------------------------------------------ *
 * XML
 *
 * WHY THERE IS NO XML PARSER HERE
 *
 * The repository has no XML parser (`fast-xml-parser`, `xml2js` and friends
 * are all absent from package.json; `@xmldom/xmldom` appears only as a
 * transitive pin, which is not a dependency this code may import). Adding one
 * for this would be a new supply-chain dependency, a new audit obligation and
 * a new attack surface — general XML parsers are where XXE, billion-laughs
 * and namespace-confusion bugs live — in exchange for parsing one response
 * shape that RFC 4918 fixes and Nextcloud has not changed.
 *
 * So this reads exactly the subset it needs and nothing else: it never
 * resolves an entity, never follows a DOCTYPE, never expands a reference, and
 * an element it does not recognise is simply not looked at. The regexes are
 * prefix-agnostic (`d:`, `D:` or no prefix all match) because the prefix is a
 * document-local choice a server is free to change, and they tolerate
 * self-closing forms because `<d:getcontentlength />` is what an empty
 * property looks like.
 *
 * The one rule that is not cosmetic is `okProps()`: RFC 4918 §13 says a
 * `d:response` carries one `d:propstat` per status, so a property the server
 * does not have for this resource comes back inside a `404 Not Found`
 * propstat rather than being absent. Reading properties out of the whole
 * block would read those too and report a 404 marker as a value.
 * ------------------------------------------------------------------ */

const RESPONSE_RE = /<(?:[A-Za-z0-9_.-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?response\s*>/gi;
const PROPSTAT_RE = /<(?:[A-Za-z0-9_.-]+:)?propstat(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?propstat\s*>/gi;

function matchAll(xml: string, re: RegExp): string[] {
  // A fresh RegExp per call: a module-level /g regex carries `lastIndex`
  // between calls and would skip half the entries on the second listing.
  const local = new RegExp(re.source, re.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = local.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

/** Builds the matcher for one element by local name, prefix-agnostic. */
function elementRe(localName: string): RegExp {
  // The `(?=[\s/>])` lookahead is what keeps `getcontenttype` from matching
  // when `getcontentlength` was asked for.
  return new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}(?=[\\s/>])(?:[^>]*?/>|[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}\\s*>)`,
    "i",
  );
}

/** The inner XML of the first matching element, unescaped-free (raw). */
function elementInner(xml: string, localName: string): string | undefined {
  const m = elementRe(localName).exec(xml);
  if (m === null) return undefined;
  return m[1] ?? "";
}

/** The text of the first matching element, with XML entities resolved. */
function firstElementText(xml: string, localName: string): string | undefined {
  const inner = elementInner(xml, localName);
  return inner === undefined ? undefined : unescapeXml(inner);
}

/**
 * The concatenated `d:prop` bodies of every 2xx `d:propstat` in a response.
 *
 * A propstat with no `d:status` at all is accepted: the status is required by
 * the RFC, and a server that omits it has given us a property list with no
 * reason to distrust it. A propstat with a non-2xx status is dropped, which
 * is the "missing optional property" case — Nextcloud reports an absent
 * `d:getcontentlength` on a folder that way.
 */
function okProps(responseBlock: string): string {
  const parts: string[] = [];
  for (const propstat of matchAll(responseBlock, PROPSTAT_RE)) {
    const status = firstElementText(propstat, "status");
    if (status !== undefined) {
      const code = /\b([1-5]\d\d)\b/.exec(status);
      if (code !== null && !code[1]!.startsWith("2")) continue;
    }
    parts.push(elementInner(propstat, "prop") ?? "");
  }
  return parts.join("\n");
}

/**
 * The five predefined XML entities plus numeric references.
 *
 * Only these five: a general entity defined in a DOCTYPE is exactly the
 * billion-laughs vector, and this parser resolving one would be this parser
 * volunteering for it. Anything else is left as literal text.
 */
function unescapeXml(value: string): string {
  return (
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // `&amp;` last, so "&amp;lt;" stays the literal text "&lt;" rather than
      // being resolved twice into "<".
      .replace(/&amp;/g, "&")
  );
}

function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/* ------------------------------------------------------------------ *
 * Paths, bytes and messages
 * ------------------------------------------------------------------ */

/**
 * A caller's path → the encoded, root-relative part of a WebDAV URL.
 *
 * `..` is rejected rather than resolved. The user's files root is the whole
 * security boundary this adapter has, and a path assembled from a document's
 * own contents ("see ../../.ssh/id_rsa") must not be able to walk out of it.
 */
function encodePath(path: string): string {
  const segments = String(path ?? "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new PackIntegrationError(
      'Der Pfad darf kein ".." enthalten — Zugriffe außerhalb des Benutzerordners sind nicht erlaubt.',
    );
  }
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** "Wissen/Angebote/" → "/Wissen/Angebote"; "" and "/" → "/". */
function normalisePath(path: string): string {
  const segments = String(path ?? "")
    .split("/")
    .filter((s) => s !== "");
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** A href may be percent-encoded and XML-escaped; both have to come off. */
function decodeHref(href: string): string {
  const unescaped = unescapeXml(href).trim();
  try {
    return decodeURIComponent(unescaped);
  } catch {
    // A stray "%" that is not an escape makes decodeURIComponent throw. The
    // raw href is still a usable path; a thrown listing is not.
    return unescaped;
  }
}

function safeUrlPath(href: string): string {
  try {
    return new URL(href).pathname;
  } catch {
    return href;
  }
}

/** Reads a body, stopping the moment it exceeds `limit`. */
async function readCapped(res: Response, limit: number, path: string): Promise<Uint8Array> {
  const body = res.body;
  if (body === null || body === undefined || typeof body.getReader !== "function") {
    // No stream to read incrementally (an older fetch shim, or a test
    // double). The cap is still enforced — just after the fact rather than
    // before, which is the best a non-streaming body allows.
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.byteLength > limit) throw new PackIntegrationError(tooLargeMessage(path, limit, buffer.byteLength));
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        // Cancel rather than break: an abandoned stream keeps the socket and
        // the server keeps sending the other 4 GB.
        await reader.cancel().catch(() => undefined);
        throw new PackIntegrationError(tooLargeMessage(path, limit, null));
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already have given up its lock. Failing to
      // release it must not replace the real error with a bookkeeping one.
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel?.();
  } catch {
    // Nothing to do: we are already on the way out with a readable error, and
    // failing to cancel a body must not replace it with a worse one.
  }
}

function tooLargeMessage(path: string, limit: number, actual: number | null): string {
  const size = actual === null ? "sie überschreitet das Limit" : `sie ist ${formatBytes(actual)} groß`;
  return `Die Datei "${path}" wurde nicht geladen: ${size}, erlaubt sind höchstens ${formatBytes(limit)}.`;
}

/**
 * What an operator can act on, per status.
 *
 * 401 and 403 look identical in a log and need opposite fixes: 401 is "these
 * credentials are not valid", 403 is "they are valid but may not do this" —
 * on Nextcloud usually a folder shared read-only, or an app password whose
 * scope was restricted to filesystem access the account does not have.
 */
function describeStatus(status: number, url: string): string {
  if (status === 401) {
    return "Die Zugangsdaten wurden nicht akzeptiert (HTTP 401). Benutzername und App-Passwort prüfen — das App-Passwort ist ungültig oder wurde widerrufen. Bei aktivierter Zwei-Faktor-Authentifizierung funktioniert nur ein App-Passwort, nicht das Konto-Passwort.";
  }
  if (status === 403) {
    return "Die Zugangsdaten sind gültig, haben aber keine Berechtigung für diesen Zugriff (HTTP 403). Fehlt dem Konto der Lesezugriff auf diesen Ordner?";
  }
  if (status === 404) {
    return `Nicht gefunden (HTTP 404): ${url}. Gibt es diesen Pfad im Benutzerordner, und stimmt der Benutzername in der WebDAV-Adresse?`;
  }
  if (status === 405) {
    return `Die Methode ist an dieser Adresse nicht erlaubt (HTTP 405): ${url}. Das deutet darauf hin, dass die Basis-URL nicht auf eine Nextcloud-Instanz zeigt oder ein Proxy WebDAV-Methoden blockiert.`;
  }
  if (status >= 500) {
    return `Nextcloud hat mit HTTP ${status} geantwortet (${url}). Das ist ein Fehler auf dem Server, nicht in der Konfiguration.`;
  }
  return `Unerwartete Antwort HTTP ${status} von ${url}.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Quota is reported as a sentence only when the numbers are actually there. */
function describeQuota(quota: NextcloudQuota | undefined): string {
  const used = finiteNumber(quota?.used);
  const total = finiteNumber(quota?.total);
  if (used === null) return "";
  // Nextcloud reports an unlimited quota as a negative `total`
  // (FileInfo::SPACE_UNLIMITED), which must not be printed as a size.
  if (total === null || total <= 0) return `Belegt: ${formatBytes(used)} (kein Kontingent gesetzt).`;
  return `Belegt: ${formatBytes(used)} von ${formatBytes(total)}.`;
}

interface NextcloudQuota {
  free?: unknown;
  used?: unknown;
  total?: unknown;
  quota?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
