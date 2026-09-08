import sanitizeHtml from "sanitize-html";

// Concept HTML is untrusted data, never executable application code. Keep ordinary
// HTML/CSS layouts, but discard foreign namespaces and active embedded documents.
export const siteContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; font-src 'self'; media-src 'self' https:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const siteResponseSecurityPolicy = siteContentSecurityPolicy + "; frame-ancestors 'none'";
export const sitePolicyMeta = `<meta http-equiv="Content-Security-Policy" content="${siteContentSecurityPolicy}">`;

export function safeSiteHtml(html: string): { body: string; bodyAttributes: string; styles: string; document: string } {
  const clean = sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "html",
      "head",
      "body",
      "title",
      "style",
      "img",
      "picture",
      "source",
      "video",
      "audio",
      "details",
      "summary",
      "button",
    ],
    allowedAttributes: {
      "*": ["id", "class", "title", "lang", "dir", "role", "aria-*", "style", "hidden"],
      a: ["href", "target", "rel"],
      img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "decoding"],
      source: ["src", "srcset", "sizes", "type", "media"],
      video: ["src", "poster", "width", "height", "controls", "muted", "loop", "playsinline"],
      audio: ["src", "controls", "muted", "loop"],
      details: ["open"],
      button: ["type", "disabled"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
      ol: ["start", "reversed"],
      li: ["value"],
      time: ["datetime"],
    },
    allowedSchemes: ["https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https"], source: ["https"], video: ["https"], audio: ["https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "poster"],
    allowProtocolRelative: false,
    nonTextTags: ["script", "textarea", "option", "noscript", "svg", "math", "iframe", "object", "embed", "template"],
    // Styles are intentional design data. CSP permits inline CSS, but disallows
    // remote stylesheets, executable URLs, embedded documents and network APIs.
    allowVulnerableTags: true,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "noopener noreferrer" } }),
      button: (tagName, attribs) => ({ tagName, attribs: { ...attribs, type: "button" } }),
    },
  });
  const styles = [...clean.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1]!.replaceAll("<", "\\3c "))
    .join("\n");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(clean)?.[1] ?? "Website";
  const bodyAttributes = /<body([^>]*)>/.exec(clean)?.[1] ?? "";
  const body = (/<body[^>]*>([\s\S]*?)<\/body>/.exec(clean)?.[1] ?? clean)
    .replace(/<head[^>]*>[\s\S]*?<\/head>/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<\/?(?:html|body)[^>]*>/g, "");
  return {
    body,
    bodyAttributes,
    styles,
    document: `<!doctype html><html lang="de"><head><meta charset="utf-8">${sitePolicyMeta}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${styles}</style></head><body${bodyAttributes}>${body}</body></html>\n`,
  };
}
