import { createHash } from "node:crypto";
import type {
  DecisionStateHelperDeps,
  DecisionStateHelpers,
  DecisionStateStatus,
  ProjectReviewDecisionEventInput,
  ProjectReviewDecisionState,
  ReviewRoundDecisionState,
} from "./types.ts";

export function createDecisionStateHelpers(deps: DecisionStateHelperDeps): DecisionStateHelpers {
  const { db, nowMs } = deps;

  function buildProjectReviewSnapshotHash(
    projectId: string,
    reviewTaskChoices: Array<{ id: string; updated_at: number }>,
  ): string {
    const base = [...reviewTaskChoices]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((task) => `${task.id}:${task.updated_at}`)
      .join("|");
    return createHash("sha256").update(`${projectId}|${base}`).digest("hex").slice(0, 24);
  }

  function getProjectReviewDecisionState(projectId: string): ProjectReviewDecisionState | null {
    const row = db
      .prepare(
        `
      SELECT
        project_id,
        snapshot_hash,
        status,
        planner_summary,
        planner_agent_id,
        planner_agent_name,
        created_at,
        updated_at
      FROM project_review_decision_states
      WHERE project_id = ?
    `,
      )
      .get(projectId) as ProjectReviewDecisionState | undefined;
    return row ?? null;
  }

  function upsertProjectReviewDecisionState(
    projectId: string,
    snapshotHash: string,
    status: DecisionStateStatus,
    plannerSummary: string | null,
    plannerAgentId: string | null,
    plannerAgentName: string | null,
  ): void {
    const ts = nowMs();
    db.prepare(
      `
      INSERT INTO project_review_decision_states (
        project_id,
        snapshot_hash,
        status,
        planner_summary,
        planner_agent_id,
        planner_agent_name,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        status = excluded.status,
        planner_summary = excluded.planner_summary,
        planner_agent_id = excluded.planner_agent_id,
        planner_agent_name = excluded.planner_agent_name,
        updated_at = excluded.updated_at
    `,
    ).run(projectId, snapshotHash, status, plannerSummary, plannerAgentId, plannerAgentName, ts, ts);
  }

  function buildReviewRoundSnapshotHash(meetingId: string, reviewRound: number, notes: string[]): string {
    const base = [...notes]
      .map((note) =>
        String(note ?? "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join("|");
    return createHash("sha256").update(`${meetingId}|round=${reviewRound}|${base}`).digest("hex").slice(0, 24);
  }

  function getReviewRoundDecisionState(meetingId: string): ReviewRoundDecisionState | null {
    const row = db
      .prepare(
        `
      SELECT
        meeting_id,
        snapshot_hash,
        status,
        planner_summary,
        planner_agent_id,
        planner_agent_name,
        created_at,
        updated_at
      FROM review_round_decision_states
      WHERE meeting_id = ?
    `,
      )
      .get(meetingId) as ReviewRoundDecisionState | undefined;
    return row ?? null;
  }

  function upsertReviewRoundDecisionState(
    meetingId: string,
    snapshotHash: string,
    status: DecisionStateStatus,
    plannerSummary: string | null,
    plannerAgentId: string | null,
    plannerAgentName: string | null,
  ): void {
    const ts = nowMs();
    db.prepare(
      `
      INSERT INTO review_round_decision_states (
        meeting_id,
        snapshot_hash,
        status,
        planner_summary,
        planner_agent_id,
        planner_agent_name,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meeting_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        status = excluded.status,
        planner_summary = excluded.planner_summary,
        planner_agent_id = excluded.planner_agent_id,
        planner_agent_name = excluded.planner_agent_name,
        updated_at = excluded.updated_at
    `,
    ).run(meetingId, snapshotHash, status, plannerSummary, plannerAgentId, plannerAgentName, ts, ts);
  }

  function recordProjectReviewDecisionEvent(input: ProjectReviewDecisionEventInput): void {
    db.prepare(
      `
      INSERT INTO project_review_decision_events (
        project_id,
        snapshot_hash,
        event_type,
        summary,
        selected_options_json,
        note,
        task_id,
        meeting_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      input.project_id,
      input.snapshot_hash ?? null,
      input.event_type,
      input.summary,
      input.selected_options_json ?? null,
      input.note ?? null,
      input.task_id ?? null,
      input.meeting_id ?? null,
      nowMs(),
    );
  }

  return {
    buildProjectReviewSnapshotHash,
    getProjectReviewDecisionState,
    upsertProjectReviewDecisionState,
    buildReviewRoundSnapshotHash,
    getReviewRoundDecisionState,
    upsertReviewRoundDecisionState,
    recordProjectReviewDecisionEvent,
  };
}
