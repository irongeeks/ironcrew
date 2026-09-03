import type { Phase } from "./pack-schema.ts";

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class PackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackValidationError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PackGraph {
  packKey: string;
  phases: Phase[]; // topologically sorted
  adjacency: Map<string, string[]>; // phase → downstream phase IDs
  reverseAdjacency: Map<string, string[]>; // phase → upstream phase IDs
  roots: string[]; // phases with no upstream (ignoring pack inputs)
  terminals: string[]; // phases with no downstream consumers
}

export interface ParsedInputRef {
  sourcePhaseId: string;
  outputName: string;
  isWildcard: boolean; // ends with .*
  indexPlaceholder: boolean; // contains [{n}]
  jsonPath: string | undefined; // sub-path after output name (e.g., ".scenes.length")
  isPackInput: boolean; // starts with "input."
}

// ---------------------------------------------------------------------------
// parseInputRef
// ---------------------------------------------------------------------------

/**
 * Parse an input `from` reference string into its constituent parts.
 *
 * Supported forms:
 *   "concept.concept_doc"                       — plain phase.output
 *   "image_generation.image.*"                  — wildcard fan-in
 *   "screenplay.shot_list.scenes[{n}]"           — index placeholder (fan-out expansion)
 *   "screenplay.shot_list.scenes.length"         — json sub-path
 *   "input.depth"                               — pack-level input field
 */
export function parseInputRef(ref: string): ParsedInputRef {
  const parts = ref.split(".");

  const sourcePhaseId = parts[0];
  const isPackInput = sourcePhaseId === "input";

  // Output name is always the second segment
  const outputName = parts[1] ?? "";

  // Everything after the second segment forms an optional sub-path
  const remainingParts = parts.slice(2);

  // Reconstruct remaining — note: split on "." loses the bracket syntax, so we
  // need to re-join carefully. We split on "." but "[{n}]" may contain dots
  // inside brackets in more complex cases. For our supported syntax the ref
  // is dot-separated and bracket notation is a single segment.
  const remainingRaw = remainingParts.join(".");

  // Detect wildcard: last segment is exactly "*"
  const isWildcard = remainingRaw === "*" || (remainingParts.length === 1 && remainingParts[0] === "*");

  // Detect index placeholder: presence of [{n}] anywhere in the ref
  const indexPlaceholder = ref.includes("[{n}]");

  // jsonPath: only present when there are remaining parts beyond phase.output,
  // and it is not a bare wildcard (which is represented as isWildcard=true with no jsonPath)
  let jsonPath: string | undefined;
  if (remainingRaw && !isWildcard) {
    jsonPath = "." + remainingRaw;
  }

  return {
    sourcePhaseId,
    outputName,
    isWildcard,
    indexPlaceholder,
    jsonPath,
    isPackInput,
  };
}

// ---------------------------------------------------------------------------
// assertReferentialIntegrity
// ---------------------------------------------------------------------------

/**
 * Verify every non-pack-input `from` reference points to an existing phase
 * and output name (wildcards and sub-paths are allowed as long as the base
 * phase + output exist).
 */
export function assertReferentialIntegrity(phases: Phase[]): void {
  const phaseMap = new Map<string, Phase>(phases.map((p) => [p.id, p]));

  for (const phase of phases) {
    for (const input of phase.inputs) {
      const parsed = parseInputRef(input.from);

      // Pack input references are not validated against phase outputs
      if (parsed.isPackInput) {
        continue;
      }

      const sourcePhase = phaseMap.get(parsed.sourcePhaseId);
      if (!sourcePhase) {
        throw new PackValidationError(
          `Phase "${phase.id}" references unknown phase "${parsed.sourcePhaseId}" in input "${input.name}" (from: "${input.from}")`,
        );
      }

      const outputExists = sourcePhase.outputs.some((o) => o.name === parsed.outputName);
      if (!outputExists) {
        throw new PackValidationError(
          `Phase "${phase.id}" references unknown output "${parsed.outputName}" on phase "${parsed.sourcePhaseId}" in input "${input.name}" (from: "${input.from}")`,
        );
      }
    }
  }

  // Validate on_review_fail.rerun references
  for (const phase of phases) {
    if (phase.on_review_fail?.rerun) {
      const targetId = phase.on_review_fail.rerun;
      if (!phaseMap.has(targetId)) {
        throw new PackValidationError(
          `Phase "${phase.id}" has on_review_fail.rerun referencing unknown phase "${targetId}"`,
        );
      }

      // Validate that the rerun target is an upstream (direct or transitive) dependency.
      // BFS backwards from the current phase through input references to find all ancestors.
      if (targetId !== phase.id) {
        const ancestors = new Set<string>();
        const queue: string[] = [];

        // Seed with direct upstream phases from inputs
        for (const input of phase.inputs) {
          const parsed = parseInputRef(input.from);
          if (!parsed.isPackInput && phaseMap.has(parsed.sourcePhaseId) && !ancestors.has(parsed.sourcePhaseId)) {
            ancestors.add(parsed.sourcePhaseId);
            queue.push(parsed.sourcePhaseId);
          }
        }

        // BFS to collect all transitive ancestors
        while (queue.length > 0) {
          const current = queue.shift()!;
          const currentPhase = phaseMap.get(current);
          if (!currentPhase) continue;
          for (const input of currentPhase.inputs) {
            const parsed = parseInputRef(input.from);
            if (!parsed.isPackInput && phaseMap.has(parsed.sourcePhaseId) && !ancestors.has(parsed.sourcePhaseId)) {
              ancestors.add(parsed.sourcePhaseId);
              queue.push(parsed.sourcePhaseId);
            }
          }
        }

        if (!ancestors.has(targetId)) {
          throw new PackValidationError(
            `Phase "${phase.id}" has on_review_fail.rerun targeting "${targetId}" which is not an upstream dependency. ` +
              `The rerun target must be a direct or transitive dependency of the current phase.`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// assertAcyclic
// ---------------------------------------------------------------------------

/**
 * DFS-based cycle detection. Throws PackValidationError if any cycle is found.
 */
export function assertAcyclic(adjacency: Map<string, string[]>): void {
  // Three-color DFS: white (0) = unvisited, grey (1) = in-stack, black (2) = done
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;

  const color = new Map<string, 0 | 1 | 2>();
  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  const dfs = (node: string): void => {
    color.set(node, GREY);
    for (const neighbor of adjacency.get(node) ?? []) {
      const neighborColor = color.get(neighbor) ?? WHITE;
      if (neighborColor === GREY) {
        throw new PackValidationError(`Cycle detected in pack graph involving phase "${neighbor}"`);
      }
      if (neighborColor === WHITE) {
        dfs(neighbor);
      }
    }
    color.set(node, BLACK);
  };

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      dfs(node);
    }
  }
}

// ---------------------------------------------------------------------------
// assertNoOrphans
// ---------------------------------------------------------------------------

/**
 * Verify there are no disconnected orphan phases in the pack.
 *
 * An orphan is a phase that belongs to an isolated subgraph — it is a root
 * (no upstream) AND a terminal (no downstream) while other phases exist that
 * are also connected to each other. We detect this by checking for connected
 * components: if more than one connected component exists in the undirected
 * view of the graph, phases in smaller components are orphans.
 *
 * Algorithm: build an undirected adjacency from the directed adjacency, then
 * BFS from the first root. If any phase is not visited, it is in a separate
 * component and is therefore an orphan.
 */
export function assertNoOrphans(phases: Phase[], _roots: string[], adjacency: Map<string, string[]>): void {
  if (phases.length <= 1) {
    return;
  }

  // Build undirected adjacency (union of forward and reverse edges)
  const undirected = new Map<string, Set<string>>();
  for (const phase of phases) {
    undirected.set(phase.id, new Set());
  }
  for (const [from, downstreams] of adjacency) {
    for (const to of downstreams) {
      undirected.get(from)?.add(to);
      undirected.get(to)?.add(from);
    }
  }

  // BFS from the first phase in the original list to find all reachable phases
  const startNode = phases[0].id;
  const visited = new Set<string>([startNode]);
  const queue: string[] = [startNode];

  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const neighbor of undirected.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  for (const phase of phases) {
    if (!visited.has(phase.id)) {
      throw new PackValidationError(
        `Phase "${phase.id}" is an orphan — it is disconnected from the rest of the pack graph. ` +
          `Check that it either consumes outputs from another phase or produces outputs consumed by another phase.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// topoSort (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Topologically sort phases using Kahn's algorithm.
 * Returns phase IDs in execution order (roots first, terminals last).
 * Assumes the graph is acyclic (call assertAcyclic first).
 */
export function topoSort(phases: Phase[], adjacency: Map<string, string[]>): string[] {
  // Build in-degree counts
  const inDegree = new Map<string, number>();
  for (const phase of phases) {
    if (!inDegree.has(phase.id)) {
      inDegree.set(phase.id, 0);
    }
  }
  for (const [, downstreams] of adjacency) {
    for (const ds of downstreams) {
      inDegree.set(ds, (inDegree.get(ds) ?? 0) + 1);
    }
  }

  // Seed queue with zero-in-degree nodes (stable ordering by original position)
  const phaseOrder = phases.map((p) => p.id);
  const queue: string[] = phaseOrder.filter((id) => (inDegree.get(id) ?? 0) === 0);

  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);

    // For each downstream, decrement in-degree; if it reaches 0, enqueue
    // Maintain stable order by iterating in original phase order
    const downstreams = adjacency.get(node) ?? [];
    // Sort downstreams by original phase order for deterministic output
    const sortedDownstreams = downstreams.slice().sort((a, b) => phaseOrder.indexOf(a) - phaseOrder.indexOf(b));
    for (const ds of sortedDownstreams) {
      const newDegree = (inDegree.get(ds) ?? 0) - 1;
      inDegree.set(ds, newDegree);
      if (newDegree === 0) {
        queue.push(ds);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/**
 * Build a PackGraph from a pack key and its phase definitions.
 * Runs all validations (referential integrity, acyclicity, orphan detection).
 * Returns a graph with adjacency maps and phases in topological order.
 */
export function buildGraph(packKey: string, phases: Phase[]): PackGraph {
  // Step 1: Referential integrity (phase + output names must exist)
  assertReferentialIntegrity(phases);

  // Step 2: Build adjacency and reverse adjacency maps
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();

  // Initialise empty entries for every phase
  for (const phase of phases) {
    adjacency.set(phase.id, []);
    reverseAdjacency.set(phase.id, []);
  }

  for (const phase of phases) {
    for (const input of phase.inputs) {
      const parsed = parseInputRef(input.from);

      // Pack inputs do not create inter-phase edges
      if (parsed.isPackInput) {
        continue;
      }

      const upstreamId = parsed.sourcePhaseId;
      const downstreamId = phase.id;

      // Add to adjacency (upstream → downstream), avoid duplicates
      const adj = adjacency.get(upstreamId)!;
      if (!adj.includes(downstreamId)) {
        adj.push(downstreamId);
      }

      // Add to reverse adjacency (downstream → upstream), avoid duplicates
      const rev = reverseAdjacency.get(downstreamId)!;
      if (!rev.includes(upstreamId)) {
        rev.push(upstreamId);
      }
    }
  }

  // Step 3: Identify roots (no upstream edges, excluding pack inputs)
  const roots: string[] = [];
  for (const phase of phases) {
    const upstream = reverseAdjacency.get(phase.id) ?? [];
    if (upstream.length === 0) {
      roots.push(phase.id);
    }
  }

  // Step 4: Validate acyclicity
  assertAcyclic(adjacency);

  // Step 5: Validate orphans (only relevant when multiple roots exist)
  assertNoOrphans(phases, roots, adjacency);

  // Step 6: Topological sort
  const sortedIds = topoSort(phases, adjacency);
  const phaseById = new Map<string, Phase>(phases.map((p) => [p.id, p]));
  const sortedPhases = sortedIds.map((id) => phaseById.get(id)!);

  // Step 7: Identify terminals (no downstream edges)
  const terminals: string[] = [];
  for (const phase of phases) {
    const downstream = adjacency.get(phase.id) ?? [];
    if (downstream.length === 0) {
      terminals.push(phase.id);
    }
  }

  return {
    packKey,
    phases: sortedPhases,
    adjacency,
    reverseAdjacency,
    roots,
    terminals,
  };
}
