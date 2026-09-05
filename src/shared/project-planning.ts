import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const list = z.array(text).max(30);
export const projectPlanSchema = z
  .object({
    version: z.literal(1),
    goal: text,
    scope: list.min(1),
    nonGoals: list,
    assumptions: list,
    risks: list,
    deliverables: list.min(1),
    approvalPoints: list,
    budgetMicros: z.number().int().min(0).max(1_000_000_000_000),
    tasks: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
            title: text.max(160),
            description: text,
            agentKey: z.string().min(1).max(80),
            dependsOn: z.array(z.string().max(40)).max(30),
            acceptanceCriteria: list.min(1),
            riskLevel: z.enum(["low", "medium", "high", "critical"]),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const keys = new Set(plan.tasks.map((task) => task.key));
    if (keys.size !== plan.tasks.length) ctx.addIssue({ code: "custom", message: "Task keys must be unique" });
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): boolean => {
      if (visiting.has(key)) return false;
      if (visited.has(key)) return true;
      visiting.add(key);
      for (const dependency of plan.tasks.find((task) => task.key === key)?.dependsOn ?? []) {
        if (!keys.has(dependency) || !visit(dependency)) return false;
      }
      visiting.delete(key);
      visited.add(key);
      return true;
    };
    if (plan.tasks.some((task) => !visit(task.key)))
      ctx.addIssue({ code: "custom", message: "Dependencies must exist and be acyclic" });
  });
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export interface ProjectPlanRecord {
  id: string;
  company_id: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  status: "planning" | "review" | "approved" | "rejected" | "failed";
  plan: ProjectPlan | null;
  error: string | null;
  reviewed_by: string | null;
  created_at: number;
  updated_at: number;
}
export function parseProjectPlan(output: string): ProjectPlan {
  const json = output
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (json.length > 180_000) throw new Error("Project plan exceeds size limit");
  return projectPlanSchema.parse(JSON.parse(json));
}
export const PROJECT_PLANNING_MARKER = "IRONCREW_PROJECT_PLAN_V1";
export function projectPlanningInstructions(agents: Array<{ key: string; role: string }>): string {
  return `${PROJECT_PLANNING_MARKER}\nErstelle ausschließlich einen JSON-Projektplan. Führe keine Projektarbeit aus. Der CEO muss den Plan vor der Delegation genehmigen. Keine externen Aktionen.\nSchema: {version:1,goal:string,scope:string[],nonGoals:string[],assumptions:string[],risks:string[],deliverables:string[],approvalPoints:string[],budgetMicros:integer,tasks:[{key:string,title:string,description:string,agentKey:string,dependsOn:string[],acceptanceCriteria:string[],riskLevel:"low"|"medium"|"high"|"critical"}]}\nBudget in USD-Mikroeinheiten (1000000 = 1 USD); unbekannt=0 mit Annahme und Freigabepunkt. 1–30 Tasks, eindeutige kleine Schlüssel, nur existierende Abhängigkeiten, keine Zyklen. Externe, produktive, rechtlich bindende oder irreversible Aktionen benötigen riskLevel high/critical und explizite Freigabepunkte.\nVerfügbare Agenten: ${JSON.stringify(agents)}`;
}
