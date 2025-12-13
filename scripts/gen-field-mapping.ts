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
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

type FieldMeta = { title: string; key: string; translated: string };
type FieldDetail = {
    label: string;
    typeCode?: number;
    typeLabel: string;
    options: string[];
    required: boolean;
    helpText?: string;
    validation?: unknown;
    entryId: string;
};

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
    8: 'date',
    9: 'time',
};

const getQuestionTypeLabel = (code?: number) => (typeof code === 'number' ? (QUESTION_TYPE_MAP[code] ?? 'unknown') : 'unknown');

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

const extractValidation = (entryData: any): unknown => entryData?.[0]?.[3] ?? entryData?.[0]?.[4] ?? null;

const isRequired = (entryData: any): boolean => Boolean(entryData?.[0]?.[2]);

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

const extractFormTitle = (html: string): string | null => {
    const match = html.match(/<title>([^<]+)<\/title>/i);
    if (!match || !match[1]) return null;
    return match[1].replace(/\s*-\s*Google Forms\s*$/i, '').trim();
};

type FormMeta = { translated: string };

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
    const formUrl = await input({
        message: 'Enter the public Google Form link (e.g., https://docs.google.com/.../viewform):',
        validate: (value) => value.includes('docs.google.com') ? true : 'Please enter a valid Google Forms link',
    });
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
        const mapping: Record<string, string> = {};
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
            const typeLabel = getQuestionTypeLabel(typeCode);
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

        const fieldDetails = fields.map((field, idx) => {
            const meta = metas[idx] ?? { title: field.label, key: `field_${idx + 1}`, translated: field.label };
            mapping[meta.key] = field.entryId;

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

        const output = {
            form_name: formTitle,
            form_route_key: formMeta.translated,
            form_id: formId,
            field_details: fieldDetails,
        };

        spinner.succeed('Parsed successfully!\n');

        // 5. 输出结果
        console.log(chalk.yellow('📋 Detected fields:'));
        console.table(readableList);

        console.log(chalk.green('\n✅ Copy the JSON below into your Cloudflare Worker config:'));
        console.log(chalk.gray('---------------------------------------------------'));
        console.log(JSON.stringify(output, null, 2));
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
