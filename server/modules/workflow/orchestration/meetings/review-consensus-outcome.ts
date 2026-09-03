import type { Lang } from "../../../../types/lang.ts";
import type { RuntimeContext } from "../../../../types/runtime-context.ts";
import type { AgentRow } from "../../../../types/workflow-types.ts";
import type { MeetingTranscriptEntry } from "./minutes.ts";

type ReviewRoundMode = "parallel_remediation" | "merge_synthesis" | "final_decision";

export type OutcomeContext = Pick<
  RuntimeContext,
  | "db"
  | "reviewInFlight"
  | "reviewRoundState"
  | "meetingReviewDecisionByAgent"
  | "findLatestTranscriptContentByAgent"
  | "isDeferrableReviewHold"
  | "summarizeForMeetingBubble"
  | "getDeptName"
  | "getAgentDisplayName"
  | "appendTaskLog"
  | "appendTaskProjectMemo"
  | "appendTaskReviewFinalMemo"
  | "collectRevisionMemoItems"
  | "reserveReviewRevisionMemoItems"
  | "loadRecentReviewRevisionMemoItems"
  | "notifyCeo"
  | "finishMeetingMinutes"
  | "dismissLeadersFromCeoOffice"
  | "scheduleNextReviewRound"
  | "pickL"
  | "l"
  | "sleepMs"
  | "randomDelay"
> & {
  taskId: string;
  taskTitle: string;
  round: number;
  roundMode: ReviewRoundMode;
  isRound1Remediation: boolean;
  isRound2Merge: boolean;
  isFinalDecisionRound: boolean;
  leaders: AgentRow[];
  transcript: MeetingTranscriptEntry[];
  lang: Lang;
  workflowPackKey: string | null;
  meetingId: string | null;
  onApproved: () => void;
  abortIfInactive: () => boolean;
  REVIEW_MAX_REVISION_SIGNALS_PER_ROUND: number;
  REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND: number;
  REVIEW_MAX_MEMO_ITEMS_PER_ROUND: number;
  REVIEW_MAX_MEMO_ITEMS_PER_DEPT: number;
  REVIEW_MAX_REMEDIATION_REQUESTS: number;
};

const REVIEW_DECISION_PENDING_LOG_PREFIX = "Decision inbox: review decision pending";

export async function processReviewConsensusOutcome(ctx: OutcomeContext): Promise<boolean> {
  const {
    taskId,
    taskTitle,
    round,
    roundMode,
    isRound1Remediation,
    isRound2Merge,
    isFinalDecisionRound,
    leaders,
    transcript,
    lang,
    workflowPackKey,
    meetingId,
    onApproved,
    abortIfInactive,
    meetingReviewDecisionByAgent,
    findLatestTranscriptContentByAgent,
    isDeferrableReviewHold,
    summarizeForMeetingBubble,
    getDeptName,
    getAgentDisplayName,
    appendTaskLog,
    REVIEW_MAX_REVISION_SIGNALS_PER_ROUND,
    REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND,
    appendTaskProjectMemo,
    sleepMs,
    randomDelay,
    collectRevisionMemoItems,
    REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
    REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    reserveReviewRevisionMemoItems,
    loadRecentReviewRevisionMemoItems,
    pickL,
    l,
    db,
    REVIEW_MAX_REMEDIATION_REQUESTS,
    notifyCeo,
    finishMeetingMinutes,
    dismissLeadersFromCeoOffice,
    reviewRoundState,
    reviewInFlight,
    appendTaskReviewFinalMemo,
    scheduleNextReviewRound,
  } = ctx;

  // Final review result should follow each leader's last approval statement,
  // not stale "needs revision" flags from earlier feedback turns.
  const finalHoldLeaders: any[] = [];
  const deferredMonitoringLeaders: any[] = [];
  const deferredMonitoringNotes: string[] = [];
  const finalHoldDeptCount = new Map<string, number>();
  for (const leader of leaders as any[]) {
    if (meetingReviewDecisionByAgent.get(leader.id) !== "hold") continue;
    const latestDecisionLine = findLatestTranscriptContentByAgent(transcript as MeetingTranscriptEntry[], leader.id);
    if (isDeferrableReviewHold(latestDecisionLine)) {
      const clipped = summarizeForMeetingBubble(latestDecisionLine, 160, lang as Lang);
      deferredMonitoringLeaders.push(leader);
      deferredMonitoringNotes.push(
        `${getDeptName(leader.department_id ?? "", workflowPackKey)} ${getAgentDisplayName(leader, lang)}: ${clipped}`,
      );
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: converted deferrable hold to post-merge monitoring (${leader.id})`,
      );
      continue;
    }
    if (finalHoldLeaders.length >= REVIEW_MAX_REVISION_SIGNALS_PER_ROUND) {
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: hold signal ignored (round cap ${REVIEW_MAX_REVISION_SIGNALS_PER_ROUND})`,
      );
      continue;
    }
    const deptKey = leader.department_id ?? `agent:${leader.id}`;
    const deptCount = finalHoldDeptCount.get(deptKey) ?? 0;
    if (deptCount >= REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND) {
      appendTaskLog(
        taskId,
        "system",
        `Review round ${round}: hold signal ignored for dept ${deptKey} (dept cap ${REVIEW_MAX_REVISION_SIGNALS_PER_DEPT_PER_ROUND})`,
      );
      continue;
    }
    finalHoldDeptCount.set(deptKey, deptCount + 1);
    finalHoldLeaders.push(leader);
  }
  const needsRevision = finalHoldLeaders.length > 0;
  if (!needsRevision && deferredMonitoringNotes.length > 0) {
    appendTaskProjectMemo(taskId, "review", round, deferredMonitoringNotes, lang);
    appendTaskLog(
      taskId,
      "system",
      `Review round ${round}: deferred ${deferredMonitoringLeaders.length} hold opinions to SLA monitoring checklist`,
    );
  }

  await sleepMs(randomDelay(540, 920));
  if (abortIfInactive()) return true;

  if (needsRevision) {
    const rawMemoItems = collectRevisionMemoItems(
      transcript as MeetingTranscriptEntry[],
      REVIEW_MAX_MEMO_ITEMS_PER_ROUND,
      REVIEW_MAX_MEMO_ITEMS_PER_DEPT,
    );
    const { freshItems, duplicateCount } = reserveReviewRevisionMemoItems(taskId, round, rawMemoItems);
    const hasFreshMemoItems = freshItems.length > 0;
    const fallbackMemoItem = pickL(
      l(
        [
          "리뷰 보완 요청이 감지되었습니다. 합의된 품질 기준과 증빙을 기준으로 잔여 리스크를 문서화하고 최종 결정이 필요합니다.",
        ],
        [
          "A review hold signal was detected. Document residual risks against agreed quality gates and move to a final decision.",
        ],
        [
          "レビュー保留シグナルを検知しました。合意した品質基準に対する残余リスクを文書化し、最終判断へ進めてください。",
        ],
        ["检测到评审保留信号。请基于既定质量门槛记录剩余风险，并进入最终决策。"],
      ),
      lang,
    );
    const memoItemsForAction = hasFreshMemoItems ? freshItems : [fallbackMemoItem];
    const recentMemoItems = hasFreshMemoItems ? [] : loadRecentReviewRevisionMemoItems(taskId, 4);
    const memoItemsForProject = hasFreshMemoItems
      ? freshItems
      : recentMemoItems.length > 0
        ? recentMemoItems
        : memoItemsForAction;
    appendTaskProjectMemo(taskId, "review", round, memoItemsForProject, lang);

    appendTaskLog(
      taskId,
      "system",
      `Review consensus round ${round}: revision requested (mode=${roundMode}, new_items=${freshItems.length}, duplicates=${duplicateCount})`,
    );

    const remediationRequestCountRow = db
      .prepare(
        `
          SELECT COUNT(*) AS cnt
          FROM meeting_minutes
          WHERE task_id = ?
            AND meeting_type = 'review'
            AND status = 'revision_requested'
        `,
      )
      .get(taskId) as { cnt: number } | undefined;
    const remediationRequestCount = remediationRequestCountRow?.cnt ?? 0;
    const remediationLimitReached = remediationRequestCount >= REVIEW_MAX_REMEDIATION_REQUESTS;

    if ((isRound1Remediation || isRound2Merge) && !remediationLimitReached) {
      const nextRound = round + 1;
      appendTaskLog(
        taskId,
        "system",
        `${REVIEW_DECISION_PENDING_LOG_PREFIX} (round=${round}, options=${memoItemsForAction.length})`,
      );
      notifyCeo(
        pickL(
          l(
            [
              `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round}에서 팀장 보완 의견이 취합되었습니다. 의사결정 인박스에서 항목을 복수 선택(체리피킹)하고 필요 시 추가 의견을 입력해 보완 작업을 진행하거나, 다음 라운드(${nextRound})로 SKIP할지 선택해 주세요.`,
            ],
            [
              `[CEO OFFICE] Team-lead remediation opinions for '${taskTitle}' in review round ${round} are consolidated. In Decision Inbox, cherry-pick multiple items and optionally add an extra note for remediation, or skip to round ${nextRound}.`,
            ],
            [
              `[CEO OFFICE] '${taskTitle}' のレビューラウンド${round}でチームリーダー補完意見を集約しました。Decision Inboxで複数項目をチェリーピックし、必要に応じて追加意見を入力して補完実行するか、ラウンド${nextRound}へスキップするか選択してください。`,
            ],
            [
              `[CEO OFFICE] '${taskTitle}' 第${round}轮已汇总组长整改意见。请在 Decision Inbox 中多选条目并可追加补充意见后执行整改，或直接跳到第 ${nextRound} 轮。`,
            ],
          ),
          lang,
        ),
        taskId,
      );
      if (meetingId) finishMeetingMinutes(meetingId, "revision_requested");
      dismissLeadersFromCeoOffice(taskId, leaders);
      reviewRoundState.delete(taskId);
      reviewInFlight.delete(taskId);
      return true;
    }

    if ((isRound1Remediation || isRound2Merge) && remediationLimitReached) {
      appendTaskLog(
        taskId,
        "system",
        `Review consensus round ${round}: remediation request cap reached (${REVIEW_MAX_REMEDIATION_REQUESTS}/task), skipping additional remediation`,
      );
      notifyCeo(
        pickL(
          l(
            [
              `[CEO OFFICE] '${taskTitle}' 보완 요청은 태스크당 최대 ${REVIEW_MAX_REMEDIATION_REQUESTS}회 정책에 따라 추가 보완 생성 없이 최종 판단 단계로 전환합니다.`,
            ],
            [
              `[CEO OFFICE] '${taskTitle}' reached the remediation-request cap (${REVIEW_MAX_REMEDIATION_REQUESTS} per task). Skipping additional remediation and moving to final decision.`,
            ],
            [
              `[CEO OFFICE] '${taskTitle}' はタスク当たり補完要請上限（${REVIEW_MAX_REMEDIATION_REQUESTS}回）に到達したため、追加補完を作成せず最終判断へ移行します。`,
            ],
            [
              `[CEO OFFICE] '${taskTitle}' 已达到每个任务最多 ${REVIEW_MAX_REMEDIATION_REQUESTS} 次整改请求上限，不再新增整改，转入最终判断。`,
            ],
          ),
          lang,
        ),
        taskId,
      );
    }

    const forceReason = isRound2Merge ? "round2_no_more_remediation_allowed" : `round${round}_finalization`;
    appendTaskLog(
      taskId,
      "system",
      `Review consensus round ${round}: forcing finalization with documented residual risk (${forceReason})`,
    );

    appendTaskReviewFinalMemo(taskId, round, transcript as MeetingTranscriptEntry[], lang, true);
    notifyCeo(
      pickL(
        l(
          [
            `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round}에서 잔여 리스크를 최종 문서에 반영했습니다. 추가 보완 없이 최종 승인 판단으로 종료합니다.`,
          ],
          [
            `[CEO OFFICE] In review round ${round} for '${taskTitle}', residual risks were embedded in the final document package. Closing with final approval decision and no further remediation.`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' のレビューラウンド${round}で残余リスクを最終文書へ反映しました。追加補完なしで最終承認判断を完了します。`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' 第${round}轮评审已将剩余风险写入最终文档包，在不新增整改的前提下完成最终审批判断。`,
          ],
        ),
        lang,
      ),
      taskId,
    );
    if (meetingId) finishMeetingMinutes(meetingId, "completed");
    dismissLeadersFromCeoOffice(taskId, leaders);
    reviewRoundState.delete(taskId);
    reviewInFlight.delete(taskId);
    onApproved();
    return true;
  }

  if (deferredMonitoringLeaders.length > 0) {
    notifyCeo(
      pickL(
        l(
          [
            `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round}에서 ${deferredMonitoringLeaders.length}개 보류 의견이 'MVP 범위 외 항목의 SLA 모니터링 전환'으로 분류되어 코드 병합 후 후속 체크리스트로 이관합니다.`,
          ],
          [
            `[CEO OFFICE] In review round ${round} for '${taskTitle}', ${deferredMonitoringLeaders.length} hold opinions were classified as MVP-out-of-scope and moved to post-merge SLA monitoring checklist.`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' のレビューラウンド${round}では、保留意見${deferredMonitoringLeaders.length}件を「MVP範囲外のSLA監視項目」へ振替し、コード統合後のチェックリストで追跡します。`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' 第${round}轮 Review 中，有 ${deferredMonitoringLeaders.length} 条保留意见被判定为 MVP 范围外事项，已转入合并后的 SLA 监控清单跟踪。`,
          ],
        ),
        lang,
      ),
      taskId,
    );
  }

  if (isRound2Merge) {
    appendTaskLog(taskId, "system", `Review consensus round ${round}: merge consolidation complete`);
    notifyCeo(
      pickL(
        l(
          [
            `[CEO OFFICE] '${taskTitle}' 리뷰 라운드 ${round} 취합/머지 검토가 완료되었습니다. 라운드 3 최종 승인 회의로 전환합니다.`,
          ],
          [
            `[CEO OFFICE] Review round ${round} consolidation/merge review for '${taskTitle}' is complete. Moving to round 3 final approval.`,
          ],
          [
            `[CEO OFFICE] '${taskTitle}' のレビューラウンド${round}集約/マージ確認が完了しました。ラウンド3最終承認へ移行します。`,
          ],
          [`[CEO OFFICE] '${taskTitle}' 第${round}轮评审汇总/合并审查已完成，现转入第3轮最终审批。`],
        ),
        lang,
      ),
      taskId,
    );
    if (meetingId) finishMeetingMinutes(meetingId, "completed");
    dismissLeadersFromCeoOffice(taskId, leaders);
    reviewRoundState.delete(taskId);
    reviewInFlight.delete(taskId);
    scheduleNextReviewRound(taskId, taskTitle, round, lang);
    return true;
  }

  appendTaskLog(taskId, "system", `Review consensus round ${round}: all leaders approved`);
  if (isFinalDecisionRound) {
    appendTaskReviewFinalMemo(
      taskId,
      round,
      transcript as MeetingTranscriptEntry[],
      lang,
      deferredMonitoringLeaders.length > 0,
    );
  }
  notifyCeo(
    pickL(
      l(
        [`[CEO OFFICE] '${taskTitle}' 전원 Approved 완료. Done 단계로 진행합니다.`],
        [`[CEO OFFICE] '${taskTitle}' is approved by all leaders. Proceeding to Done.`],
        [`[CEO OFFICE] '${taskTitle}' は全リーダー承認済みです。Doneへ進みます。`],
        [`[CEO OFFICE] '${taskTitle}'已获全体负责人批准，进入 Done 阶段。`],
      ),
      lang,
    ),
    taskId,
  );
  if (meetingId) finishMeetingMinutes(meetingId, "completed");
  dismissLeadersFromCeoOffice(taskId, leaders);
  reviewRoundState.delete(taskId);
  reviewInFlight.delete(taskId);
  onApproved();
  return true;
}
