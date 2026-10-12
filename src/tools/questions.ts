import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import {
  answerQuestion,
  askQuestion,
  getQuestion,
  listQuestions,
  updateQuestion,
  type QuestionInput,
} from "../questions.js";
import { idParam } from "./params.js";

const optionParam = z.strictObject({
  label: z.string().describe("Short choice label; distinct within the question."),
  description: z.string().describe("What choosing this means."),
  recommended: z.boolean().describe("Exactly one option is recommended; it is the default."),
});

const refParam = z.strictObject({
  kind: z.enum(["todo", "pr"]),
  number: idParam.describe("A todo id or PR number. An identifier, not looked up."),
});

const stateParam = z.enum(["answered", "defaulted", "pending", "withdrawn"]);

const noWrites = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function registerQuestions(server: McpServer): void {
  server.registerTool(
    "question_ask",
    {
      description:
        "Record an open question for the human, keyed to this project and to you as the asker. kind=choice takes 2-4 options (each label, description, recommended; exactly one recommended) and a header of 12 characters or fewer; kind=free_text takes just the question and header. Every question carries default_answer: for a choice it is the recommended option's label. Pass ref (a todo id or PR number) to dedupe: asking again with a ref that already has a PENDING question in this project updates that row instead of adding one. The receipt lists other pending questions in this project that look similar (same normalized text, or at least half their longer words shared), so you can question_update one instead. The record is only stored: put the question to the human yourself, in your own turn. You must be a session an answer can be woken back to. When the question is answered, an ordinary wake carrying the answer is queued to you; read the record with question_get.",
      annotations: writes,
      inputSchema: {
        kind: z.enum(["choice", "free_text"]),
        question: z.string(),
        header: z.string().describe("12 characters or fewer."),
        options: z.array(optionParam).optional().describe("Required for choice, forbidden for free_text."),
        default_answer: z.string().describe("What you do if unanswered. For a choice, the recommended label."),
        ref: refParam.optional(),
      },
      outputSchema: {
        question_id: idParam,
        created: z.boolean(),
        similar_question_ids: z.array(idParam),
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId();
        const input = {
          kind: args.kind,
          question: args.question,
          header: args.header,
          default_answer: args.default_answer,
          ...(args.options !== undefined ? { options: args.options } : {}),
          ...(args.ref !== undefined ? { ref: args.ref } : {}),
        } as QuestionInput;
        return askQuestion(projectId, currentActor(), input);
      }),
  );

  server.registerTool(
    "question_get",
    {
      description: "Read one question in this project by id, in any state, with its answer and notes once answered.",
      annotations: noWrites,
      inputSchema: { question_id: idParam },
    },
    (args) => run(() => getQuestion(effectiveProjectId(), args.question_id)),
  );

  server.registerTool(
    "question_list",
    {
      description:
        "List this project's pending questions, then its defaulted ones (acted on by default, still open to reversal), oldest first within each group. Answered and withdrawn questions are not listed; read one by id with question_get.",
      annotations: noWrites,
      inputSchema: {},
    },
    () => run(() => ({ questions: listQuestions(effectiveProjectId()) })),
  );

  server.registerTool(
    "question_update",
    {
      description:
        "Edit a pending question's text (question, header, options, default_answer; the whole result is revalidated) or move it out of pending with state=defaulted (you acted on your default) or state=withdrawn (moot). A defaulted question can still be withdrawn. Moving state needs the asking session or the human; an answered or withdrawn question cannot be changed. The ref, asker and wake target never change.",
      annotations: writes,
      inputSchema: {
        question_id: idParam,
        question: z.string().optional(),
        header: z.string().optional(),
        options: z.array(optionParam).optional(),
        default_answer: z.string().optional(),
        state: z.enum(["defaulted", "withdrawn"]).optional(),
      },
      outputSchema: { question_id: idParam, state: stateParam },
    },
    (args) =>
      run(() => {
        const { question_id, ...patch } = args;
        return updateQuestion(effectiveProjectId(), currentActor(), question_id, patch);
      }),
  );

  server.registerTool(
    "question_answer",
    {
      description:
        "Record the human's answer to a pending or defaulted question in this project, plus optional notes. The answer may be a picked option label or free text, including text outside the offered labels. The answer update comes first; the answer and any wake commit together, and the answer stays readable with `question_get`. An answered or withdrawn question refuses with `QUESTION_STATE_CONFLICT`. A queued wake carries the question, answer and notes verbatim. When you are the asker, skip with `wake_id: null` and `wake_skipped`; otherwise, queue a wake to the running asker or, if the asker has no running row, to the project's running lead with `wake_rerouted_to`. Skip that fallback with `wake_id: null` and `wake_skipped` if no lead runs or the lead is the answerer. `wake_id` means queued, not delivered.",
      annotations: writes,
      inputSchema: {
        question_id: idParam,
        answer: z.string(),
        notes: z.string().optional(),
      },
      outputSchema: {
        question_id: idParam,
        wake_id: idParam.nullable(),
        wake_skipped: z.string().optional(),
        wake_rerouted_to: z.string().optional(),
      },
    },
    (args) =>
      run(() => answerQuestion(effectiveProjectId(), currentActor(), args.question_id, args.answer, args.notes)),
  );
}
