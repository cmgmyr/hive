import { db } from "./db.js";
import { HUMAN_ACTOR_PREFIX } from "./context.js";
import { assertSafeWakeBody, resolveWakeDelivery } from "./tools/wakes.js";

type QuestionRef = { kind: "todo" | "pr"; number: number };
type QuestionOption = { label: string; description: string; recommended: boolean };
type QuestionState = "pending" | "answered" | "defaulted" | "withdrawn";

export type QuestionInput =
  | {
      kind: "choice";
      question: string;
      header: string;
      options: QuestionOption[];
      default_answer: string;
      ref?: QuestionRef;
    }
  | { kind: "free_text"; question: string; header: string; default_answer: string; ref?: QuestionRef };

export type QuestionRecord = {
  id: number;
  project_id: number;
  asker: string;
  kind: "choice" | "free_text";
  question: string;
  header: string;
  options: QuestionOption[] | null;
  default_answer: string;
  ref: QuestionRef | null;
  state: QuestionState;
  answer: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  answered_by: string | null;
};

type QuestionPatch = {
  question?: string;
  header?: string;
  options?: QuestionOption[];
  default_answer?: string;
  state?: "defaulted" | "withdrawn";
};

const QUESTION_STATE_CONFLICT = "QUESTION_STATE_CONFLICT";
const HEADER_MAX_CHARS = 12;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

type Row = Omit<QuestionRecord, "options" | "ref"> & {
  options: string | null;
  ref_kind: "todo" | "pr" | null;
  ref_number: number | null;
};

function toRecord(row: Row): QuestionRecord {
  const { ref_kind, ref_number, options, ...rest } = row;
  return {
    ...rest,
    options: options === null ? null : (JSON.parse(options) as QuestionOption[]),
    ref: ref_kind === null || ref_number === null ? null : { kind: ref_kind, number: ref_number },
  };
}

const blank = (s: unknown): boolean => typeof s !== "string" || s.trim() === "";

function validateRef(ref: QuestionRef | undefined): void {
  if (ref === undefined) return;
  if (ref.kind !== "todo" && ref.kind !== "pr") throw new Error(`ref.kind must be "todo" or "pr", got ${JSON.stringify(ref.kind)}.`);
  if (!Number.isSafeInteger(ref.number) || ref.number <= 0) throw new Error("ref.number must be a positive safe integer.");
}

function validateInput(input: QuestionInput): void {
  if (input.kind !== "choice" && input.kind !== "free_text") {
    throw new Error(`kind must be "choice" or "free_text", got ${JSON.stringify((input as { kind: unknown }).kind)}.`);
  }
  if (blank(input.question)) throw new Error("question cannot be blank.");
  if (blank(input.header)) throw new Error("header cannot be blank.");
  if ([...input.header].length > HEADER_MAX_CHARS) {
    throw new Error(`header is ${[...input.header].length} characters; the limit is ${HEADER_MAX_CHARS}.`);
  }
  if (blank(input.default_answer)) throw new Error("default_answer cannot be blank: every question carries its default.");
  validateRef(input.ref);
  const wakeBound = [input.question, input.header, input.default_answer];
  if (input.kind === "free_text") {
    if ((input as { options?: unknown }).options !== undefined) throw new Error("a free_text question takes no options.");
  } else {
    const options = input.options;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      throw new Error(`a choice question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options, got ${Array.isArray(options) ? options.length : 0}.`);
    }
    const labels = new Set<string>();
    for (const o of options) {
      if (blank(o.label)) throw new Error("an option label cannot be blank.");
      if (blank(o.description)) throw new Error(`option "${o.label}" needs a description.`);
      if (labels.has(o.label)) throw new Error(`option label "${o.label}" is duplicated; labels must be distinct.`);
      labels.add(o.label);
      wakeBound.push(o.label, o.description);
    }
    const recommended = options.filter((o) => o.recommended);
    if (recommended.length !== 1) {
      throw new Error(`exactly one option must be recommended, got ${recommended.length}.`);
    }
    if (input.default_answer !== recommended[0].label) {
      throw new Error(`default_answer must be the recommended option's label ("${recommended[0].label}").`);
    }
  }
  for (const text of wakeBound) assertSafeWakeBody(text);
}

const tokensOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => [...t].length >= 4));

const normalized = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

export function looksSimilar(a: string, b: string): boolean {
  if (normalized(a) === normalized(b)) return true;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union > 0 && shared / union >= 0.5;
}

function similarPendingIds(projectId: number, selfId: number, question: string): number[] {
  const rows = db
    .prepare("SELECT id, question FROM questions WHERE project_id = ? AND state = 'pending' AND id != ? ORDER BY id")
    .all(projectId, selfId) as { id: number; question: string }[];
  return rows.filter((r) => looksSimilar(question, r.question)).map((r) => r.id);
}

function runningAgentOf(projectId: number, actor: string): number | null {
  const row = db
    .prepare("SELECT id FROM agents WHERE project_id = ? AND actor_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(projectId, actor) as { id: number } | undefined;
  return row?.id ?? null;
}

function runningLeadOf(projectId: number): { id: number; actor_id: string } | null {
  const row = db
    .prepare("SELECT id, actor_id FROM agents WHERE project_id = ? AND kind = 'lead' AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(projectId) as { id: number; actor_id: string } | undefined;
  return row ?? null;
}

const optionsJson = (input: QuestionInput): string | null => (input.kind === "choice" ? JSON.stringify(input.options) : null);

function pendingIdForRef(projectId: number, ref: QuestionRef): number | undefined {
  const row = db
    .prepare("SELECT id FROM questions WHERE project_id = ? AND ref_kind = ? AND ref_number = ? AND state = 'pending'")
    .get(projectId, ref.kind, ref.number) as { id: number } | undefined;
  return row?.id;
}

const upsertQuestion = db.transaction(
  (projectId: number, actor: string, input: QuestionInput, askerChecked: boolean): { id: number; created: boolean } => {
    if (input.ref) {
      const existing = pendingIdForRef(projectId, input.ref);
      if (existing !== undefined) {
        db.prepare(
          `UPDATE questions SET kind = ?, question = ?, header = ?, options = ?, default_answer = ?,
             updated_at = datetime('now'), updated_by = ? WHERE id = ?`,
        ).run(input.kind, input.question, input.header, optionsJson(input), input.default_answer, actor, existing);
        return { id: existing, created: false };
      }
    }
    if (!askerChecked) {
      throw new Error(`${QUESTION_STATE_CONFLICT}: the pending question for this ref changed while it was being asked; ask again.`);
    }
    const row = db
      .prepare(
        `INSERT INTO questions (project_id, asker, kind, question, header, options, default_answer,
           ref_kind, ref_number, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        projectId,
        actor,
        input.kind,
        input.question,
        input.header,
        optionsJson(input),
        input.default_answer,
        input.ref?.kind ?? null,
        input.ref?.number ?? null,
        actor,
      ) as { id: number };
    return { id: row.id, created: true };
  },
);

export function askQuestion(
  projectId: number,
  actor: string,
  input: QuestionInput,
): { question_id: number; created: boolean; similar_question_ids: number[] } {
  validateInput(input);
  const refTaken = input.ref !== undefined && pendingIdForRef(projectId, input.ref) !== undefined;
  let askerChecked = false;
  if (!refTaken) {
    resolveWakeDelivery(projectId);
    askerChecked = runningAgentOf(projectId, actor) !== null;
    if (!askerChecked) {
      throw new Error(
        "This session has no running hive agent row, so an answer could never be woken back to it; a question needs an asker that can be woken.",
      );
    }
  }
  const { id, created } = upsertQuestion.immediate(projectId, actor, input, askerChecked);
  return { question_id: id, created, similar_question_ids: similarPendingIds(projectId, id, input.question) };
}

function fetchRow(projectId: number, id: number): Row {
  const row = db.prepare("SELECT * FROM questions WHERE project_id = ? AND id = ?").get(projectId, id) as Row | undefined;
  if (!row) throw new Error(`No question ${id} in this project. Call question_list.`);
  return row;
}

export function getQuestion(projectId: number, id: number): QuestionRecord {
  return toRecord(fetchRow(projectId, id));
}

export function listQuestions(projectId: number): QuestionRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM questions WHERE project_id = ? AND state IN ('pending', 'defaulted') ORDER BY (state = 'defaulted'), id",
    )
    .all(projectId) as Row[];
  return rows.map(toRecord);
}

export function pendingQuestionCount(projectId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id = ? AND state = 'pending'").get(projectId) as { n: number }).n;
}

const TEXT_PATCH_KEYS = ["question", "header", "options", "default_answer"] as const;

const patchQuestion = db.transaction(
  (projectId: number, actor: string, id: number, patch: QuestionPatch): { question_id: number; state: QuestionState } => {
    const current = toRecord(fetchRow(projectId, id));
    const editsText = TEXT_PATCH_KEYS.some((k) => patch[k] !== undefined);
    if (editsText && current.state !== "pending") {
      throw new Error(`${QUESTION_STATE_CONFLICT}: question ${id} is ${current.state}; only a pending question's text can be edited.`);
    }
    if (patch.state !== undefined) {
      if (patch.state !== "defaulted" && patch.state !== "withdrawn") {
        throw new Error(`state must be "defaulted" or "withdrawn", got ${JSON.stringify(patch.state)}.`);
      }
      const allowed = patch.state === "withdrawn" ? ["pending", "defaulted"] : ["pending"];
      if (!allowed.includes(current.state)) {
        throw new Error(`${QUESTION_STATE_CONFLICT}: question ${id} is ${current.state} and cannot become ${patch.state}.`);
      }
      if (actor !== current.asker && !actor.startsWith(HUMAN_ACTOR_PREFIX)) {
        throw new Error(`Only the asking session (${current.asker}) or the human can mark question ${id} ${patch.state}.`);
      }
    }
    let merged: QuestionInput | null = null;
    if (editsText) {
      if (current.kind === "free_text" && patch.options !== undefined) throw new Error("a free_text question takes no options.");
      const base = {
        question: patch.question ?? current.question,
        header: patch.header ?? current.header,
        default_answer: patch.default_answer ?? current.default_answer,
        ...(current.ref ? { ref: current.ref } : {}),
      };
      merged =
        current.kind === "choice"
          ? { kind: "choice", ...base, options: patch.options ?? (current.options as QuestionOption[]) }
          : { kind: "free_text", ...base };
      validateInput(merged);
    }
    const sets: string[] = ["updated_at = datetime('now')", "updated_by = ?"];
    const params: unknown[] = [actor];
    if (merged) {
      sets.push("question = ?", "header = ?", "options = ?", "default_answer = ?");
      params.push(merged.question, merged.header, optionsJson(merged), merged.default_answer);
    }
    if (patch.state !== undefined) {
      sets.push("state = ?");
      params.push(patch.state);
    }
    db.prepare(`UPDATE questions SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    return { question_id: id, state: patch.state ?? current.state };
  },
);

export function updateQuestion(
  projectId: number,
  actor: string,
  id: number,
  patch: QuestionPatch,
): { question_id: number; state: QuestionState } {
  if (Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined).length === 0) {
    throw new Error("an empty patch changes nothing; pass at least one field to change.");
  }
  return patchQuestion.immediate(projectId, actor, id, patch);
}

export function answerWakeBody(id: number, question: string, answer: string, notes: string | null): string {
  const head = `Question #${id} answered.\nQuestion: ${question}\nAnswer: ${answer}`;
  return notes !== null && notes.trim() !== "" ? `${head}\nNotes: ${notes}` : head;
}

type WakePlan =
  | { delivery: { actor: string; pane: string }; reroutedFrom?: string }
  | { skipped: string };

function planAnswerWake(projectId: number, row: Row, actor: string): WakePlan {
  if (actor === row.asker) return { skipped: "answered by the asker" };
  const agentId = runningAgentOf(projectId, row.asker);
  if (agentId === null) {
    const lead = runningLeadOf(projectId);
    if (lead === null) return { skipped: `the asker ${row.asker} has no running agent` };
    if (lead.actor_id === actor) return { skipped: "answered by the lead that would receive it" };
    try {
      return { delivery: resolveWakeDelivery(projectId, lead.id), reroutedFrom: row.asker };
    } catch (e) {
      return { skipped: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    return { delivery: resolveWakeDelivery(projectId, agentId) };
  } catch (e) {
    return { skipped: e instanceof Error ? e.message : String(e) };
  }
}

const commitAnswer = db.transaction(
  (
    projectId: number,
    actor: string,
    id: number,
    answer: string,
    notes: string | null,
    plan: WakePlan,
  ): { question_id: number; wake_id: number | null; wake_skipped?: string; wake_rerouted_to?: string } => {
    const row = fetchRow(projectId, id);
    if (row.state !== "pending" && row.state !== "defaulted") {
      throw new Error(`${QUESTION_STATE_CONFLICT}: question ${id} is already ${row.state}.`);
    }
    db.prepare(
      `UPDATE questions SET state = 'answered', answer = ?, notes = ?, answered_by = ?, updated_by = ?,
         updated_at = datetime('now') WHERE id = ?`,
    ).run(answer, notes, actor, actor, id);
    if ("skipped" in plan) return { question_id: id, wake_id: null, wake_skipped: plan.skipped };
    const body = answerWakeBody(id, row.question, answer, notes);
    const wakeBody = "reroutedFrom" in plan && plan.reroutedFrom !== undefined
      ? `${body}\nAsked by ${plan.reroutedFrom}, which is not running; delivered to this project's lead.`
      : body;
    const wake = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
         VALUES (?, ?, ?, 'delay', ?, ?, datetime('now')) RETURNING id`,
      )
      .get(projectId, actor, wakeBody, plan.delivery.actor, plan.delivery.pane) as {
      id: number;
    };
    return {
      question_id: id,
      wake_id: wake.id,
      ...("reroutedFrom" in plan && plan.reroutedFrom !== undefined ? { wake_rerouted_to: plan.delivery.actor } : {}),
    };
  },
);

export function answerQuestion(
  projectId: number,
  actor: string,
  id: number,
  answer: string,
  notes?: string,
): { question_id: number; wake_id: number | null; wake_skipped?: string; wake_rerouted_to?: string } {
  if (blank(answer)) throw new Error("answer cannot be blank.");
  const storedNotes = notes === undefined || notes.trim() === "" ? null : notes;
  assertSafeWakeBody(answer);
  if (storedNotes !== null) assertSafeWakeBody(storedNotes);
  const row = fetchRow(projectId, id);
  if (row.state !== "pending" && row.state !== "defaulted") {
    throw new Error(`${QUESTION_STATE_CONFLICT}: question ${id} is already ${row.state}.`);
  }
  const plan = planAnswerWake(projectId, row, actor);
  return commitAnswer.immediate(projectId, actor, id, answer, storedNotes, plan);
}
