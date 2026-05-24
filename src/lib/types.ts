export interface ValidationInfo {
  type: string;
  operator: string;
  values: string[];
  customErrorMessage?: string;
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
}

export type JsonSchemaProperty = Record<string, unknown>;

export interface FormMeta {
  translated: string;
}

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

export interface FormDefinition {
  formId: string;
  submissionUrl: string;
  schema: Record<string, unknown>;
  fieldMap: Record<string, string>;  // schemaKey → "entry.XXXXXXX"
  turnstileEnabled?: boolean;
}

export const QUESTION_TYPE_MAP: Record<number, string> = {
  0: 'short_answer',
  1: 'paragraph',
  2: 'multiple_choice',
  3: 'checkboxes',
  4: 'dropdown',
  5: 'linear_scale',
  6: 'grid',
  7: 'multiple_choice_grid',
  9: 'date',
  10: 'time',
  18: 'rating',
};

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
