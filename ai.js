import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
// Set OPENAI_REASONING to an empty string for models without reasoning support.
const EFFORT = process.env.OPENAI_REASONING ?? 'low';

let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  client ??= new OpenAI();
  return client;
}

async function jsonCall(name, schema, system, user) {
  const params = {
    model: MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
  };
  if (EFFORT) params.reasoning = { effort: EFFORT };
  const r = await getClient().responses.create(params);
  return JSON.parse(r.output_text);
}

const MEANINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['senses'],
  properties: {
    senses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pos', 'definition', 'example', 'labels'],
        properties: {
          pos: { type: 'string' },
          definition: { type: 'string' },
          example: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const MEANINGS_SYSTEM = `You are a careful lexicographer writing a learner's dictionary for teenagers living in New Zealand.
Rules:
- Write in simple English only. Never use any other language.
- Only include meanings that are genuinely in current use. Never invent meanings.
- If the term is not a real English word or phrase, return an empty list.
- Include New Zealand, Australian or British informal uses when they exist, and label them (e.g. "NZ", "informal", "slang").
- Each sense: part of speech, one definition (max 25 words), one natural example sentence (max 20 words) that uses the term, and labels (may be empty).
- Use New Zealand spelling.`;

/** Ask the model for meanings; `known` = definitions already shown (to avoid repeats). */
export async function aiMeanings(term, known = []) {
  const user = known.length
    ? `Term: "${term}"\nThese meanings are already listed:\n${known.map((k) => `- ${k}`).join('\n')}\n\nList ONLY common meanings that are missing from this list, especially New Zealand / Australian informal uses. Return an empty list if nothing important is missing.`
    : `Term: "${term}"\nList all common meanings, most frequent first.`;
  const data = await jsonCall('meanings', MEANINGS_SCHEMA, MEANINGS_SYSTEM, user);
  return (data.senses || [])
    .filter((s) => s.definition)
    .map((s) => ({
      headword: term,
      pos: s.pos,
      definition: s.definition.trim(),
      examples: s.example ? [s.example.trim()] : [],
      labels: s.labels || [],
      source: 'ai',
    }));
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['variants', 'distractors'],
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sentence', 'answer'],
        properties: {
          sentence: { type: 'string' },
          answer: { type: 'string' },
        },
      },
    },
    distractors: { type: 'array', items: { type: 'string' } },
  },
};

const REVIEW_SYSTEM = `You create fill-in-the-blank practice for English learners (teenagers in New Zealand). English only, New Zealand spelling.`;

export const BLANK = '_____';

export const DISTRACTOR_COUNT = 4;
// Bump when the practice material changes shape; older saved meanings are regenerated once.
export const MATERIAL_VERSION = 2;

/** Generate 3 cloze sentences and 4 confusable distractors for one saved meaning. */
export async function aiReviewMaterial({ headword, pos, definition, example }) {
  const user = `Target: "${headword}"${pos ? ` (${pos})` : ''}
Meaning to practise: "${definition}"${example ? `\nDictionary example: "${example}"` : ''}

1. Write 3 different natural sentences (8–20 words) that use the target in THIS meaning only, with clear context clues.
   In each sentence replace the target, in whatever form fits the grammar (e.g. "took off", "runs"), with exactly ${BLANK} (five underscores).
   Keep all words of a phrase together so one blank covers the whole target. Put the exact replaced text in "answer".
2. Give 5 distractors: real English words or phrases with the same part of speech and a similar form or meaning,
   which a learner might confuse with the target but which do NOT fit any of the sentences. Use their base form.`;
  const data = await jsonCall('review', REVIEW_SCHEMA, REVIEW_SYSTEM, user);

  const variants = [];
  for (const v of data.variants || []) {
    let sentence = (v.sentence || '').trim();
    const answer = (v.answer || '').trim();
    if (!answer) continue;
    if (!sentence.includes(BLANK)) {
      // Whole-word match, so "run" does not match inside "brunch".
      const esc = answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\p{L}\\p{N}'])${esc}(?![\\p{L}\\p{N}])`, 'iu');
      if (!re.test(sentence)) continue;
      sentence = sentence.replace(re, BLANK);
    }
    sentence = sentence.replace(/_{3,}/g, BLANK);
    if (sentence.split(BLANK).length !== 2) continue;
    variants.push({ sentence, answer });
  }
  if (!variants.length) throw new Error('AI returned no usable practice sentences');

  const hw = headword.toLowerCase();
  const distractors = [...new Set((data.distractors || []).map((d) => d.trim()).filter(Boolean))]
    .filter((d) => d.toLowerCase() !== hw && !variants.some((v) => v.answer.toLowerCase() === d.toLowerCase()))
    .slice(0, DISTRACTOR_COUNT);
  return { variants: variants.slice(0, 3), distractors };
}

const IPA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['uk', 'us'],
  properties: { uk: { type: 'string' }, us: { type: 'string' } },
};

/**
 * Last-resort IPA for a single word that no dictionary covers. The page labels the result "AI".
 * Returns { uk, us } with empty strings where the model is not confident.
 */
export async function aiIpa(word) {
  const data = await jsonCall(
    'ipa',
    IPA_SCHEMA,
    `You give dictionary-style IPA transcriptions of English words, like a learner's dictionary
(UK: standard Southern British; US: General American). Use slashes and a primary stress mark, e.g. /ˈwɔːtə/ and /ˈwɑːtər/.
If the word is not a real English word, or you are not confident of its pronunciation, return an empty string for that accent.`,
    `Word: "${word}"`
  );
  const clean = (s) => {
    const t = String(s || '').trim();
    if (!t) return null;
    return t.startsWith('/') ? t : `/${t.replace(/^\[|\]$/g, '')}/`;
  };
  return { uk: clean(data.uk), us: clean(data.us) };
}
