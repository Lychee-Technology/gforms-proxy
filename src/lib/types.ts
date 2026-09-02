export interface ValidationInfo {
  type: string;
  operator: string;
  values: string[];
  customErrorMessage?: string;
}

export interface GridRow {
  label: string;
  entryId: string; // "entry.XXXXXXX" for this row
}

export interface FieldDetail {
  label: string;
  typeCode?: number;
  typeLabel: string;
  options: string[];
  required: boolean;
  helpText?: string;
  validation?: ValidationInfo | null;
  entryId: string;
  // Grid questions only: one entry per row. `entryId` above is the first
  // row's ID for those, so callers that only know one ID keep working.
  rows?: GridRow[];
}

export interface FieldSchemaDetail {
  question: string;
  translated_question: string;
  key: string;
  entry_id: string;
  type: string;
  type_code: number | null;
  options: string[];
  required: boolean;
  help_text: string;
  validation: ValidationInfo | null;
  rows: GridRow[];
}

export type JsonSchemaProperty = Record<string, unknown>;

export interface FieldMeta {
  title: string;
  key: string;
  translated: string;
}

export interface RawFormData {
  formTitle: string;
  formId: string;
  fields: FieldDetail[];
}

/**
 * How a schema key reaches Google's formResponse endpoint (ADR 0003, 0008).
 * A plain string is the original one-parameter mapping and is what both
 * bundled definitions use. The object forms exist because the submitter
 * cannot infer the encoding from the value: a short-answer string
 * "2026-01-05" goes out verbatim, a date must be split into three parameters.
 */
export type FieldMapping =
  | string
  | { kind: 'date'; entryId: string } // entry.X_year / entry.X_month / entry.X_day
  | { kind: 'time'; entryId: string } // entry.X_hour / entry.X_minute
  | { kind: 'grid'; rows: Record<string, string> }; // row key → entry.<rowId>

export interface FormDefinition {
  formId: string;
  submissionUrl: string;
  schema: Record<string, unknown>;
  fieldMap: Record<string, FieldMapping>; // schemaKey → wire mapping
  turnstileEnabled?: boolean;
}

// Google's type codes as observed in FB_PUBLIC_LOAD_DATA_ (see
// google-forms-internals.md). 6 is a title/description block with no entry,
// so it is deliberately absent. 3 and 4 are known to be swapped (#39).
export const QUESTION_TYPE_MAP: Record<number, string> = {
  0: 'short_answer',
  1: 'paragraph',
  2: 'multiple_choice',
  3: 'checkboxes',
  4: 'dropdown',
  5: 'linear_scale',
  7: 'multiple_choice_grid',
  9: 'date',
  10: 'time',
  18: 'rating',
};

// Labels the parser derives from per-entry flags rather than the type code:
// a grid whose rows accept several columns, and the date/time variants the
// schema vocabulary cannot express (refused by scripts/field-support.ts).
export const FLAG_DERIVED_TYPE_LABELS = {
  checkboxGrid: 'checkbox_grid',
  dateTime: 'date_time',
  dateWithoutYear: 'date_without_year',
  duration: 'duration',
} as const;

export const ValidationTypeMap: Record<number, string> = {
  1: 'number',
  2: 'text',
  6: 'length',
  4: 'regular_expression',
};

export const numberValidationTypes: Record<number, string> = {
  1: '>',
  2: '>=',
  3: '<',
  4: '<=',
  5: '=',
  6: '!=',
  7: 'between',
  8: 'not_between',
  9: 'is_number',
  10: 'is_whole_number',
};

export const textValidationTypes: Record<number, string> = {
  102: 'email',
  103: 'url',
  100: 'contains',
  101: 'does_not_contain',
};

export const lengthValidationTypes: Record<number, string> = {
  203: 'min',
  202: 'max',
};

export const regexValidationTypes: Record<number, string> = {
  301: 'matches',
  302: 'does_not_match',
  299: 'contains',
  300: 'does_not_contain',
};
