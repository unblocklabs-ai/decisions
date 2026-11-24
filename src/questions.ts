import { z } from "zod";
import { matchesDecisionModel } from "./config.js";
import { DecisionError } from "./errors.js";

export type QuestionInstructions = string | Record<string, unknown>;

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: QuestionInstructions;
  readonly criteria?: { readonly true: unknown; readonly false: unknown };
}

export interface ChoiceQuestion<K extends string = string> {
  readonly type: "choice";
  readonly instructions: QuestionInstructions;
  readonly criteria: Readonly<Record<K, unknown>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: QuestionInstructions;
  readonly criteria: readonly unknown[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionMap = Record<string, DecisionQuestion>;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type AnswerFor<Q extends DecisionQuestion> =
  Q extends NoulQuestion ? NoulAnswer :
  Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K> :
  Q extends ScoreQuestion ? ScoreAnswer :
  never;

export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface DecisionResult<Q extends QuestionMap> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: DecisionUsage | null;
}

export function noul(
  instructions: QuestionInstructions,
  criteria?: { readonly true: unknown; readonly false: unknown },
): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice<const C extends Record<string, unknown>>(
  instructions: QuestionInstructions,
  criteria: C,
): ChoiceQuestion<Extract<keyof C, string>> {
  const keys = Object.keys(criteria);
  if (keys.length < 2) {
    throw new DecisionError("Choice question requires at least two criteria options", "invalid_config");
  }
  return { type: "choice", instructions, criteria };
}

export function score(
  instructions: QuestionInstructions,
  criteria: readonly unknown[],
): ScoreQuestion {
  if (criteria.length < 2) {
    throw new DecisionError("Score question requires at least two ordered criteria levels", "invalid_config");
  }
  return { type: "score", instructions, criteria };
}

const probabilitySchema = z.number().finite().min(0).max(1);
const nonNegIntSchema = z.number().int().min(0);

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: probabilitySchema,
});

export function parseUsage(raw: unknown): DecisionUsage | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new DecisionError("Decision model returned invalid usage metadata", "invalid_response");
  }
  const record = raw as Record<string, unknown>;
  const inputRaw = record.input_tokens ?? record.prompt_tokens;
  const outputRaw = record.output_tokens ?? record.completion_tokens;
  const parsedInput = nonNegIntSchema.safeParse(inputRaw);
  const parsedOutput = nonNegIntSchema.safeParse(outputRaw);
  if (!parsedInput.success || !parsedOutput.success) {
    throw new DecisionError("Decision model returned invalid usage metadata", "invalid_response");
  }
  return { input_tokens: parsedInput.data, output_tokens: parsedOutput.data };
}

function validateProbabilitySum(entries: [string, number][]): void {
  // Allow 2-decimal rounding drift across declared options (up to 0.005 per option) while rejecting malformed sums.
  const sumTolerance = Math.max(0.03, entries.length * 0.005 + 0.005);
  const sum = entries.reduce((acc, [, p]) => acc + p, 0);
  if (Math.abs(sum - 1) > sumTolerance) {
    throw new DecisionError("Decision model returned invalid probability distribution", "invalid_response");
  }
}

function parseSingleAnswer(question: DecisionQuestion, raw: unknown): NoulAnswer | ChoiceAnswer | ScoreAnswer {
  if (question.type === "noul") {
    const parsed = noulAnswerSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DecisionError("Decision model returned invalid noul answer", "invalid_response");
    }
    return { type: "noul", noul: parsed.data.noul };
  }

  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    if (labels.length < 2) {
      throw new DecisionError("Choice question requires at least two criteria options", "invalid_config");
    }
    const probShape = Object.fromEntries(labels.map(label => [label, probabilitySchema]));
    const choiceSchema = z.object({
      type: z.literal("choice"),
      choice: z.enum(labels as [string, ...string[]]),
      confidence: probabilitySchema,
      probabilities: z.object(probShape).strict(),
    });
    const parsed = choiceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DecisionError("Decision model returned invalid choice answer", "invalid_response");
    }
    const probabilities = Object.fromEntries(
      labels.map(label => [label, parsed.data.probabilities[label]!]),
    );
    validateProbabilitySum(Object.entries(probabilities));
    return {
      type: "choice",
      choice: parsed.data.choice,
      confidence: parsed.data.confidence,
      probabilities,
    };
  }

  const levelCount = question.criteria.length;
  if (levelCount < 2) {
    throw new DecisionError("Score question requires at least two ordered criteria levels", "invalid_config");
  }
  const keys = Array.from({ length: levelCount }, (_, i) => String(i));
  const probShape = Object.fromEntries(keys.map(k => [k, probabilitySchema]));
  const scoreSchema = z.object({
    type: z.literal("score"),
    score: z.number().finite().min(0).max(levelCount - 1),
    confidence: probabilitySchema,
    probabilities: z.object(probShape).strict(),
  });
  const parsed = scoreSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DecisionError("Decision model returned invalid score answer", "invalid_response");
  }
  const probabilities = Object.fromEntries(keys.map(k => [k, parsed.data.probabilities[k]!]));
  const entries = Object.entries(probabilities);
  validateProbabilitySum(entries);
  const expectedScore = entries.reduce((sum, [k, p]) => sum + Number(k) * p, 0);
  if (Math.abs(expectedScore - parsed.data.score) > 0.06) {
    throw new DecisionError("Decision model returned inconsistent score distribution", "invalid_response");
  }
  return {
    type: "score",
    score: parsed.data.score,
    confidence: parsed.data.confidence,
    probabilities,
  };
}

export function parseDecisionResponse<Q extends QuestionMap>(
  payload: unknown,
  questions: Q,
  requestedModel: string,
  validateModel = true,
): DecisionResult<Q> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DecisionError("Decision model returned non-object payload", "invalid_response");
  }
  const record = payload as Record<string, unknown>;
  if (validateModel) {
    if (!matchesDecisionModel(record.model, requestedModel)) {
      throw new DecisionError("Decision model returned unexpected model", "invalid_response");
    }
  } else if (record.model !== undefined && (typeof record.model !== "string" || !record.model)) {
    throw new DecisionError("Decision model returned invalid model field", "invalid_response");
  }
  const rawAnswers = record.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new DecisionError("Decision model returned missing answers", "invalid_response");
  }
  const answerRecord = rawAnswers as Record<string, unknown>;
  const expectedKeys = Object.keys(questions);
  const actualKeys = Object.keys(answerRecord);
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some(k => !Object.hasOwn(answerRecord, k))) {
    throw new DecisionError("Decision model returned unexpected answer keys", "invalid_response");
  }

  const projected: Record<string, NoulAnswer | ChoiceAnswer | ScoreAnswer> = {};
  for (const key of expectedKeys) {
    projected[key] = parseSingleAnswer(questions[key]!, answerRecord[key]);
  }

  return {
    model: typeof record.model === "string" && record.model ? record.model : requestedModel,
    answers: projected as { [K in keyof Q]: AnswerFor<Q[K]> },
    usage: parseUsage(record.usage),
  };
}
