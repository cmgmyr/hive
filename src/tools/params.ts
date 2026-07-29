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

// The preferred way to address a worker, so it is listed first everywhere and
// described the same way everywhere. Ids still work; they are just not the
// handle a human remembers.
export const agentNameParam = z
  .string()
  .optional()
  .describe(
    "The worker's name, e.g. \"impl\" or \"DEVX-123\". Preferred over agent_id. A partial name works when it matches exactly one running worker, so \"123\" finds DEVX-123.",
  );

export const agentIdParam = z
  .number()
  .int()
  .optional()
  .describe("Numeric agent id. Use name instead unless you have the id to hand.");
