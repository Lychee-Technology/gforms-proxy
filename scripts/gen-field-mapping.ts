import axios from 'axios';
import chalk from 'chalk';
import ora from 'ora';
import { input } from '@inquirer/prompts';
import { GoogleGenAI } from '@google/genai';


type FieldInfo = {
    Question: string;
    Key: string;
    Translated: string;
    Type: string;
    EntryID: string;
};

const DEFAULT_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview';

type FieldMeta = { title: string; key: string; translated: string };
type FieldDetail = {
    label: string;
    typeCode?: number;
    typeLabel: string;
    options: string[];
    required: boolean;
    helpText?: string;
    validation?: ValidationInfo | null;
    entryId: string;
};

type FieldSchemaDetail = {
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
};

type JsonSchemaProperty = Record<string, unknown>;

type FormMeta = { translated: string };

const normalizeKey = (value: string, fallbackLabel: string) => {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);

    if (normalized) return normalized;

    const fallback = fallbackLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);

    return fallback || 'field';
};

const parseGeminiText = <T>(text: string): T => {
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned) as T;
};

const QUESTION_TYPE_MAP: Record<number, string> = {
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

// TODO: 完善更多类型的选项
// * date: 是否包含年、是否包含时间
// * time: duration
// * checkbox grid: 多选网格


const ValidationTypeMap: Record<number, string> = {
    1: 'number',
    2: 'text',
    6: 'length',
    4: 'regular_expression'
}

const numberValidationTypes: Record<number, string> = {
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
}

const textValidationTypes: Record<number, string> = {
    102: 'email',
    103: 'url',
    100: 'contains',
    101: 'does_not_contain',
}

const lengthValidationTypes: Record<number, string> = {
    203: 'min',
    202: 'max',
}

const regexValidationTypes: Record<number, string> = {
    301: 'matches',
    302: 'does_not_match',
    299: 'contains',
    300: 'does_not_contain',
};

interface ValidationInfo {
    type: string;
    operator: string;
    values: string[];
    customErrorMessage?: string;
}

const getQuestionTypeLabel = (label: string, code?: number) => {
    if (typeof code !== 'number') {
        console.log('Unknown question type code:', code);
        return 'unknown';
    }
    const type = QUESTION_TYPE_MAP[code];
    if (type) {
        return type;
    }
    console.log(`Unmapped question type code: ${code}, label: ${label}`);
    return 'unknown';
}

const extractOptions = (entryData: any): string[] => {
    const options = entryData?.[0]?.[1];
    if (!Array.isArray(options)) return [];

    return options
        .map((opt: any) => {
            if (typeof opt === 'string') return opt;
            if (Array.isArray(opt)) {
                if (typeof opt[0] === 'string') return opt[0];
                if (Array.isArray(opt[0]) && typeof opt[0][0] === 'string') return opt[0][0];
            }
            if (opt && typeof opt.option === 'string') return opt.option;
            return null;
        })
        .filter((v: string | null): v is string => Boolean(v));
};

const extractValidation = (entryData: any): ValidationInfo | null => {
    const rawData = entryData?.[0]?.[3] ?? entryData?.[0]?.[4] ?? null;
    if (!rawData) {
        return null;
    }
    if (!Array.isArray(rawData)) {
        return null;
    }
    const data = rawData[0];

    if (!Array.isArray(data)) {
        return null;
    }
    const typeCode = data[0];

    const typeLabel = ValidationTypeMap[typeCode];

    if (!typeLabel) {
        return null;
    }
    let operator = '';
    const values: string[] = [];

    switch (typeLabel) {
        case 'number': {
            const operatorCode = data[1];
            operator = numberValidationTypes[operatorCode];
            if (!operator) {
                return null;
            }
            const parameters = data[2];


            if (operator === 'between' || operator === 'not_between') {
                if (!Array.isArray(parameters) || parameters.length < 2) {
                    console.log(`Insufficient parameters for number ${operator} validation`);
                    return null;
                }

                values.push(String(parameters[0]), String(parameters[1]));
            } else if (operator !== 'is_number' && operator !== 'whole_number') {
                if (!Array.isArray(parameters) || parameters.length < 1) {
                    console.log(`Insufficient parameters for number ${operator} validation`);
                    return null;
                }
                values.push(String(parameters[0]));
            }
            break;
        }
        case 'text': {
            const operatorCode = data[1];
            operator = textValidationTypes[operatorCode];
            if (!operator) {
                return null;
            }
            if (operator === 'contains' || operator === 'does_not_contain') {
                const parameters = data[2];

                if (!Array.isArray(parameters) || parameters.length === 0) {
                    console.log('No parameters for text contains/does_not_contain validation');

                    return null;
                }
                values.push(String(parameters[0]));
            }
            break;
        }
        case 'length': {
            const operatorCode = data[1];
            operator = lengthValidationTypes[operatorCode];
            if (!operator) {
                return null;
            }
            const parameters = data[2];
            if (!Array.isArray(parameters) || parameters.length === 0) {
                console.log('No parameters for length validation, operator:', operator);
                return null;
            }
            values.push(String(parameters[0]));
            break;
        }
        case 'regular_expression': {
            const operatorCode = data[1];
            operator = regexValidationTypes[operatorCode];
            if (!operator) {
                return null;
            }
            const parameters = data[2];

            if (!Array.isArray(parameters) || parameters.length === 0) {
                console.log('No parameters for regular_expression validation, operator:', operator);
                return null;
            }
            values.push(String(parameters[0]));
            break;
        }
        default:
            return null;
    }

    return {
        type: typeLabel,
        operator,
        values,
        customErrorMessage: typeof data[3] === 'string' ? data[3] : undefined,
    }
}

const isRequired = (entryData: any): boolean => Boolean(entryData?.[0]?.[2]);

const asNumber = (value: string): number | null => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

const getNumericRange = (options: string[]) => {
    const numbers = options
        .map(asNumber)
        .filter((n): n is number => n !== null);

    if (!numbers.length) return null;
    return { min: Math.min(...numbers), max: Math.max(...numbers) };
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const addPattern = (schema: JsonSchemaProperty, pattern: string) => {
    if (!pattern) return;
    if (schema.pattern) {
        const existingAllOf = Array.isArray(schema.allOf) ? schema.allOf : [];
        const existingPattern = schema.pattern;
        delete schema.pattern;
        schema.allOf = [...existingAllOf, { pattern: existingPattern }, { pattern }];
        return;
    }

    if (Array.isArray(schema.allOf)) {
        schema.allOf.push({ pattern });
        return;
    }

    schema.pattern = pattern;
};

const addNotConstraint = (schema: JsonSchemaProperty, constraint: Record<string, unknown>) => {
    const existingAllOf = Array.isArray(schema.allOf) ? schema.allOf : [];
    schema.allOf = [...existingAllOf, { not: constraint }];
};

const applyValidationToSchema = (property: JsonSchemaProperty, field: FieldSchemaDetail): JsonSchemaProperty => {
    const validation = field.validation;
    if (!validation) return property;

    const schema = { ...property };

    const isTypeArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
    const typeList = isTypeArray(schema.type) ? schema.type : schema.type ? [schema.type as string] : [];
    const canApplyNumber = !schema.type || typeList.some((t) => ['string', 'number', 'integer'].includes(t));
    const canApplyString = !schema.type || typeList.some((t) => t === 'string');

    const setNumberType = (isInteger: boolean) => {
        schema.type = isInteger ? 'integer' : 'number';
    };

    const setMin = (key: 'minimum' | 'exclusiveMinimum', value: number) => {
        const current = typeof schema[key] === 'number' ? schema[key] as number : null;
        if (current === null || value > current) {
            schema[key] = value;
        }
    };

    const setMax = (key: 'maximum' | 'exclusiveMaximum', value: number) => {
        const current = typeof schema[key] === 'number' ? schema[key] as number : null;
        if (current === null || value < current) {
            schema[key] = value;
        }
    };

    const ensureStringType = () => {
        if (!schema.type) {
            schema.type = 'string';
        }
    };

    switch (validation.type) {
        case 'number': {
            if (!canApplyNumber) return property;
            const [first, second] = validation.values.map(asNumber);
            const primary = first ?? 0;
            const secondary = second ?? 0;
            setNumberType(validation.operator === 'is_whole_number');

            switch (validation.operator) {
                case '>':
                    setMin('exclusiveMinimum', primary);
                    break;
                case '>=':
                    setMin('minimum', primary);
                    break;
                case '<':
                    setMax('exclusiveMaximum', primary);
                    break;
                case '<=':
                    setMax('maximum', primary);
                    break;
                case '=':
                    schema.const = primary;
                    break;
                case '!=':
                    addNotConstraint(schema, { const: primary });
                    break;
                case 'between':
                    if (first !== null) setMin('minimum', first);
                    if (second !== null) setMax('maximum', second);
                    break;
                case 'not_between':
                    if (first !== null && second !== null) {
                        schema.anyOf = [
                            { exclusiveMaximum: Math.min(first, second) },
                            { exclusiveMinimum: Math.max(first, second) },
                        ];
                    }
                    break;
                case 'is_number':
                case 'is_whole_number':
                default:
                    break;
            }
            break;
        }
        case 'length': {
            if (!canApplyString) return property;
            ensureStringType();
            const target = asNumber(validation.values[0]);
            if (target === null) break;

            if (validation.operator === 'min') {
                const current = typeof schema.minLength === 'number' ? schema.minLength : null;
                if (current === null || target > current) {
                    schema.minLength = target;
                }
            } else if (validation.operator === 'max') {
                const current = typeof schema.maxLength === 'number' ? schema.maxLength : null;
                if (current === null || target < current) {
                    schema.maxLength = target;
                }
            }
            break;
        }
        case 'text': {
            if (!canApplyString) return property;
            ensureStringType();
            switch (validation.operator) {
                case 'email':
                    schema.format = 'email';
                    break;
                case 'url':
                    schema.format = 'uri';
                    break;
                case 'contains': {
                    const value = validation.values[0];
                    if (value) addPattern(schema, `.*${escapeRegExp(value)}.*`);
                    break;
                }
                case 'does_not_contain': {
                    const value = validation.values[0];
                    if (value) addNotConstraint(schema, { pattern: `.*${escapeRegExp(value)}.*` });
                    break;
                }
                default:
                    break;
            }
            break;
        }
        case 'regular_expression': {
            if (!canApplyString) return property;
            ensureStringType();
            const raw = validation.values[0];
            if (!raw) break;

            if (validation.operator === 'matches' || validation.operator === 'contains') {
                addPattern(schema, raw);
            } else if (validation.operator === 'does_not_match' || validation.operator === 'does_not_contain') {
                addNotConstraint(schema, { pattern: raw });
            }
            break;
        }
        default:
            break;
    }

    return schema;
};

const buildFieldPropertySchema = (field: FieldSchemaDetail): JsonSchemaProperty => {
    const base: JsonSchemaProperty = {
        title: field.entry_id,
        description: field.question,
    };

    const hasOptions = Array.isArray(field.options) && field.options.length > 0;

    switch (field.type) {
        case 'multiple_choice':
        case 'dropdown':
            return applyValidationToSchema({
                ...base,
                type: 'string',
                ...(field.required ? { minLength: 1 } : {}),
                ...(hasOptions ? { enum: field.options } : {}),
            }, field);
        case 'checkboxes':
            return applyValidationToSchema({
                ...base,
                type: 'array',
                items: {
                    type: 'string',
                    ...(hasOptions ? { enum: field.options } : {}),
                },
                uniqueItems: true,
                ...(field.required ? { minItems: 1 } : {}),
            }, field);
        case 'linear_scale': {
            const numericRange = getNumericRange(field.options);
            return applyValidationToSchema({
                ...base,
                type: 'integer',
                ...(numericRange ? { minimum: numericRange.min, maximum: numericRange.max } : {}),
            }, field);
        }
        case 'date':
            return applyValidationToSchema({ ...base, type: 'string', format: 'date' }, field);
        case 'time':
            return applyValidationToSchema({ ...base, type: 'string', format: 'time' }, field);
        case 'multiple_choice_grid':
        case 'grid':
            return applyValidationToSchema({
                ...base,
                type: 'object',
                additionalProperties: {
                    type: 'string',
                    ...(hasOptions ? { enum: field.options } : {}),
                },
            }, field);
        default: {
            const isText = field.type === 'short_answer' || field.type === 'paragraph';
            const property: JsonSchemaProperty = {
                ...base,
                type: isText ? 'string' : 'string',
            };

            if (isText && field.required) {
                property.minLength = 1;
            }

            if (hasOptions && property.type === 'string') {
                property.enum = field.options;
            }

            return applyValidationToSchema(property, field);
        }
    }
};

const buildGeminiPrompt = (questions: string[]) =>
    [
        'You are generating concise metadata for Google Forms questions.',
        'Return ONLY a JSON array; each element corresponds to the matching input question in order.',
        'Each element must have "title", "key", and "translated".',
        'title: concise English (<= 6 words), human-readable summary.',
        'key: snake_case, ASCII letters/numbers/underscores only, 3-30 chars, derived from meaning.',
        'translated: a faithful English translation of the original question (not shortened).',
        'No explanations or extra fields.',
        'Questions:',
        ...questions.map((q, idx) => `${idx + 1}. ${q}`),
    ].join('\n');

async function buildFieldsMeta(questions: string[], client: GoogleGenAI | null): Promise<FieldMeta[]> {
    const fallback = questions.map((q, idx) => ({
        title: q,
        key: `field_${idx + 1}`,
        translated: q,
    }));

    if (!client || !questions.length) {
        return fallback;
    }

    try {
        const result = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
                {
                    role: 'user',
                    parts: [{ text: buildGeminiPrompt(questions) }],
                },
            ],
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            title: {
                                type: 'string',
                                description: 'Concise, <=6 word English summary of the question.',
                            },
                            key: {
                                type: 'string',
                                description: 'Snake_case, 3-30 chars, ASCII letters/numbers/underscores only.',
                            },
                            translated: {
                                type: 'string',
                                description: 'Faithful English translation of the original question.',
                            },
                        },
                        required: ['title', 'key', 'translated'],
                    },
                }
            },
        });

        const text = result?.text;

        if (!text) {
            throw new Error('Empty Gemini response');
        }

        const parsed = parseGeminiText<Array<Record<string, unknown>>>(text);

        return questions.map((q, idx) => {
            const item = parsed?.[idx] ?? {};
            const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : q;
            const key = normalizeKey(typeof item.key === 'string' ? item.key : title, q);
            const translated =
                typeof item.translated === 'string' && item.translated.trim() ? item.translated.trim() : q;
            return { title, key, translated };
        });
    } catch (error) {
        return fallback;
    }
}

const buildFormSchema = (fields: FieldSchemaDetail[], formTitle: string, formMeta: FormMeta, formId: string) => {
    const properties: Record<string, JsonSchemaProperty> = {};

    for (const field of fields) {
        properties[field.key] = buildFieldPropertySchema(field);
    }

    const requiredKeys = fields.filter((field) => field.required).map((field) => field.key);

    const schema: Record<string, unknown> = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: formMeta.translated || formTitle,
        description: formTitle,
        type: 'object',
        additionalProperties: false,
        properties,
    };

    if (formId) {
        schema.$id = `https://docs.google.com/forms/d/e/${formId}/schema`;
    }

    if (requiredKeys.length) {
        schema.required = requiredKeys;
    }

    return schema;
};

const extractFormTitle = (html: string): string | null => {
    const match = html.match(/<title>([^<]+)<\/title>/i);
    if (!match || !match[1]) return null;
    return match[1].replace(/\s*-\s*Google Forms\s*$/i, '').trim();
};

async function buildFormMeta(title: string, client: GoogleGenAI | null): Promise<FormMeta> {
    if (!client) return { translated: title };

    try {
        const result = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
                {
                    role: 'user',
                    parts: [{
                        text: [
                            'Translate the following Google Form title into clear English.',
                            'Return JSON with a single property "translated".',
                            'No explanations.',
                            `Title: ${title}`,
                        ].join('\n')
                    }],
                },
            ],
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'object',
                    properties: {
                        translated: { type: 'string', description: 'Translated form title' },
                    },
                    required: ['translated'],
                },
            },
        });

        const text = result?.text;
        if (!text) throw new Error('Empty Gemini response');

        const parsed = parseGeminiText<Record<string, unknown>>(text);
        const translated = typeof parsed.translated === 'string' && parsed.translated.trim()
            ? parsed.translated.trim()
            : title;
        return { translated };
    } catch {
        return { translated: title };
    }
}

// 欢迎标语
console.log(chalk.cyan.bold('\n🚀 Google Forms Field Mapper\n'));

async function run() {
    // 1. 获取用户输入
    // const formUrl = await input({
    //     message: 'Enter the public Google Form link (e.g., https://docs.google.com/.../viewform):',
    //     validate: (value) => value.includes('docs.google.com') ? true : 'Please enter a valid Google Forms link',
    // });
    const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSc7-6X32gbpKiJ32sm2egZzxrwxmxKqL707nSwnthgS1aqntA/viewform';
    const geminiApiKeyInput = await input({
        message: 'Enter GEMINI_API_KEY (optional, press Enter to skip):',
        default: DEFAULT_GEMINI_API_KEY ?? '',
    });
    const geminiApiKey = geminiApiKeyInput.trim();
    const geminiClient = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

    const spinner = ora('Fetching form structure...').start();

    try {
        // 2. 获取 HTML 内容
        const response = await axios.get<string>(formUrl);
        const html = response.data;
        const formTitle = extractFormTitle(html) ?? 'Google Form';

        // 3. 解析 FB_PUBLIC_LOAD_DATA_
        // Google Forms 将表单结构存储在这个全局变量中
        const regex = /var FB_PUBLIC_LOAD_DATA_ = (\[.+?\]);\s*<\/script>/;
        const match = html.match(regex);

        if (!match || !match[1]) {
            spinner.fail('Could not parse form data. Make sure the link is correct and the form is public.');
            return;
        }

        const data = JSON.parse(match[1]) as any;

        // 4. 提取字段信息
        // 这是一个复杂的嵌套数组，通常 structure 在 data[1][1]
        const formFields = (data?.[1]?.[1] ?? []) as any[];
        const readableList: FieldInfo[] = [];
        const fields: FieldDetail[] = [];

        if (!formFields.length) {
            spinner.fail('No field information found.');
            return;
        }

        for (const field of formFields) {
            // 过滤掉非输入项（如标题、图片说明等）
            // field[1] 是显示的 Label (Question Title)
            // field[4] 包含 ID 信息，通常在 field[4][0][0]
            const label = field?.[1] as string | undefined;
            const entryData = field?.[4] as any[] | undefined;
            const typeCode = typeof field?.[3] === 'number' ? field[3] : undefined;
            const typeLabel = getQuestionTypeLabel(label ?? '', typeCode);
            const options = extractOptions(entryData);
            const required = isRequired(entryData);
            const validation = extractValidation(entryData);
            const helpText = typeof field?.[2] === 'string' ? field[2] : undefined;

            const entryIdValue = entryData?.[0]?.[0];

            if (label && entryIdValue !== undefined) {
                const entryId = `entry.${String(entryIdValue)}`;
                fields.push({ label, entryId, typeCode, typeLabel, options, required, validation, helpText });
            }
        }

        const metas = await buildFieldsMeta(fields.map((f) => f.label), geminiClient);

        const fieldDetails: FieldSchemaDetail[] = fields.map((field, idx) => {
            const meta = metas[idx] ?? { title: field.label, key: `field_${idx + 1}`, translated: field.label };

            readableList.push({
                Question: field.label,
                Key: meta.key,
                Translated: meta.translated,
                Type: field.typeLabel,
                EntryID: field.entryId
            });

            return {
                question: field.label,
                translated_question: meta.translated,
                key: meta.key,
                entry_id: field.entryId,
                type: field.typeLabel,
                type_code: field.typeCode ?? null,
                options: field.options,
                required: field.required,
                help_text: field.helpText ?? '',
                validation: field.validation ?? null,
            };
        });

        const formMeta = await buildFormMeta(formTitle, geminiClient);
        const formIdMatch = formUrl.match(/\/d\/e\/([a-zA-Z0-9_-]+)\//);
        const formId = formIdMatch ? formIdMatch[1] : '';

        const jsonSchema = buildFormSchema(fieldDetails, formTitle, formMeta, formId);

        spinner.succeed('Parsed successfully!\n');

        // 5. 输出结果
        console.log(chalk.yellow('📋 Detected fields:'));
        console.table(readableList);

        console.log(chalk.yellow('🧪 Raw validation data:'));
        const validationList = fieldDetails.map((field) => ({
            Question: field.question,
            Key: field.key,
            Validation: field.validation === null ? '' : JSON.stringify(field.validation),
        }));
        console.table(validationList);

        console.log(chalk.green('\n✅ JSON Schema (Draft 2020-12):'));
        console.log(chalk.gray('---------------------------------------------------'));
        console.log(JSON.stringify(jsonSchema, null, 2));
        console.log(chalk.gray('---------------------------------------------------'));

        if (formId) {
            console.log(chalk.blue(`\n💡 Remember to set GOOGLE_FORM_ID: ${formId}`));
        }

    } catch (error: unknown) {
        spinner.fail('An error occurred');
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
    }
}

run();
