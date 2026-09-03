import { z } from "zod/v4";

/** POST /api/departments — create a new department */
export const CreateDepartmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  name_ko: z.string().optional(),
  name_ja: z.string().optional(),
  name_zh: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  workflow_pack_key: z.string().optional(),
});

/** PATCH /api/departments/:id — update a department */
export const UpdateDepartmentSchema = z
  .object({
    name: z.string().optional(),
    name_ko: z.string().optional(),
    name_ja: z.string().optional(),
    name_zh: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
    description: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    sort_order: z.number().optional(),
    workflow_pack_key: z.string().optional(),
  })
  .passthrough();

/** DELETE /api/departments/:id — body may contain workflow_pack_key */
export const DeleteDepartmentSchema = z.object({
  workflow_pack_key: z.string().optional(),
});

/** PATCH /api/departments/reorder — reorder departments */
export const ReorderDepartmentsSchema = z.object({
  orders: z.array(
    z.object({
      id: z.string().min(1),
      sort_order: z.number().int().min(0),
    }),
  ),
  workflow_pack_key: z.string().optional(),
});
