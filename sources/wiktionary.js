// Wiktionary data via kaikki.org (machine-readable extraction of English Wiktionary).
// Per-word JSONL: https://kaikki.org/dictionary/English/meaning/<c1>/<c1c2>/<word>.jsonl
// Licence: CC BY-SA 4.0 — attribute Wiktionary and kaikki.org.

const UA = 'FamilyVocabBuilder/1.0 (personal, non-commercial)';

const LABEL_TAGS = new Set([
  'slang', 'informal', 'colloquial', 'idiomatic', 'figuratively', 'humorous', 'formal', 'literary',
  'archaic', 'obsolete', 'dated', 'rare', 'vulgar', 'offensive', 'derogatory', 'euphemistic', 'Internet',
  'New-Zealand', 'Australia', 'UK', 'US', 'British', 'Ireland', 'Canada', 'South-Africa', 'Scotland',
  'Commonwealth', 'India',
]);
const PUSH_LAST = new Set(['archaic', 'obsolete', 'dated', 'rare']);

const POS_NAMES = {
  adj: 'adjective', adv: 'adverb', intj: 'interjection', prep: 'preposition', pron: 'pronoun',
  conj: 'conjunction', det: 'determiner', name: 'proper noun', prep_phrase: 'prepositional phrase',
  num: 'numeral', particle: 'particle',
};

function urlFor(word) {
  const chars = [...word];
  const c1 = chars[0];
  const c2 = chars.slice(0, 2).join('');
  return `https://kaikki.org/dictionary/English/meaning/${encodeURIComponent(c1)}/${encodeURIComponent(c2)}/${encodeURIComponent(word)}.jsonl`;
}

export async function wiktFetch(query) {
  const w = query.trim();
  const tries = [...new Set([w, w.toLowerCase()])];
  for (const t of tries) {
    try {
      const res = await fetch(urlFor(t), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const text = await res.text();
      const entries = text
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter((e) => e && (e.lang_code === 'en' || e.lang === 'English'));
      if (entries.length) return entries;
    } catch {
      /* try next form */
    }
  }
  return [];
}

const UK_TAGS = new Set(['Received-Pronunciation', 'UK', 'British', 'Standard-Southern-British']);
const US_TAGS = new Set(['General-American', 'US']);

/** Pick UK and US IPA from kaikki "sounds"; prefer phonemic /.../ over phonetic [...]. */
export function wiktPron(sounds) {
  let uk = null;
  let us = null;
  let generic = null;
  let ukAudio = null;
  let usAudio = null;
  for (const s of sounds || []) {
    // mp3 only: Safari/iOS cannot play Ogg.
    const url = s.mp3_url;
    if (!url) continue;
    const tags = s.tags || [];
    const file = String(s.audio || url);
    const isUk = tags.some((t) => UK_TAGS.has(t)) || /en-(uk|gb)-/i.test(file);
    const isUs = tags.some((t) => US_TAGS.has(t)) || /en-us-/i.test(file);
    if (isUk && !isUs) ukAudio ??= url;
    if (isUs && !isUk) usAudio ??= url;
  }
  const better = (cur, ipa) => !cur || (!cur.startsWith('/') && ipa.startsWith('/'));
  for (const s of sounds || []) {
    if (!s.ipa) continue;
    const ipa = s.ipa.trim();
    const tags = s.tags || [];
    if (tags.some((t) => UK_TAGS.has(t)) && better(uk, ipa)) uk = ipa;
    if (tags.some((t) => US_TAGS.has(t)) && better(us, ipa)) us = ipa;
    if (!tags.length && ipa.startsWith('/') && !generic) generic = ipa;
  }
  // An untagged pronunciation applies to both accents.
  if (generic) { uk ??= generic; us ??= generic; }
  return { uk, us, ukAudio, usAudio };
}

export function parseWikt(entries, source = 'wiktionary') {
  const out = { senses: [], phrases: [], suggestions: [], pron: [] };
  const formOf = new Set();
  for (const e of entries || []) {
    const pos = POS_NAMES[e.pos] || e.pos || '';
    const p = wiktPron(e.sounds);
    if (p.uk || p.us || p.ukAudio || p.usAudio) out.pron.push({ pos, ...p });
    for (const s of e.senses || []) {
      const targets = [...(s.form_of || []), ...(s.alt_of || [])].map((f) => f.word).filter(Boolean);
      if (targets.length) {
        targets.forEach((t) => formOf.add(t));
        continue;
      }
      const glosses = s.glosses || [];
      if (!glosses.length) continue;
      const tags = s.tags || [];
      if (tags.includes('form-of') || tags.includes('alt-of')) continue;
      let examples = (s.examples || []).filter((x) => x.type !== 'quotation').map((x) => x.text);
      if (!examples.length) {
        examples = (s.examples || []).map((x) => x.text).filter((t) => t && t.length < 160);
      }
      out.senses.push({
        headword: e.word,
        pos,
        definition: glosses[glosses.length - 1],
        examples: examples.filter(Boolean).slice(0, 2),
        labels: tags.filter((t) => LABEL_TAGS.has(t)).map((t) => t.replace(/-/g, ' ')),
        source,
      });
    }
  }
  out.senses.sort((a, b) => {
    const la = a.labels.some((l) => PUSH_LAST.has(l)) ? 1 : 0;
    const lb = b.labels.some((l) => PUSH_LAST.has(l)) ? 1 : 0;
    return la - lb;
  });
  out.senses = out.senses.slice(0, 40);
  if (!out.senses.length) out.suggestions = [...formOf].slice(0, 5);
  return out;
}
