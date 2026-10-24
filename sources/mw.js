// Merriam-Webster Dictionary API (Learner's and Collegiate) — fetch + parse.
// Docs: https://dictionaryapi.com/products/json

const BASE = 'https://www.dictionaryapi.com/api/v3/references';

export async function mwFetch(ref, key, query) {
  const url = `${BASE}/${ref}/json/${encodeURIComponent(query)}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Merriam-Webster ${ref} HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // MW returns plain text for an invalid key, e.g. "Invalid API key. Not subscribed for this reference."
    throw new Error(`Merriam-Webster ${ref}: ${text.slice(0, 120)}`);
  }
}

/** Strip MW inline markup tokens to plain text. */
export function cleanMarkup(s) {
  if (!s) return '';
  return String(s)
    .replace(/\{bc\}/g, ' ')
    .replace(/\{ldquo\}/g, '“')
    .replace(/\{rdquo\}/g, '”')
    .replace(/\{dx\}.*?\{\/dx\}/g, '')
    .replace(/\{dx_def\}.*?\{\/dx_def\}/g, '')
    .replace(/\{dx_ety\}.*?\{\/dx_ety\}/g, '')
    .replace(/\{ma\}.*?\{\/ma\}/g, '')
    .replace(/\{(?:a_link|d_link|i_link|et_link|mat|sx|dxt|ds|sc_link)\|([^|}]*)[^}]*\}/g, '$1')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
    .replace(/^[:;,]\s*/, '');
}

export function norm(s) {
  return cleanMarkup(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a run-on phrase like "take (someone) off" -> "take off". */
function normPhrase(s) {
  return norm(s).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

function walkSseq(sseq, out) {
  for (const group of sseq || []) {
    for (const item of group || []) {
      if (!Array.isArray(item)) continue;
      const [type, data] = item;
      if (type === 'sense') out.push(data);
      else if (type === 'bs' && data?.sense) out.push(data.sense);
      else if (type === 'pseq' && Array.isArray(data)) walkSseq([data], out);
    }
  }
}

function dtToParts(dt) {
  const texts = [];
  const examples = [];
  const notes = [];
  for (const part of dt || []) {
    if (!Array.isArray(part)) continue;
    const [type, val] = part;
    if (type === 'text') texts.push(cleanMarkup(val));
    else if (type === 'vis' && Array.isArray(val)) examples.push(...val.map((v) => cleanMarkup(v.t)));
    else if (type === 'uns' && Array.isArray(val)) {
      for (const block of val) {
        for (const [t, v] of block || []) {
          if (t === 'text') notes.push(cleanMarkup(v));
          else if (t === 'vis' && Array.isArray(v)) examples.push(...v.map((x) => cleanMarkup(x.t)));
        }
      }
    }
  }
  return {
    text: texts.filter(Boolean).join(' '),
    examples: examples.filter(Boolean),
    notes: notes.filter(Boolean),
  };
}

function senseToItem(sense, { headword, pos, entryLabels, source }) {
  const { text, examples, notes } = dtToParts(sense.dt);
  let definition = text;
  if (!definition && notes.length) definition = notes.join('; ');
  else if (definition && notes.length) definition += ` (${notes.join('; ')})`;
  if (sense.sdsense?.dt) {
    const sd = dtToParts(sense.sdsense.dt);
    if (sd.text) definition += `; ${sense.sdsense.sd || 'also'}: ${sd.text}`;
    examples.push(...sd.examples);
  }
  definition = definition.replace(/\s+/g, ' ').trim();
  if (!definition) return null;
  const labels = [...(entryLabels || []), ...(sense.lbs || []), ...(sense.sls || [])]
    .map(cleanMarkup)
    .filter(Boolean);
  return {
    headword,
    pos: pos || '',
    definition,
    examples: examples.slice(0, 2),
    labels: [...new Set(labels)],
    source,
  };
}

function itemsFromDefs(defs, ctx) {
  const senses = [];
  for (const d of defs || []) walkSseq(d.sseq, senses);
  return senses.map((s) => senseToItem(s, ctx)).filter(Boolean);
}

function entryHeadword(e) {
  return cleanMarkup(e.hwi?.hw || String(e.meta?.id || '').split(':')[0]);
}

/**
 * Parse an MW API response for a query.
 * Returns { senses, phrases, suggestions }.
 *  - senses: meanings of the query itself (headword match, or matching run-on phrase)
 *  - phrases: idioms / phrasal verbs listed under the matching headword (single-word queries)
 */
export function parseMw(json, query, source) {
  const out = { senses: [], phrases: [], suggestions: [], pron: [] };
  if (!Array.isArray(json)) return out;
  if (json.length && typeof json[0] === 'string') {
    out.suggestions = json.slice(0, 8);
    return out;
  }
  const entries = json.filter((e) => e && typeof e === 'object' && e.meta);
  const qn = norm(query);
  const isPhrase = qn.includes(' ');

  const addEntry = (e) => {
    const headword = entryHeadword(e);
    const p = mwPron(e);
    if (p.uk || p.us || p.ukAudio || p.usAudio) out.pron.push({ pos: e.fl || '', ...p });
    const ctx = { headword, pos: e.fl || '', entryLabels: [...(e.lbs || []), ...(e.sls || [])], source };
    out.senses.push(...itemsFromDefs(e.def, ctx));
    if (!isPhrase) {
      for (const dro of e.dros || []) {
        const drp = cleanMarkup(dro.drp);
        out.phrases.push(
          ...itemsFromDefs(dro.def, { headword: drp, pos: dro.gram || 'phrase', entryLabels: dro.lbs || [], source })
        );
      }
    }
  };

  let matched = entries.filter((e) => norm(String(e.meta.id).split(':')[0]) === qn);
  matched.forEach(addEntry);

  // Run-on phrases (idioms, phrasal verbs) matching the query, e.g. "take off" under "take".
  for (const e of entries) {
    for (const dro of e.dros || []) {
      if (normPhrase(dro.drp) === normPhrase(qn) || norm(dro.drp) === qn) {
        const drp = cleanMarkup(dro.drp);
        out.senses.push(
          ...itemsFromDefs(dro.def, { headword: drp, pos: dro.gram || 'phrase', entryLabels: dro.lbs || [], source })
        );
      }
    }
  }

  // Inflected form, e.g. "ran" -> "run": use entries whose stems contain the query.
  if (!out.senses.length && !isPhrase) {
    matched = entries.filter((e) => (e.meta.stems || []).some((s) => norm(s) === qn));
    if (matched.length) {
      const base = [...new Set(matched.map(entryHeadword))];
      out.suggestions = base.filter((b) => norm(b) !== qn);
    }
  }

  out.senses = dedupe(out.senses);
  out.phrases = dedupe(out.phrases).slice(0, 60);
  return out;
}

/** Learner's gives IPA (US by default; British variants carry a label like "British"). Collegiate has no IPA. */
export function mwPron(e) {
  let uk = null;
  let us = null;
  let ukAudio = null;
  let usAudio = null;
  for (const p of e.hwi?.prs || []) {
    const label = `${p.l || ''} ${p.l2 || ''}`;
    const isUk = /brit/i.test(label);
    const isUs = !label.trim() || /us|american/i.test(label);
    const ipa = p.ipa ? `/${cleanMarkup(p.ipa)}/` : null;
    const audio = mwAudioUrl(p.sound?.audio);
    if (isUk) { uk ??= ipa; ukAudio ??= audio; }
    else if (isUs) { us ??= ipa; usAudio ??= audio; }
  }
  return { uk, us, ukAudio, usAudio };
}

/** MW audio file URL, per https://dictionaryapi.com/products/json (section "sound"). */
export function mwAudioUrl(name) {
  if (!name) return null;
  let dir;
  if (name.startsWith('bix')) dir = 'bix';
  else if (name.startsWith('gg')) dir = 'gg';
  else if (/^[^a-z]/i.test(name)) dir = 'number';
  else dir = name[0];
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${dir}/${encodeURIComponent(name)}.mp3`;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.headword.toLowerCase()}|${i.definition.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
