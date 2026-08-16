import { z } from "zod";

export const idParam = z.number().int().positive();

export const projectIdParam = idParam
  .optional()
  .describe(
    "Different project override. Use ONLY when the user explicitly asks for another project by name; otherwise stay in the current scope, even when results are empty.",
  );

export const agentNameParam = z
  .string()
  .optional()
  .describe(
    "The worker's name, e.g. \"impl\" or \"DEVX-123\". Preferred over agent_id. A partial name works when it matches exactly one running worker, so \"123\" finds DEVX-123.",
  );

export const agentIdParam = idParam
  .optional()
  .describe("Numeric agent id. Use name instead unless you have the id to hand.");

export const limitParam = z.number().int().positive().optional();

export const offsetParam = z.number().int().nonnegative().optional();
