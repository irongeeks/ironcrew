import { type z } from "zod/v4";

/**
 * Parse and validate a request body against a Zod schema.
 * Returns discriminated union: { success: true, data } | { success: false, error }.
 */
export function parseBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): { success: true; data: z.output<T> } | { success: false; error: string } {
  const result = schema.safeParse(body ?? {});
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") + ": " : "";
    return path + issue.message;
  });
  return { success: false, error: issues.join("; ") };
}

/**
 * Safely extract an error message from an unknown caught value.
 * Replaces `catch (err: any) { err.message }` pattern.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
