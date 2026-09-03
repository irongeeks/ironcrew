import type { DecisionOption, ReviewRoundReplyInput } from "./types.ts";

export async function handleReviewRoundDecisionReply(input: ReviewRoundReplyInput): Promise<boolean> {
  const { req, res, currentItem, selectedOption, optionNumber, deps } = input;
  if (currentItem.kind !== "review_round_pick") return false;

  const {
    db,
    l,
    pickL,
    nowMs,
    resolveLang,
    normalizeTextField,
    appendTaskLog,
    processSubtaskDelegations,
    seedReviewRevisionSubtasks,
    scheduleNextReviewRound,
    getProjectReviewDecisionState,
    getReviewDecisionNotes,
    getReviewDecisionFallbackLabel,
    recordProjectReviewDecisionEvent,
    openSupplementRound,
    REVIEW_DECISION_RESOLVED_LOG_PREFIX,
  } = deps;

  const taskId = currentItem.task_id;
  const meetingId = normalizeTextField(currentItem.meeting_id);
  if (!taskId || !meetingId) {
    res.status(400).json({ error: "task_or_meeting_required" });
    return true;
  }

  const task = db
    .prepare(
      `
      SELECT id, title, status, project_id, department_id, assigned_agent_id, description
      FROM tasks
      WHERE id = ?
    `,
    )
    .get(taskId) as
    | {
        id: string;
        title: string;
        status: string;
        project_id: string | null;
        department_id: string | null;
        assigned_agent_id: string | null;
        description: string | null;
      }
    | undefined;
  if (!task) {
    res.status(404).json({ error: "task_not_found" });
    return true;
  }
  if (task.status !== "review") {
    res.status(409).json({ error: "task_not_in_review", status: task.status });
    return true;
  }

  const meeting = db
    .prepare(
      `
      SELECT id, round, status
      FROM meeting_minutes
      WHERE id = ?
        AND task_id = ?
        AND meeting_type = 'review'
    `,
    )
    .get(meetingId, taskId) as
    | {
        id: string;
        round: number;
        status: string;
      }
    | undefined;
  if (!meeting) {
    res.status(404).json({ error: "meeting_not_found" });
    return true;
  }
  if (meeting.status !== "revision_requested") {
    res.status(409).json({ error: "meeting_not_pending", status: meeting.status });
    return true;
  }
  const reviewRound = Number.isFinite(meeting.round) ? Math.max(1, Math.trunc(meeting.round)) : 1;
  const lang = resolveLang(task.description ?? task.title);
  const resolvedProjectId = normalizeTextField(currentItem.project_id) ?? normalizeTextField(task.project_id);
  const decisionSnapshotHash = resolvedProjectId
    ? (getProjectReviewDecisionState(resolvedProjectId)?.snapshot_hash ?? null)
    : null;
  const notesRaw = getReviewDecisionNotes(taskId, reviewRound, 6);
  const notes = notesRaw.length > 0 ? notesRaw : [getReviewDecisionFallbackLabel(lang)];

  const skipNumber = notes.length + 1;
  const payloadNumbers = Array.isArray(req.body?.selected_option_numbers) ? req.body.selected_option_numbers : null;
  const selectedNumbers = (payloadNumbers !== null ? payloadNumbers : [optionNumber])
    .map((value: unknown) => Number(value))
    .filter((num: number) => Number.isFinite(num))
    .map((num: number) => Math.trunc(num));
  const dedupedSelected: number[] = Array.from(new Set<number>(selectedNumbers));
  const extraNote = normalizeTextField(req.body?.note);

  if (dedupedSelected.includes(skipNumber)) {
    if (dedupedSelected.length > 1) {
      res.status(400).json({ error: "skip_option_must_be_alone" });
      return true;
    }
    if (extraNote) {
      res.status(400).json({ error: "skip_option_disallows_extra_note" });
      return true;
    }
    const resolvedAt = nowMs();
    db.prepare("UPDATE meeting_minutes SET status = 'completed', completed_at = ? WHERE id = ?").run(
      resolvedAt,
      meetingId,
    );
    appendTaskLog(
      taskId,
      "system",
      `${REVIEW_DECISION_RESOLVED_LOG_PREFIX} (action=skip_to_next_round, round=${reviewRound}, meeting_id=${meetingId})`,
    );
    if (resolvedProjectId) {
      const skipOptionLabel =
        currentItem.options.find((option: DecisionOption) => option.number === skipNumber)?.label ||
        selectedOption.label ||
        "skip_to_next_round";
      recordProjectReviewDecisionEvent({
        project_id: resolvedProjectId,
        snapshot_hash: decisionSnapshotHash,
        event_type: "representative_pick",
        summary: pickL(
          l(
            [`리뷰 라운드 ${reviewRound} 의사결정: 다음 라운드로 SKIP`],
            [`Review round ${reviewRound} decision: skip to next round`],
            [`レビューラウンド${reviewRound}判断: 次ラウンドへスキップ`],
            [`评审第 ${reviewRound} 轮决策：跳到下一轮`],
          ),
          lang,
        ),
        selected_options_json: JSON.stringify([
          {
            number: skipNumber,
            action: "skip_to_next_round",
            label: skipOptionLabel,
            review_round: reviewRound,
          },
        ]),
        task_id: taskId,
        meeting_id: meetingId,
      });
    }
    try {
      scheduleNextReviewRound(taskId, task.title, reviewRound, lang);
    } catch (err: unknown) {
      db.prepare("UPDATE meeting_minutes SET status = 'revision_requested', completed_at = NULL WHERE id = ?").run(
        meetingId,
      );
      const msg = err instanceof Error ? err.message : String(err);
      appendTaskLog(
        taskId,
        "error",
        `Decision inbox skip rollback: next round scheduling failed (round=${reviewRound}, meeting_id=${meetingId}, reason=${msg})`,
      );
      res.status(500).json({ error: "schedule_next_review_round_failed", message: msg });
      return true;
    }
    res.json({
      ok: true,
      resolved: true,
      kind: "review_round_pick",
      action: "skip_to_next_round",
      task_id: taskId,
      review_round: reviewRound,
    });
    return true;
  }

  const pickedNumbers = dedupedSelected.filter((num) => num >= 1 && num <= notes.length).sort((a, b) => a - b);
  const pickedNotes = pickedNumbers.map((num) => notes[num - 1]).filter(Boolean);
  const mergedNotes: string[] = [];
  const seen = new Set<string>();
  for (const note of pickedNotes) {
    const cleaned = String(note || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mergedNotes.push(cleaned);
  }
  if (extraNote) {
    const key = extraNote.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      mergedNotes.push(extraNote);
    }
  }
  if (mergedNotes.length <= 0) {
    res.status(400).json({ error: "review_pick_or_note_required" });
    return true;
  }

  const subtaskCount = seedReviewRevisionSubtasks(taskId, task.department_id, mergedNotes);
  processSubtaskDelegations(taskId);
  const resolvedAt = nowMs();
  db.prepare("UPDATE meeting_minutes SET status = 'completed', completed_at = ? WHERE id = ?").run(
    resolvedAt,
    meetingId,
  );
  appendTaskLog(
    taskId,
    "system",
    `${REVIEW_DECISION_RESOLVED_LOG_PREFIX} (action=apply_review_pick, round=${reviewRound}, picks=${pickedNumbers.join(",") || "-"}, extra_note=${extraNote ? "yes" : "no"}, meeting_id=${meetingId}, subtasks=${subtaskCount})`,
  );
  if (resolvedProjectId) {
    const pickedPayload = pickedNumbers.map((num) => ({
      number: num,
      action: "apply_review_pick",
      label: notes[num - 1] || `option_${num}`,
      review_round: reviewRound,
    }));
    recordProjectReviewDecisionEvent({
      project_id: resolvedProjectId,
      snapshot_hash: decisionSnapshotHash,
      event_type: "representative_pick",
      summary: pickL(
        l(
          [`리뷰 라운드 ${reviewRound} 의사결정: 보완 항목 선택 ${pickedNumbers.length}건`],
          [`Review round ${reviewRound} decision: ${pickedNumbers.length} remediation pick(s)`],
          [`レビューラウンド${reviewRound}判断: 補完項目 ${pickedNumbers.length} 件を選択`],
          [`评审第 ${reviewRound} 轮决策：已选择 ${pickedNumbers.length} 项补充整改`],
        ),
        lang,
      ),
      selected_options_json: pickedPayload.length > 0 ? JSON.stringify(pickedPayload) : null,
      note: extraNote ?? null,
      task_id: taskId,
      meeting_id: meetingId,
    });
  }

  const supplement = await openSupplementRound(
    taskId,
    task.assigned_agent_id,
    task.department_id,
    `Decision inbox round${reviewRound}`,
    mergedNotes.join("\n"),
  );
  res.json({
    ok: true,
    resolved: true,
    kind: "review_round_pick",
    action: "apply_review_pick",
    task_id: taskId,
    selected_option_numbers: pickedNumbers,
    review_round: reviewRound,
    revision_subtask_count: subtaskCount,
    supplement_round_started: supplement.started,
    supplement_round_reason: supplement.reason,
  });
  return true;
}
