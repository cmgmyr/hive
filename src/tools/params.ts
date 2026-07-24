import { z } from "zod";

// Shared across every project-scoped tool; the description carries scope
// policy, so it must not drift between tools.
export const projectIdParam = z
  .number()
  .int()
  .optional()
  .describe(
    "Different project override. Use ONLY when the user explicitly asks for another project by name; otherwise stay in the current scope, even when results are empty.",
  );
