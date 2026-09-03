import { registerTaskExecutionControlRoutes, type TaskExecutionControlRouteDeps } from "./execution-control.ts";
import { registerTaskRunRoute, type TaskRunRouteDeps } from "./execution-run.ts";

export type TaskExecutionRouteDeps = TaskRunRouteDeps & TaskExecutionControlRouteDeps;

export function registerTaskExecutionRoutes(deps: TaskExecutionRouteDeps): void {
  registerTaskRunRoute(deps);
  registerTaskExecutionControlRoutes(deps);
}
