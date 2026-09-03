import type { DelegationContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for DelegationContext — pass-through from runtimeContext.
 *
 * Functions originate from subtask-delegation*.ts, coordination/*.ts,
 * subtask-routing.ts, and subtask-summary.ts. All are closures over
 * runtimeContext in barrel modules.
 */
export interface DelegationDeps {
  // Constants
  COLLABORATION_SUBTASK_PREFIXES: DelegationContext["COLLABORATION_SUBTASK_PREFIXES"];
  REMEDIATION_SUBTASK_PREFIXES: DelegationContext["REMEDIATION_SUBTASK_PREFIXES"];

  // Caches
  plannerSubtaskRoutingInFlight: DelegationContext["plannerSubtaskRoutingInFlight"];

  // Functions
  analyzeDirectivePolicy: DelegationContext["analyzeDirectivePolicy"];
  analyzeSubtaskDepartment: DelegationContext["analyzeSubtaskDepartment"];
  delegateSubtaskBatch: DelegationContext["delegateSubtaskBatch"];
  deriveSubtaskStateFromDelegatedTask: DelegationContext["deriveSubtaskStateFromDelegatedTask"];
  detectMentions: DelegationContext["detectMentions"];
  detectTargetDepartments: DelegationContext["detectTargetDepartments"];
  finalizeDelegatedSubtasks: DelegationContext["finalizeDelegatedSubtasks"];
  findExplicitDepartmentByMention: DelegationContext["findExplicitDepartmentByMention"];
  formatTaskSubtaskProgressSummary: DelegationContext["formatTaskSubtaskProgressSummary"];
  getSubtaskDeptExecutionPriority: DelegationContext["getSubtaskDeptExecutionPriority"];
  getTaskSubtaskProgressSummary: DelegationContext["getTaskSubtaskProgressSummary"];
  groupSubtasksByTargetDepartment: DelegationContext["groupSubtasksByTargetDepartment"];
  handleMentionDelegation: DelegationContext["handleMentionDelegation"];
  handleSubtaskDelegationComplete: DelegationContext["handleSubtaskDelegationComplete"];
  handleTaskDelegation: DelegationContext["handleTaskDelegation"];
  hasAnyPrefix: DelegationContext["hasAnyPrefix"];
  hasOpenForeignSubtasks: DelegationContext["hasOpenForeignSubtasks"];
  linkCrossDeptTaskToParentSubtask: DelegationContext["linkCrossDeptTaskToParentSubtask"];
  maybeNotifyAllSubtasksComplete: DelegationContext["maybeNotifyAllSubtasksComplete"];
  normalizeDeptAliasToken: DelegationContext["normalizeDeptAliasToken"];
  normalizePlannerTargetDeptId: DelegationContext["normalizePlannerTargetDeptId"];
  orderSubtaskQueuesByDepartment: DelegationContext["orderSubtaskQueuesByDepartment"];
  parsePlannerSubtaskAssignments: DelegationContext["parsePlannerSubtaskAssignments"];
  pickUnlinkedTargetSubtask: DelegationContext["pickUnlinkedTargetSubtask"];
  processSubtaskDelegations: DelegationContext["processSubtaskDelegations"];
  reconcileCrossDeptSubtasks: DelegationContext["reconcileCrossDeptSubtasks"];
  recoverCrossDeptQueueAfterMissingCallback: DelegationContext["recoverCrossDeptQueueAfterMissingCallback"];
  rerouteSubtasksByPlanningLeader: DelegationContext["rerouteSubtasksByPlanningLeader"];
  seedApprovedPlanSubtasks: DelegationContext["seedApprovedPlanSubtasks"];
  seedReviewRevisionSubtasks: DelegationContext["seedReviewRevisionSubtasks"];
  shouldExecuteDirectiveDelegation: DelegationContext["shouldExecuteDirectiveDelegation"];
  startCrossDeptCooperation: DelegationContext["startCrossDeptCooperation"];
  syncSubtaskWithDelegatedTask: DelegationContext["syncSubtaskWithDelegatedTask"];
}

/**
 * Creates a DelegationContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules to accept narrow deps so their functions can be composed here.
 */
export function createDelegationContext(deps: DelegationDeps): DelegationContext {
  return {
    COLLABORATION_SUBTASK_PREFIXES: deps.COLLABORATION_SUBTASK_PREFIXES,
    REMEDIATION_SUBTASK_PREFIXES: deps.REMEDIATION_SUBTASK_PREFIXES,

    plannerSubtaskRoutingInFlight: deps.plannerSubtaskRoutingInFlight,

    analyzeDirectivePolicy: deps.analyzeDirectivePolicy,
    analyzeSubtaskDepartment: deps.analyzeSubtaskDepartment,
    delegateSubtaskBatch: deps.delegateSubtaskBatch,
    deriveSubtaskStateFromDelegatedTask: deps.deriveSubtaskStateFromDelegatedTask,
    detectMentions: deps.detectMentions,
    detectTargetDepartments: deps.detectTargetDepartments,
    finalizeDelegatedSubtasks: deps.finalizeDelegatedSubtasks,
    findExplicitDepartmentByMention: deps.findExplicitDepartmentByMention,
    formatTaskSubtaskProgressSummary: deps.formatTaskSubtaskProgressSummary,
    getSubtaskDeptExecutionPriority: deps.getSubtaskDeptExecutionPriority,
    getTaskSubtaskProgressSummary: deps.getTaskSubtaskProgressSummary,
    groupSubtasksByTargetDepartment: deps.groupSubtasksByTargetDepartment,
    handleMentionDelegation: deps.handleMentionDelegation,
    handleSubtaskDelegationComplete: deps.handleSubtaskDelegationComplete,
    handleTaskDelegation: deps.handleTaskDelegation,
    hasAnyPrefix: deps.hasAnyPrefix,
    hasOpenForeignSubtasks: deps.hasOpenForeignSubtasks,
    linkCrossDeptTaskToParentSubtask: deps.linkCrossDeptTaskToParentSubtask,
    maybeNotifyAllSubtasksComplete: deps.maybeNotifyAllSubtasksComplete,
    normalizeDeptAliasToken: deps.normalizeDeptAliasToken,
    normalizePlannerTargetDeptId: deps.normalizePlannerTargetDeptId,
    orderSubtaskQueuesByDepartment: deps.orderSubtaskQueuesByDepartment,
    parsePlannerSubtaskAssignments: deps.parsePlannerSubtaskAssignments,
    pickUnlinkedTargetSubtask: deps.pickUnlinkedTargetSubtask,
    processSubtaskDelegations: deps.processSubtaskDelegations,
    reconcileCrossDeptSubtasks: deps.reconcileCrossDeptSubtasks,
    recoverCrossDeptQueueAfterMissingCallback: deps.recoverCrossDeptQueueAfterMissingCallback,
    rerouteSubtasksByPlanningLeader: deps.rerouteSubtasksByPlanningLeader,
    seedApprovedPlanSubtasks: deps.seedApprovedPlanSubtasks,
    seedReviewRevisionSubtasks: deps.seedReviewRevisionSubtasks,
    shouldExecuteDirectiveDelegation: deps.shouldExecuteDirectiveDelegation,
    startCrossDeptCooperation: deps.startCrossDeptCooperation,
    syncSubtaskWithDelegatedTask: deps.syncSubtaskWithDelegatedTask,
  };
}
