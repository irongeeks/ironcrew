/**
 * IronCrew — what a browser action costs in trust.
 *
 * A browser is the most dangerous tool an agent can hold, and the reason is
 * not that it is powerful but that its actions look alike. Reading a page and
 * clicking "Kaufen" are the same three lines of Playwright. A tool that
 * treated them the same would have to be either useless (everything gated) or
 * reckless (nothing gated), and in practice a company that gates everything
 * turns the gate off within a week.
 *
 * So actions are classified, and the classification lives here — as pure
 * functions with no Playwright import — so the policy can be read, tested and
 * reasoned about without launching a browser. `browser-tool.ts` performs the
 * actions; this file decides what they mean.
 */

export const PAGE_ACTIONS = [
  "navigate",
  "readText",
  "screenshot",
  "click",
  "type",
  "select",
  "submit",
  "download",
  "upload",
] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

/**
 * read      observes only; nothing outside changes.
 * interact  changes page state but stays inside the page.
 * external  causes something outside to treat the act as real.
 */
export const PAGE_ACTION_RISK = {
  navigate: "read",
  readText: "read",
  screenshot: "read",
  click: "interact",
  type: "interact",
  select: "interact",
  submit: "external",
  download: "external",
  upload: "external",
} as const satisfies Record<PageAction, "read" | "interact" | "external">;

export type PageActionRisk = (typeof PAGE_ACTION_RISK)[PageAction];

export function isPageAction(value: unknown): value is PageAction {
  return (PAGE_ACTIONS as readonly string[]).includes(value as string);
}

/**
 * The risk of an action, defaulting to the worst one.
 *
 * An unknown action name is treated as `external` rather than rejected or
 * assumed harmless. A caller that invented an action this module has never
 * heard of is exactly the case where guessing "probably fine" is wrong.
 */
export function classifyAction(action: string): PageActionRisk {
  return isPageAction(action) ? PAGE_ACTION_RISK[action] : "external";
}

/**
 * Whether an action needs an approval before it happens.
 *
 * `submit` is `external` even when the form is obviously a search box. This
 * module cannot tell a search from a checkout — both are a form and a button —
 * so it has to assume the one that costs money. An operator who disagrees for
 * a specific agent can waive it in that agent's tool grant, which is a
 * decision someone wrote down rather than an assumption this file made.
 */
export function requiresApproval(action: string, opts: { waived?: boolean } = {}): boolean {
  if (classifyAction(action) !== "external") return false;
  return opts.waived !== true;
}

/** The tool key each action is gated by in the tool registry (domain/tool-store.ts). */
export function toolKeyFor(action: string): string {
  return `browser.${classifyAction(action)}`;
}
