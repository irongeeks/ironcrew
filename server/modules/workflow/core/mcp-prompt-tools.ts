import type { McpManager } from "../../../connectors/built-in/mcp/mcp-manager.ts";

/** Strip control characters and newlines to prevent prompt injection via external metadata. */
function sanitize(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "").trim();
}

/**
 * Build a prompt block listing all connected MCP servers and their available tools.
 * Returns an empty string if no MCP servers are connected or have tools.
 *
 * NOTE: These tools are executed by the office's connector system, not by the
 * agent directly. The prompt informs agents which capabilities exist so they
 * can request connector-based execution via pack phases or task artifacts.
 */
export function buildMcpToolsPromptBlock(mcpManager: McpManager | undefined): string {
  if (!mcpManager) return "";

  const statuses = mcpManager.getStatuses().filter((s) => s.connected && s.tools.length > 0);
  if (statuses.length === 0) return "";

  const lines = ["[Available Office MCP Tools]"];
  for (const server of statuses) {
    const label = sanitize(server.label || server.name);
    const toolNames = server.tools.map((t) => sanitize(t.name)).join(", ");
    lines.push(`  Server "${label}" (${server.transport}): ${toolNames}`);
  }
  lines.push(
    "[MCP Usage] These tools are managed by the office connector system. " +
      "They are executed server-side when referenced by pack phases with capability_mode: server or hybrid. " +
      "You do not invoke them directly — reference them in task artifacts or phase outputs when relevant.",
  );
  return lines.join("\n");
}
