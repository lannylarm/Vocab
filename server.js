import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, initDb, cached } from './db.js';
import { mwFetch, parseMw } from './sources/mw.js';
import { wiktFetch, parseWikt } from './sources/wiktionary.js';
import { mergePron } from './sources/pron.js';
import { aiMeanings, aiReviewMaterial, BLANK } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// Bump when parsers change so cached results are re-parsed.
const PARSER_VERSION = 3;
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

app.post('/api/login', (req, res) => {
  const given = String(req.body?.passcode || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSCODE).digest();
  if (!PASSCODE || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong passcode' });
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
    cached(`wiktionary@${PARSER_VERSION}`, q, async () => parseWikt(await wiktFetch(q))));

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

  // Nothing from any dictionary: ask the model.
  const total = sources.reduce((n, s) => n + s.senses.length, 0);
  if (!total && process.env.OPENAI_API_KEY) {
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
  res.json({ query: q, sources, suggestions, pronunciations });
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
  const items = (req.body?.items || []).slice(0, 30);
  const inserted = [];
  await Promise.all(
    items.map(async (it) => {
      const headword = cleanQuery(it.headword);
      const definition = String(it.definition || '').trim();
      if (!headword || !definition) return;
      // Save immediately; practice sentences are generated in the background.
      const r = await pool.query(
        `INSERT INTO vocab_senses
           (profile_id, headword, entry_type, pos, definition, example, labels, source,
            ipa_uk, ipa_us, audio_uk, audio_us)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          pid, headword, headword.includes(' ') ? 'phrase' : 'word', it.pos || '', definition,
          it.example || '', (it.labels || []).map(String), String(it.source || 'unknown'),
          headword.includes(' ') ? null : it.ipa_uk || null,
          headword.includes(' ') ? null : it.ipa_us || null,
          headword.includes(' ') ? null : safeAudio(it.audio_uk),
          headword.includes(' ') ? null : safeAudio(it.audio_us),
        ]
      );
      inserted.push(...r.rows);
    })
  );
  res.json({ saved: inserted.length });
  for (const row of inserted) {
    regenerate(row).catch((err) => console.error('background sentences failed', row.id, err.message));
  }
}));

app.get('/api/words', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query(
    `SELECT id, headword, entry_type, pos, definition, example, labels, source, level, due_at, ipa_uk, ipa_us, audio_uk, audio_us,
            correct_count, wrong_count, jsonb_array_length(variants) AS sentence_count, created_at
     FROM vocab_senses WHERE profile_id=$1 ORDER BY created_at DESC`,
    [pid]
  );
  res.json(r.rows);
}));

app.delete('/api/words/:id', wrap(async (req, res) => {
  const pid = profileId(req);
  await pool.query('DELETE FROM vocab_senses WHERE id=$1 AND profile_id=$2', [req.params.id, pid]);
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

/** After a restart, finish any saved meanings that still have no practice sentences. */
async function backfillSentences() {
  const r = await pool.query(
    "SELECT * FROM vocab_senses WHERE jsonb_array_length(variants) = 0 ORDER BY created_at LIMIT 100"
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
  await pool.query('UPDATE vocab_senses SET variants=$1, distractors=$2, next_variant=0 WHERE id=$3', [
    JSON.stringify(m.variants), JSON.stringify(m.distractors), row.id,
  ]);
  return { ...row, variants: m.variants, distractors: m.distractors, next_variant: 0 };
}

app.post('/api/words/:id/regenerate', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query('SELECT * FROM vocab_senses WHERE id=$1 AND profile_id=$2', [req.params.id, pid]);
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
      options: shuffle(row.distractors || []), // similar words only; the answer is never shown
      pos: row.pos,
      level: row.level,
    });
  }
  res.json({ items });
}));

app.post('/api/review/:id/answer', wrap(async (req, res) => {
  const pid = profileId(req);
  const r = await pool.query('SELECT * FROM vocab_senses WHERE id=$1 AND profile_id=$2', [req.params.id, pid]);
  const row = r.rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  const vi = Math.max(0, parseInt(req.body?.variant, 10) || 0) % Math.max(1, row.variants.length);
  const v = row.variants[vi] || { sentence: '', answer: row.headword };
  const input = normAnswer(req.body?.input);

  let result = 'wrong';
  if (input && input === normAnswer(v.answer)) result = 'correct';
  else if (input && input === normAnswer(row.headword)) result = 'form'; // right word, wrong form

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
    fullSentence: v.sentence.replace(BLANK, `[[${v.answer}]]`),
    definition: row.definition,
    example: row.example,
    pos: row.pos,
    ipa_uk: row.ipa_uk,
    ipa_us: row.ipa_us,
    audio_uk: row.audio_uk,
    audio_us: row.audio_us,
    entry_type: row.entry_type,
    nextInDays: correct ? INTERVALS[level] : 0,
  });
}));

// ---------- Static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error status passthrough for profileId() errors
app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Vocab Builder listening on ${PORT}`));
    if (process.env.OPENAI_API_KEY) backfillSentences().catch((err) => console.error('backfill', err.message));
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
