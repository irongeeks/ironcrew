import type { ProjectContext } from "../types/runtime-context-domains.ts";

/**
 * Dependencies for ProjectContext — pass-through from runtimeContext.
 *
 * Functions originate from coordination.ts, context-routes.ts,
 * and report-routing.ts. All are closures over runtimeContext in
 * barrel modules.
 */
export interface ProjectDeps {
  detectProjectPath: ProjectContext["detectProjectPath"];
  detectReportOutputFormat: ProjectContext["detectReportOutputFormat"];
  detectTechStack: ProjectContext["detectTechStack"];
  extractLatestProjectMemoBlock: ProjectContext["extractLatestProjectMemoBlock"];
  getDefaultProjectRoot: ProjectContext["getDefaultProjectRoot"];
  getKeyFiles: ProjectContext["getKeyFiles"];
  getLatestKnownProjectPath: ProjectContext["getLatestKnownProjectPath"];
  handleReportRequest: ProjectContext["handleReportRequest"];
  isGitRepo: ProjectContext["isGitRepo"];
  pickPlanningReportAssignee: ProjectContext["pickPlanningReportAssignee"];
  resolveDirectiveProjectPath: ProjectContext["resolveDirectiveProjectPath"];
  resolveProjectPath: ProjectContext["resolveProjectPath"];
  stripReportRequestPrefix: ProjectContext["stripReportRequestPrefix"];
}

/**
 * Creates a ProjectContext by forwarding all properties from deps.
 *
 * Transitional pass-through factory. Future work will refactor source
 * modules to accept narrow deps so their functions can be composed here.
 */
export function createProjectContext(deps: ProjectDeps): ProjectContext {
  return {
    detectProjectPath: deps.detectProjectPath,
    detectReportOutputFormat: deps.detectReportOutputFormat,
    detectTechStack: deps.detectTechStack,
    extractLatestProjectMemoBlock: deps.extractLatestProjectMemoBlock,
    getDefaultProjectRoot: deps.getDefaultProjectRoot,
    getKeyFiles: deps.getKeyFiles,
    getLatestKnownProjectPath: deps.getLatestKnownProjectPath,
    handleReportRequest: deps.handleReportRequest,
    isGitRepo: deps.isGitRepo,
    pickPlanningReportAssignee: deps.pickPlanningReportAssignee,
    resolveDirectiveProjectPath: deps.resolveDirectiveProjectPath,
    resolveProjectPath: deps.resolveProjectPath,
    stripReportRequestPrefix: deps.stripReportRequestPrefix,
  };
}
