import { z } from "zod/v4";

/** POST /api/tasks — create a new task */
export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  department_id: z.string().optional(),
  assigned_agent_id: z.string().optional(),
  project_id: z.string().optional(),
  project_path: z.string().optional(),
  status: z.string().optional(),
  priority: z.number().optional(),
  task_type: z.string().optional(),
  workflow_pack_key: z.string().optional(),
  workflow_meta_json: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  output_format: z.string().optional(),
  base_branch: z.string().optional(),
  skipped_phases: z.union([z.string(), z.array(z.string())]).optional(),
  trigger: z.string().optional(),
  trigger_detail: z.string().optional(),
  agent_routing: z.enum(["single", "department"]).optional(),
});

/** PATCH /api/tasks/:id — update an existing task */
export const UpdateTaskSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    department_id: z.string().nullable().optional(),
    assigned_agent_id: z.string().nullable().optional(),
    status: z.string().optional(),
    priority: z.number().optional(),
    task_type: z.string().optional(),
    workflow_pack_key: z.string().optional(),
    workflow_meta_json: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
    output_format: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    project_path: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
    hidden: z.union([z.number(), z.boolean()]).optional(),
    completed_at: z.number().optional(),
    started_at: z.number().optional(),
    skipped_phases: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  })
  .strip();

/** POST /api/tasks/:id/assign */
export const AssignTaskSchema = z.object({
  agent_id: z.string().min(1),
});

/** POST /api/tasks/:id/subtasks */
export const CreateSubtaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assigned_agent_id: z.string().nullable().optional(),
});

/** PATCH /api/subtasks/:id */
export const UpdateSubtaskSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    status: z.string().optional(),
    assigned_agent_id: z.string().nullable().optional(),
    blocked_reason: z.string().nullable().optional(),
    target_department_id: z.string().nullable().optional(),
    delegated_task_id: z.string().nullable().optional(),
  })
  .strip();

export const BulkHideSchema = z.object({
  statuses: z.array(z.string().min(1)).min(1).max(20),
  hidden: z.union([z.literal(0), z.literal(1)]),
});
