import { z } from "zod";
import { matchesDecisionModel } from "./config.js";
import { DecisionError } from "./errors.js";
import { parseUsage, type DecisionUsage, type QuestionInstructions } from "./questions.js";

export interface TextField {
  readonly type: "text";
  readonly instructions?: QuestionInstructions;
  readonly null_threshold?: number;
}

export interface NumberField {
  readonly type: "number";
  readonly instructions?: QuestionInstructions;
  readonly decimals?: number;
  readonly null_threshold?: number;
}

export interface DateField {
  readonly type: "date";
  readonly instructions?: QuestionInstructions;
  readonly null_threshold?: number;
}

export interface EstimateField {
  readonly type: "estimate";
  readonly instructions?: QuestionInstructions;
  readonly unit?: string;
}

export interface ListField {
  readonly type: "list";
  readonly instructions?: QuestionInstructions;
  readonly items?: unknown;
}

export type ExtractionField = TextField | NumberField | DateField | EstimateField | ListField;
export type FieldMap = Record<string, ExtractionField>;

export interface ExtractionAsset {
  readonly type: "image";
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
  readonly data: string;
}

export interface ScalarExtractionAnswer<T> {
  type: "text" | "number" | "date";
  value: T | null;
  p_null?: number;
  confidence?: number;
  guess?: T | null;
  span?: [number, number];
  source?: string;
  spell_confidence?: number;
}

export interface EstimateExtractionAnswer {
  type: "estimate";
  value?: number | null;
  mean?: number;
  median?: number;
  p10?: number;
  p90?: number;
  confidence?: number;
}

export interface ListExtractionAnswer {
  type: "list";
  value: unknown[] | null;
  confidence?: number;
  p_null?: number;
}

export type ExtractionAnswerFor<F extends ExtractionField> =
  F extends TextField ? ScalarExtractionAnswer<string> :
  F extends NumberField ? ScalarExtractionAnswer<number> :
  F extends DateField ? ScalarExtractionAnswer<string> :
  F extends EstimateField ? EstimateExtractionAnswer :
  F extends ListField ? ListExtractionAnswer :
  never;

export interface ExtractionResult<F extends FieldMap> {
  model: string;
  answers: { [K in keyof F]: ExtractionAnswerFor<F[K]> };
  usage: DecisionUsage | null;
}

export function textField(options: Omit<TextField, "type"> = {}): TextField {
  return { type: "text", ...options };
}

export function numberField(options: Omit<NumberField, "type"> = {}): NumberField {
  return { type: "number", ...options };
}

export function dateField(options: Omit<DateField, "type"> = {}): DateField {
  return { type: "date", ...options };
}

export function estimateField(options: Omit<EstimateField, "type"> = {}): EstimateField {
  return { type: "estimate", ...options };
}

export function listField(options: Omit<ListField, "type"> = {}): ListField {
  return { type: "list", ...options };
}

function isLiquidD12Model(model: string): boolean {
  return /^liquid\/d1\.2(?:-|$)/u.test(model);
}

/**
 * Validates extraction fields & image asset constraints before making a paid request.
 * Enforces Liquid d1.2 / d1.2-ultra rules (null_threshold > 0 on text/number/date,
 * rejected on estimate/list, and image assets allowed only with estimate fields).
 */
export function validateExtractionRequest(
  model: string,
  fields: FieldMap,
  assets?: readonly ExtractionAsset[],
): void {
  const entries = Object.entries(fields);
  if (!entries.length) {
    throw new DecisionError("Extraction request requires at least one field", "invalid_config");
  }
  if (assets && assets.length > 8) {
    throw new DecisionError("Extraction request accepts at most 8 image assets", "invalid_config");
  }
  const d12 = isLiquidD12Model(model);
  for (const [name, field] of entries) {
    if (d12 && assets && assets.length > 0 && field.type !== "estimate") {
      throw new DecisionError(`Model ${model} only supports image assets with estimate fields, not "${name}" (${field.type})`, "invalid_config");
    }
    if (field.type === "text" || field.type === "number" || field.type === "date") {
      if (field.null_threshold !== undefined) {
        if (typeof field.null_threshold !== "number" || !Number.isFinite(field.null_threshold) ||
          field.null_threshold <= 0 || field.null_threshold >= 1) {
          throw new DecisionError(`Extraction field "${name}" null_threshold must be strictly between 0 and 1`, "invalid_config");
        }
      } else if (d12) {
        throw new DecisionError(`Extraction field "${name}" (${field.type}) requires null_threshold > 0 for ${model}`, "invalid_config");
      }
    } else if ("null_threshold" in field && (field as Record<string, unknown>).null_threshold !== undefined) {
      throw new DecisionError(`Extraction field "${name}" (${field.type}) does not accept null_threshold`, "invalid_config");
    }
  }
}

const probOpt = z.number().finite().min(0).max(1).optional();
const spanOpt = z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional();

function parseExtractionAnswer(
  field: ExtractionField,
  raw: unknown,
): ScalarExtractionAnswer<string> | ScalarExtractionAnswer<number> | EstimateExtractionAnswer | ListExtractionAnswer {
  if (field.type === "text" || field.type === "date") {
    const schema = z.object({
      type: z.literal(field.type).optional(),
      value: z.string().nullable(),
      p_null: probOpt,
      confidence: probOpt,
      guess: z.string().nullable().optional(),
      span: spanOpt,
      source: z.string().optional(),
      spell_confidence: probOpt,
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DecisionError(`Extraction returned invalid ${field.type} answer`, "invalid_response");
    return { ...parsed.data, type: field.type };
  }
  if (field.type === "number") {
    const schema = z.object({
      type: z.literal("number").optional(),
      value: z.number().finite().nullable(),
      p_null: probOpt,
      confidence: probOpt,
      guess: z.number().finite().nullable().optional(),
      span: spanOpt,
      source: z.string().optional(),
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DecisionError("Extraction returned invalid number answer", "invalid_response");
    return { ...parsed.data, type: "number" };
  }
  if (field.type === "estimate") {
    const finiteOpt = z.number().finite().optional();
    const schema = z.object({
      type: z.literal("estimate").optional(),
      value: z.number().finite().nullable().optional(),
      mean: finiteOpt,
      median: finiteOpt,
      p10: finiteOpt,
      p90: finiteOpt,
      confidence: probOpt,
    });
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new DecisionError("Extraction returned invalid estimate answer", "invalid_response");
    return { ...parsed.data, type: "estimate" };
  }
  const listSchema = z.object({
    type: z.literal("list").optional(),
    value: z.array(z.unknown()).nullable(),
    confidence: probOpt,
    p_null: probOpt,
  });
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) throw new DecisionError("Extraction returned invalid list answer", "invalid_response");
  return { ...parsed.data, type: "list" };
}

export function parseExtractionResponse<F extends FieldMap>(
  payload: unknown,
  fields: F,
  requestedModel: string,
  validateModel = true,
): ExtractionResult<F> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DecisionError("Extraction model returned non-object payload", "invalid_response");
  }
  const record = payload as Record<string, unknown>;
  if (validateModel) {
    if (!matchesDecisionModel(record.model, requestedModel)) {
      throw new DecisionError("Extraction model returned unexpected model", "invalid_response");
    }
  } else if (record.model !== undefined && (typeof record.model !== "string" || !record.model)) {
    throw new DecisionError("Extraction model returned invalid model field", "invalid_response");
  }
  const rawAnswers = record.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new DecisionError("Extraction model returned missing answers", "invalid_response");
  }
  const answerRecord = rawAnswers as Record<string, unknown>;
  const expectedKeys = Object.keys(fields);
  const actualKeys = Object.keys(answerRecord);
  if (actualKeys.length !== expectedKeys.length || expectedKeys.some(k => !Object.hasOwn(answerRecord, k))) {
    throw new DecisionError("Extraction model returned unexpected answer keys", "invalid_response");
  }

  const projected: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    projected[key] = parseExtractionAnswer(fields[key]!, answerRecord[key]);
  }
  return {
    model: typeof record.model === "string" && record.model ? record.model : requestedModel,
    answers: projected as { [K in keyof F]: ExtractionAnswerFor<F[K]> },
    usage: parseUsage(record.usage),
  };
}
