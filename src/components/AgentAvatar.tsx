import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Agent } from "../types";

/** Map agent IDs to sprite numbers (stable order, same as OfficeView) */
const MAX_SPRITE_NUMBER = 14;
const CHARACTER_COUNT = 40;
const CHARACTER_PRIMARY_BASE = "/assets/characters";
const CHARACTER_FALLBACK_BASE = "/assets/2D Top Down Pixel Art Characters";

export function buildSpriteMap(agents: Agent[]): Map<string, number> {
  const map = new Map<string, number>();
  // 1) Agents with sprite_number set in DB take priority
  for (const a of agents) {
    if (a.sprite_number != null && a.sprite_number > 0) map.set(a.id, a.sprite_number);
  }
  // 2) DORO fallback (when sprite_number is unset)
  const doro = agents.find((a) => a.name === "DORO");
  if (doro && !map.has(doro.id)) map.set(doro.id, 13);
  // 3) Remaining: auto-assign (cycle 1-12)
  const rest = [...agents].filter((a) => !map.has(a.id)).sort((a, b) => a.id.localeCompare(b.id));
  rest.forEach((a, i) => map.set(a.id, (i % MAX_SPRITE_NUMBER) + 1));
  return map;
}

/** Hook: memoized sprite map from agents array */
export function useSpriteMap(agents: Agent[]): Map<string, number> {
  return useMemo(() => buildSpriteMap(agents), [agents]);
}

function hashIdToSprite(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return (hash % MAX_SPRITE_NUMBER) + 1;
}

function resolveSpriteNum(agent: Agent | undefined, spriteMap: Map<string, number>): number | undefined {
  if (!agent) return undefined;
  if (agent.sprite_number != null && agent.sprite_number > 0) return agent.sprite_number;
  const mapped = spriteMap.get(agent.id);
  if (mapped != null && mapped > 0) return mapped;
  if (agent.name === "DORO") return 13;
  return hashIdToSprite(agent.id);
}

/** Stable hash used by RetroOfficeView character assignment */
export function stableAgentHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h + s.charCodeAt(i) * (i + 1)) | 0;
  return Math.abs(h);
}

/** Office-aligned character sheet index (000.png–039.png) */
export function resolveAgentCharacterIndex(agent: Agent | undefined): number | undefined {
  if (!agent) return undefined;
  if (agent.sprite_number != null && agent.sprite_number >= 0 && agent.sprite_number < CHARACTER_COUNT) {
    return agent.sprite_number;
  }
  return stableAgentHash(agent.id) % CHARACTER_COUNT;
}

export function buildCharacterImagePath(charIndex: number, basePath = CHARACTER_PRIMARY_BASE): string {
  const padded = String(charIndex).padStart(3, "0");
  return `${basePath}/${padded}.png`;
}

interface AgentAvatarProps {
  agent: Agent | undefined;
  agents?: Agent[];
  spriteMap?: Map<string, number>;
  size?: number;
  className?: string;
  rounded?: "full" | "xl" | "2xl";
  imageFit?: "cover" | "contain";
  imagePosition?: CSSProperties["objectPosition"];
}

/** Sprite-based avatar — pass either `agents` or `spriteMap` */
export default function AgentAvatar({
  agent,
  agents,
  spriteMap,
  size = 28,
  className = "",
  rounded = "full",
  imageFit = "cover",
  imagePosition = "center",
}: AgentAvatarProps) {
  // Keep legacy map path for callers that still rely on it, but prefer office-aligned character mapping.
  const legacyMap = spriteMap ?? (agents ? buildSpriteMap(agents) : new Map());
  const legacySpriteNum = resolveSpriteNum(agent, legacyMap);
  const characterIndex =
    resolveAgentCharacterIndex(agent) ?? (legacySpriteNum != null ? Math.max(0, legacySpriteNum) : undefined);
  const [imageFailed, setImageFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(
    characterIndex != null ? buildCharacterImagePath(characterIndex) : null,
  );
  useEffect(() => {
    setImageFailed(false);
    setSrc(characterIndex != null ? buildCharacterImagePath(characterIndex) : null);
  }, [characterIndex, agent?.id]);

  const roundedClass = rounded === "full" ? "rounded-full" : rounded === "xl" ? "rounded-xl" : "rounded-2xl";

  if (characterIndex != null && src && !imageFailed) {
    return (
      <div
        className={`${roundedClass} overflow-hidden flex-shrink-0 ${className}`}
        style={{ width: size, height: size, background: "var(--th-bg-surface-hover)" }}
      >
        <img
          src={src}
          alt={agent?.name ?? ""}
          className={`w-full h-full ${imageFit === "contain" ? "object-contain" : "object-cover"}`}
          style={{ imageRendering: "pixelated", objectPosition: imagePosition }}
          onError={() => {
            if (src.includes(CHARACTER_PRIMARY_BASE)) {
              setSrc(buildCharacterImagePath(characterIndex, CHARACTER_FALLBACK_BASE));
              return;
            }
            setImageFailed(true);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className={`${roundedClass} flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.6, background: "var(--th-bg-surface-hover)" }}
    >
      {agent?.avatar_emoji ?? "🤖"}
    </div>
  );
}
