import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initDb, cached } from './db.js';
import { mwFetch, parseMw } from './sources/mw.js';
import { wiktFetch, parseWikt } from './sources/wiktionary.js';
import { mergePron } from './sources/pron.js';
import { aiMeanings, aiReviewMaterial, aiIpa, aiSpeech, aiSyllables, TTS_ID, BLANK, MATERIAL_VERSION } from './ai.js';
import { cmuIpa, preloadCmu } from './sources/cmu.js';
import { irregularForms } from './sources/forms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// Bump when parsers change so cached results are re-parsed.
const PARSER_VERSION = 5;
const MW_LEARNERS_KEY = process.env.MW_LEARNERS_KEY;
const MW_COLLEGIATE_KEY = process.env.MW_COLLEGIATE_KEY;

// ---------- Auth (single shared passcode) ----------
const PASSCODE = process.env.APP_PASSCODE || '';
const SECRET = process.env.SESSION_SECRET || PASSCODE || 'dev';
const TOKEN = crypto.createHmac('sha256', SECRET).update(`ok:${PASSCODE}`).digest('hex');

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAuthed(req) {
  if (!PASSCODE) return true;
  const c = getCookie(req, 'vocab_auth');
  return !!c && c.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(TOKEN));
}

app.get('/api/auth-status', (req, res) => res.json({ required: !!PASSCODE, ok: isAuthed(req) }));

// Slow down passcode guessing: at most 10 wrong attempts per IP per 15 minutes.
const loginFails = new Map();
const FAIL_WINDOW_MS = 15 * 60 * 1000;
function tooManyFails(ip) {
  const now = Date.now();
  const list = (loginFails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  loginFails.set(ip, list);
  return list.length >= 10;
}

app.post('/api/login', (req, res) => {
  if (tooManyFails(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const given = String(req.body?.passcode || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSCODE).digest();
  if (!PASSCODE || !crypto.timingSafeEqual(a, b)) {
    loginFails.get(req.ip).push(Date.now());
    return res.status(401).json({ error: 'Wrong passcode' });
  }
  loginFails.delete(req.ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `vocab_auth=${TOKEN}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Login required' })));

// ---------- Helpers ----------
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

function profileId(req) {
  const id = parseInt(req.get('X-Profile-Id'), 10);
  if (!Number.isInteger(id) || id <= 0) {
    const e = new Error('Choose a profile first');
    e.status = 400;
    throw e;
  }
  return id;
}

function rowId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    const e = new Error('Not found');
    e.status = 404;
    throw e;
  }
  return id;
}

function cleanQuery(q) {
  return String(q || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80);
}

const normAnswer = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:"]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Replace whole-word occurrences of any of `words` (case-insensitive) with "___". */
function hideWord(text, words) {
  let out = String(text || '');
  const list = [...new Set(words.filter(Boolean).map((w) => w.trim()))].sort((a, b) => b.length - a.length);
  for (const w of list) {
    const e = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Also hide simple inflections of single words (swap -> swapping, swaps).
    const tail = !/\s/.test(w) && w.length >= 4 ? '\\p{L}{0,4}' : '';
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${e}${tail}(?![\\p{L}\\p{N}])`, 'giu'), '___');
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Review intervals in days by level (level 0 = new / just failed).
const INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60, 120];

// ---------- Profiles ----------
app.get('/api/profiles', wrap(async (req, res) => {
  const r = await pool.query('SELECT id, name FROM vocab_profiles ORDER BY id');
  res.json(r.rows);
}));

app.post('/api/profiles', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = await pool.query(
    `INSERT INTO vocab_profiles (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id, name`,
    [name]
  );
  res.json(r.rows[0]);
}));

// ---------- Lookup ----------

async function sourceResult(id, label, fn) {
  try {
    return { id, label, ...(await fn()) };
  } catch (err) {
    console.error(`[${id}]`, err.message);
    return { id, label, senses: [], phrases: [], suggestions: [], error: err.message };
  }
}

app.get('/api/lookup', wrap(async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q) return res.status(400).json({ error: 'Enter a word or phrase' });
  const pid = profileId(req);

  const learnersP = MW_LEARNERS_KEY
    ? sourceResult('mw-learners', "Merriam-Webster Learner's", () =>
        cached(`mw-learners@${PARSER_VERSION}`, q, async () =>
          parseMw(await mwFetch('learners', MW_LEARNERS_KEY, q), q, 'mw-learners')))
    : null;
  const wiktP = sourceResult('wiktionary', 'Wiktionary', () =>
    cached(`wiktionary@${PARSER_VERSION}`, q, async () => parseWikt(await wiktFetch(q), 'wiktionary', q)));

  const sources = [];
  const learners = learnersP ? await learnersP : null;
  if (learners) sources.push(learners);

  // Collegiate only when Learner's has nothing for this query.
  if (MW_COLLEGIATE_KEY && !(learners?.senses.length)) {
    sources.push(
      await sourceResult('mw-collegiate', 'Merriam-Webster Collegiate', () =>
        cached(`mw-collegiate@${PARSER_VERSION}`, q, async () =>
          parseMw(await mwFetch('collegiate', MW_COLLEGIATE_KEY, q), q, 'mw-collegiate')))
    );
  }
  sources.push(await wiktP);

  // Nothing from any dictionary: ask the model — unless the dictionaries point to a base form
  // (e.g. "swapped" -> "swap"), in which case the page offers that word instead.
  const total = sources.reduce((n, s) => n + s.senses.length, 0);
  const hasSuggestions = sources.some((s) => (s.suggestions || []).length);
  if (!total && !hasSuggestions && process.env.OPENAI_API_KEY) {
    sources.push(
      await sourceResult('ai', 'AI (not from a dictionary)', async () => ({
        senses: await cached(`ai@${PARSER_VERSION}`, q, () => aiMeanings(q)),
        phrases: [],
        suggestions: [],
      }))
    );
  }

  // UK/US IPA for single words only (not phrases).
  const pronunciations = q.includes(' ') ? [] : mergePron(sources);
  // Missing US IPA: fill from the CMU Pronouncing Dictionary (General American).
  const hasSenses = sources.some((s) => s.senses.length);
  if (!q.includes(' ') && hasSenses && (!pronunciations.length || pronunciations.some((p) => !p.us))) {
    const us = await cmuIpa(q);
    if (us) {
      if (!pronunciations.length) pronunciations.push({ pos: '', uk: null, us, ukAudio: null, usAudio: null });
      for (const p of pronunciations) p.us ??= us;
    }
  }
  if (pronunciations.length) {
    for (const s of sources) {
      for (const it of s.senses) {
        if (it.headword.toLowerCase() !== q.toLowerCase()) continue;
        const p = pronunciations.find((x) => x.pos === (it.pos || '').toLowerCase()) || pronunciations[0];
        it.ipa_uk = p.uk;
        it.ipa_us = p.us;
        it.audio_uk = p.ukAudio;
        it.audio_us = p.usAudio;
      }
    }
  }

  // Mark meanings this profile has already saved.
  const headwords = new Set([q.toLowerCase()]);
  for (const s of sources) for (const it of [...s.senses, ...s.phrases]) headwords.add(it.headword.toLowerCase());
  const saved = await pool.query(
    'SELECT lower(headword) AS h, lower(definition) AS d FROM vocab_senses WHERE profile_id=$1 AND lower(headword) = ANY($2)',
    [pid, [...headwords]]
  );
  const savedSet = new Set(saved.rows.map((r) => `${r.h}|${r.d}`));
  for (const s of sources) {
    for (const it of [...s.senses, ...s.phrases]) {
      it.saved = savedSet.has(`${it.headword.toLowerCase()}|${it.definition.toLowerCase()}`);
    }
  }

  const suggestions = [...new Set(sources.flatMap((s) => s.suggestions || []))]
    .filter((s) => s.toLowerCase() !== q.toLowerCase())
    .slice(0, 8);
  // Is this word (or the base form it points to, e.g. "swapped" -> "swap") already in the word list?
  const lib = await pool.query(
    `SELECT min(headword) AS headword, count(*)::int AS count FROM vocab_senses
     WHERE profile_id=$1 AND lower(headword) = ANY($2) GROUP BY lower(headword)`,
    [pid, [q.toLowerCase(), ...suggestions.map((s) => s.toLowerCase())]]
  );
  const inLibrary = lib.rows.sort((a, b) =>
    (b.headword.toLowerCase() === q.toLowerCase()) - (a.headword.toLowerCase() === q.toLowerCase()));
  // Irregular past / past participle and irregular plurals (single words only).
  const irregular = q.includes(' ') ? [] : formsFromSources(q, sources);
  for (const s of sources) {
    for (const it of s.senses) {
      if (it.headword.toLowerCase() !== q.toLowerCase()) continue;
      const f = matchForms(irregular, it.pos);
      if (f) it.forms = f;
    }
  }
  res.json({ query: q, sources, suggestions, pronunciations, inLibrary, irregular });
}));

const AI_IPA_CACHE = 'ai-ipa@2';

function formsFromSources(word, sources) {
  const wk = sources.find((s) => s.id === 'wiktionary')?.forms || [];
  const mw = sources.find((s) => s.id === 'mw-learners')?.forms?.length
    ? sources.find((s) => s.id === 'mw-learners').forms
    : sources.find((s) => s.id === 'mw-collegiate')?.forms || [];
  return irregularForms(word, wk, mw);
}

/** The irregular forms that belong to a meaning's part of speech (verb or noun), without the pos field. */
function matchForms(irregular, pos) {
  const p = String(pos || '').toLowerCase();
  const kind = /\bverb\b/.test(p) && !/phrasal/.test(p) ? 'verb' : /\bnoun\b/.test(p) ? 'noun' : null;
  const f = kind && irregular.find((x) => x.pos === kind);
  if (!f) return null;
  return kind === 'verb' ? { past: f.past, pp: f.pp } : { plural: f.plural };
}

/** Validate forms sent by the page: { past, pp } or { plural }, short word lists only. */
function cleanForms(f) {
  if (!f || typeof f !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 40)).filter((x) => /^[\p{L}' -]+$/u.test(x)).slice(0, 4) : []);
  const out = {};
  for (const k of ['past', 'pp', 'plural']) { const l = list(f[k]); if (l.length) out[k] = l; }
  return Object.keys(out).length ? out : null;
}

// Last-resort IPA from AI for single words no dictionary covers (shown with an "AI" label).
app.get('/api/ai-ipa', wrap(async (req, res) => {
  const q = cleanQuery(req.query.q);
  if (!q || q.includes(' ')) return res.json({ uk: null, us: null });
  if (!process.env.OPENAI_API_KEY) return res.json({ uk: null, us: null });
  res.json(await cached(AI_IPA_CACHE, q, () => aiIpa(q)));
}));

// Pronunciation audio for words/phrases without a dictionary recording; generated once, then cached.
const ttsJobs = new Map();
app.get('/api/tts', wrap(async (req, res) => {
  const text = cleanQuery(req.query.text);
  const accent = req.query.accent === 'uk' ? 'uk' : 'us';
  if (!text || !/^[\p{L}\p{N}' .,\-]+$/u.test(text)) return res.status(400).json({ error: 'Bad text' });
  if (!process.env.OPENAI_API_KEY) return res.status(404).json({ error: 'Speech not available' });
  const key = `${TTS_ID}|${accent}|${text.toLowerCase()}`;
  let row = (await pool.query('SELECT mime, data FROM vocab_tts WHERE key=$1', [key])).rows[0];
  if (!row) {
    if (!ttsJobs.has(key)) {
      ttsJobs.set(key, (async () => {
        const buf = await aiSpeech(text, accent);
        const data = buf.toString('base64');
        await pool.query(
          'INSERT INTO vocab_tts (key, mime, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING',
          [key, 'audio/mpeg', data]
        );
        return { mime: 'audio/mpeg', data };
      })().finally(() => ttsJobs.delete(key)));
    }
    row = await ttsJobs.get(key);
  }
  const buf = Buffer.from(row.data, 'base64');
  res.statusCode = 200;
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'private, max-age=2592000');
  res.end(buf);
}));

// Syllable split for spelling practice (cached; falls back to the plain word).
app.get('/api/syllables', wrap(async (req, res) => {
  const text = cleanQuery(req.query.text);
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (!process.env.OPENAI_API_KEY || !/^[\p{L}' -]+$/u.test(text)) return res.json({ syllables: text });
  try {
    const r = await cached('syllables@1', text, async () => ({ syllables: (await aiSyllables(text)) || text }));
    res.json({ syllables: r.syllables.replace(/·/g, '') === text ? r.syllables : text });
  } catch {
    res.json({ syllables: text });
  }
}));

app.post('/api/ai-more', wrap(async (req, res) => {
  const q = cleanQuery(req.body?.q);
  if (!q) return res.status(400).json({ error: 'Missing term' });
  const known = (req.body?.known || []).map(String).slice(0, 40);
  res.json({ senses: await aiMeanings(q, known) });
}));

// ---------- Saved meanings ----------
const AUDIO_HOSTS = ['media.merriam-webster.com', 'upload.wikimedia.org'];
function safeAudio(u) {
  try {
    const url = new URL(String(u || ''));
    return url.protocol === 'https:' && AUDIO_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

app.post('/api/save', wrap(async (req, res) => {
  const pid = profileId(req);
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 30) : [];
  const inserted = [];
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  await Promise.all(
    items.map(async (it) => {
      if (!it || typeof it !== 'object') return;
      const headword = cleanQuery(it.headword);
      const definition = str(it.definition, 1000);
      if (!headword || !definition) return;
      const labels = Array.isArray(it.labels) ? it.labels.map((l) => str(l, 40)).filter(Boolean).slice(0, 10) : [];
      const ipa = (v) => (headword.includes(' ') ? null : str(v, 80) || null);
      // Save immediately; practice sentences are generated in the background.
      const r = await pool.query(
        `INSERT INTO vocab_senses
           (profile_id, headword, entry_type, pos, definition, example, labels, source,
            ipa_uk, ipa_us, audio_uk, audio_us, ipa_uk_ai, ipa_us_ai, forms, forms_checked)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          pid, headword, headword.includes(' ') ? 'phrase' : 'word', str(it.pos, 40), definition,
          str(it.example, 500), labels, str(it.source, 30) || 'unknown',
          ipa(it.ipa_uk),
          ipa(it.ipa_us),
          headword.includes(' ') ? null : safeAudio(it.audio_uk),
          headword.includes(' ') ? null : safeAudio(it.audio_us),
          !!it.ipa_uk_ai && !headword.includes(' '),
          !!it.ipa_us_ai && !headword.includes(' '),
          headword.includes(' ') ? null : JSON.stringify(cleanForms(it.forms)),
          headword.includes(' ') || !!it.forms_checked,
        ]
      );
      inserted.push(...r.rows);
    })
  ).catch((err) => {
    if (err.code === '23503') { // foreign key: the learner no longer exists
      const e = new Error('This learner no longer exists. Reload the page.');
      e.status = 400;
      throw e;
    }
    throw err;
  });
  res.json({ saved: inserted.length });
  for (const row of inserted) {
    regenerate(row).catch((err) => console.error('background sentences failed', row.id, err.message));
    fillIpa(row).catch((err) => console.error('background IPA failed', row.id, err.message));
    fillForms(row).catch((err) => console.error('background forms failed', row.id, err.message));
  }
}));

app.get('/api/words', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query(
    `SELECT id, headword, entry_type, pos, definition, example, labels, source, level, due_at, ipa_uk, ipa_us, audio_uk, audio_us, ipa_uk_ai, ipa_us_ai, forms,
            correct_count, wrong_count, jsonb_array_length(variants) AS sentence_count, created_at
     FROM vocab_senses WHERE profile_id=$1 ORDER BY created_at DESC`,
    [pid]
  );
  res.json(r.rows);
}));

app.delete('/api/words/:id', wrap(async (req, res) => {
  const pid = profileId(req);
  await pool.query('DELETE FROM vocab_senses WHERE id=$1 AND profile_id=$2', [rowId(req), pid]);
  res.json({ ok: true });
}));

// One generation per row at a time, shared by background saves, review and the "New sentences" button.
const generating = new Map();
function regenerate(row) {
  if (!generating.has(row.id)) {
    const job = doRegenerate(row).finally(() => generating.delete(row.id));
    generating.set(row.id, job);
  }
  return generating.get(row.id);
}

/**
 * After a restart, finish saved meanings that have no practice sentences, or whose sentences were made
 * by an older version of the generator (e.g. 3 instead of 4 similar words). Each row is redone only once.
 */
/**
 * Single words saved without UK/US IPA (brand names, rare words, or saved before the AI step finished):
 * US from the CMU dictionary, anything still missing from AI (flagged "AI"). Each row is tried once.
 */
async function fillIpa(row) {
  if (row.entry_type !== 'word' || row.ipa_checked || (row.ipa_uk && row.ipa_us)) return;
  let uk = row.ipa_uk;
  let us = row.ipa_us;
  let ukAi = row.ipa_uk_ai;
  let usAi = row.ipa_us_ai;
  if (!us) us = await cmuIpa(row.headword, 20000);
  if ((!uk || !us) && process.env.OPENAI_API_KEY) {
    const ai = await cached(AI_IPA_CACHE, row.headword, () => aiIpa(row.headword));
    if (!uk && ai.uk) { uk = ai.uk; ukAi = true; }
    if (!us && ai.us) { us = ai.us; usAi = true; }
  }
  await pool.query(
    `UPDATE vocab_senses SET ipa_uk=$1, ipa_us=$2, ipa_uk_ai=$3, ipa_us_ai=$4, ipa_checked=true WHERE id=$5`,
    [uk || null, us || null, !!ukAi, !!usAi, row.id]
  );
}

/** Saved single-word verbs/nouns whose irregular forms were not stored yet (e.g. saved before this feature). */
async function fillForms(row) {
  if (row.entry_type !== 'word' || row.forms_checked) return;
  if (!/\b(verb|noun)\b/i.test(row.pos || '') || /phrasal/i.test(row.pos || '')) {
    await pool.query('UPDATE vocab_senses SET forms_checked=true WHERE id=$1', [row.id]);
    return;
  }
  const q = cleanQuery(row.headword);
  const sources = [];
  sources.push({ id: 'wiktionary', forms: (await cached(`wiktionary@${PARSER_VERSION}`, q, async () => parseWikt(await wiktFetch(q), 'wiktionary', q))).forms });
  if (MW_LEARNERS_KEY) {
    try {
      sources.push({ id: 'mw-learners', forms: (await cached(`mw-learners@${PARSER_VERSION}`, q, async () =>
        parseMw(await mwFetch('learners', MW_LEARNERS_KEY, q), q, 'mw-learners'))).forms });
    } catch { /* Wiktionary alone is fine */ }
  }
  const f = matchForms(formsFromSources(q, sources), row.pos);
  await pool.query('UPDATE vocab_senses SET forms=$1, forms_checked=true WHERE id=$2', [JSON.stringify(f), row.id]);
}

async function backfillForms() {
  const r = await pool.query(
    `SELECT * FROM vocab_senses WHERE entry_type='word' AND NOT forms_checked ORDER BY created_at LIMIT 300`
  );
  for (const row of r.rows) {
    try {
      await fillForms(row);
    } catch (err) {
      console.error('forms backfill failed', row.id, err.message);
    }
  }
}

async function backfillIpa() {
  const r = await pool.query(
    `SELECT * FROM vocab_senses
     WHERE entry_type='word' AND NOT ipa_checked AND (ipa_uk IS NULL OR ipa_us IS NULL)
     ORDER BY created_at LIMIT 300`
  );
  for (const row of r.rows) {
    try {
      await fillIpa(row);
    } catch (err) {
      console.error('IPA backfill failed', row.id, err.message);
    }
  }
}

async function backfillSentences() {
  const r = await pool.query(
    `SELECT * FROM vocab_senses
     WHERE jsonb_array_length(variants) = 0 OR material_version < $1
     ORDER BY created_at LIMIT 200`,
    [MATERIAL_VERSION]
  );
  for (const row of r.rows) {
    try {
      await regenerate(row);
    } catch (err) {
      console.error('backfill failed', row.id, err.message);
    }
  }
}

async function doRegenerate(row) {
  const m = await aiReviewMaterial({
    headword: row.headword, pos: row.pos, definition: row.definition, example: row.example,
  });
  await pool.query(
    'UPDATE vocab_senses SET variants=$1, next_variant=0, material_version=$2 WHERE id=$3',
    [JSON.stringify(m.variants), MATERIAL_VERSION, row.id]
  );
  return { ...row, variants: m.variants, next_variant: 0, material_version: MATERIAL_VERSION };
}

app.post('/api/words/:id/regenerate', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query('SELECT * FROM vocab_senses WHERE id=$1 AND profile_id=$2', [rowId(req), pid]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
  await regenerate(r.rows[0]);
  res.json({ ok: true });
}));

app.get('/api/stats', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at <= now())::int AS due
     FROM vocab_senses WHERE profile_id=$1`,
    [pid]
  );
  res.json(r.rows[0]);
}));

// ---------- Review ----------
app.get('/api/review', wrap(async (req, res) => {
  const pid = profileId(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const all = req.query.mode === 'all';
  const r = await pool.query(
    all
      ? 'SELECT * FROM vocab_senses WHERE profile_id=$1 ORDER BY random() LIMIT $2'
      : 'SELECT * FROM vocab_senses WHERE profile_id=$1 AND due_at <= now() ORDER BY due_at LIMIT $2',
    [pid, limit]
  );
  const items = [];
  for (let row of r.rows) {
    if (!Array.isArray(row.variants) || !row.variants.length) {
      try {
        row = await regenerate(row);
      } catch (err) {
        console.error('regenerate failed', row.id, err.message);
        continue;
      }
    }
    const vi = row.next_variant % row.variants.length;
    const v = row.variants[vi];
    items.push({
      id: row.id,
      variant: vi,
      sentence: v.sentence,
      // The saved English meaning, with the word itself hidden so it does not give the answer away.
      definition: hideWord(row.definition, [row.headword, ...row.variants.map((x) => x.answer)]),
      pos: row.pos,
      level: row.level,
    });
  }
  res.json({ items });
}));

app.post('/api/review/:id/answer', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query('SELECT * FROM vocab_senses WHERE id=$1 AND profile_id=$2', [rowId(req), pid]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  const variants = Array.isArray(row.variants) ? row.variants : [];
  const shown = String(req.body?.sentence || '');
  // Find the sentence the learner saw. If the sentences were regenerated meanwhile, it may be gone:
  // then accept the headword or any known form of it.
  let v = variants.find((x) => x.sentence === shown);
  if (!v && !shown) v = variants[Math.max(0, parseInt(req.body?.variant, 10) || 0) % Math.max(1, variants.length)];
  const input = normAnswer(req.body?.input);
  const forms = new Set([normAnswer(row.headword), ...variants.map((x) => normAnswer(x.answer))]);

  let result = 'wrong';
  if (v) {
    if (input && input === normAnswer(v.answer)) result = 'correct';
    else if (input && input === normAnswer(row.headword)) result = 'form'; // right word, wrong form
  } else {
    v = { sentence: shown, answer: row.headword };
    if (input && forms.has(input)) result = 'correct';
  }

  const correct = result !== 'wrong';
  const level = correct ? Math.min(row.level + 1, INTERVALS.length - 1) : 0;
  const dueSql = correct ? `now() + interval '${INTERVALS[level]} days'` : `now() + interval '10 minutes'`;
  await pool.query(
    `UPDATE vocab_senses SET level=$1, due_at=${dueSql}, next_variant=next_variant+1,
       correct_count=correct_count+$2, wrong_count=wrong_count+$3, last_reviewed_at=now()
     WHERE id=$4`,
    [level, correct ? 1 : 0, correct ? 0 : 1, row.id]
  );

  res.json({
    result,
    answer: v.answer,
    headword: row.headword,
    definition: row.definition,
    example: row.example,
    pos: row.pos,
    ipa_uk: row.ipa_uk,
    ipa_us: row.ipa_us,
    audio_uk: row.audio_uk,
    audio_us: row.audio_us,
    ipa_uk_ai: row.ipa_uk_ai,
    ipa_us_ai: row.ipa_us_ai,
    forms: row.forms,
    entry_type: row.entry_type,
    nextInDays: correct ? INTERVALS[level] : 0,
  });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error status passthrough for profileId() errors
app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Vocab Builder listening on ${PORT}`));
    preloadCmu();
    if (process.env.OPENAI_API_KEY) backfillSentences().catch((err) => console.error('backfill', err.message));
    backfillIpa().catch((err) => console.error('IPA backfill', err.message));
    backfillForms().catch((err) => console.error('forms backfill', err.message));
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
