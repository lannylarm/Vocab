// Irregular verb forms (past, past participle) and irregular noun plurals.
// Forms come from Wiktionary (kaikki "forms", tagged) or Merriam-Webster ("ins" inflections);
// they are only shown when at least one of them cannot be made by the regular spelling rules.

const SKIP_TAGS = new Set([
  'archaic', 'obsolete', 'dialectal', 'nonstandard', 'rare', 'proscribed', 'nonce-word',
  'table-tags', 'inflection-template', 'class', 'error-unknown-tag', 'uncountable',
]);

const lower = (s) => String(s || '').trim().toLowerCase();
const isVowel = (c) => 'aeiou'.includes(c);

/** Spellings regular rules can produce for the past / past participle of `base`. */
export function regularPast(base) {
  const b = lower(base);
  const out = new Set([`${b}ed`]);
  const last = b.slice(-1);
  if (last === 'e') out.add(`${b}d`);
  if (last === 'y' && b.length > 1 && !isVowel(b.at(-2))) out.add(`${b.slice(0, -1)}ied`);
  if (/[bcdfghjklmnpqrstvz]$/.test(b)) out.add(`${b}${last}ed`); // stop -> stopped, travel -> travelled
  if (last === 'c') out.add(`${b}ked`); // picnic -> picnicked
  return out;
}

/** Spellings regular rules can produce for the plural of `base`. */
export function regularPlural(base) {
  const b = lower(base);
  const out = new Set([`${b}s`, `${b}es`]);
  if (b.endsWith('y') && b.length > 1 && !isVowel(b.at(-2))) out.add(`${b.slice(0, -1)}ies`);
  if (/(s|z)$/.test(b)) out.add(`${b}${b.slice(-1)}es`); // quiz -> quizzes, bus -> busses
  return out;
}

const uniq = (arr) => [...new Set(arr.map((x) => x.trim()).filter(Boolean))];

/**
 * Keep forms only when irregular. Returns e.g.
 *  { pos: 'verb', past: ['went'], pp: ['gone'] }  or  { pos: 'noun', plural: ['children'] }  or null.
 * All forms are listed (e.g. "dreamt, dreamed") as long as at least one is irregular.
 */
export function irregularOnly(base, f) {
  if (!base || /\s/.test(base)) return null;
  if (f.pos === 'verb') {
    const reg = regularPast(base);
    const past = uniq(f.past || []);
    const pp = uniq(f.pp || []);
    if (!past.length && !pp.length) return null;
    const irregular = [...past, ...pp].some((x) => !reg.has(lower(x)));
    return irregular ? { pos: 'verb', past, pp: pp.length ? pp : past } : null;
  }
  if (f.pos === 'noun') {
    const plural = uniq(f.plural || []);
    if (!plural.length) return null;
    const reg = regularPlural(base);
    return plural.some((x) => !reg.has(lower(x))) ? { pos: 'noun', plural } : null;
  }
  return null;
}

/** Forms from kaikki/Wiktionary entries of `word`: [{ pos, past, pp, plural }]. */
export function wiktForms(entries, word) {
  const byPos = new Map();
  for (const e of entries || []) {
    if (lower(e.word) !== lower(word) || (e.pos !== 'verb' && e.pos !== 'noun')) continue;
    const cur = byPos.get(e.pos) || { pos: e.pos, past: [], pp: [], plural: [] };
    for (const f of e.forms || []) {
      const tags = f.tags || [];
      const form = String(f.form || '').trim();
      if (!form || form === '-' || lower(form) === 'en' || tags.some((t) => SKIP_TAGS.has(t))) continue;
      if (e.pos === 'verb') {
        if (tags.includes('past') && tags.includes('participle')) cur.pp.push(form);
        else if (tags.includes('past') && !tags.includes('participle')) cur.past.push(form);
      } else if (tags.includes('plural') && !tags.includes('possessive')) {
        cur.plural.push(form);
      }
    }
    byPos.set(e.pos, cur);
  }
  return [...byPos.values()];
}

/**
 * Forms from Merriam-Webster entries ("ins"). For verbs MW lists, in order,
 * past; past participle; present participle; 3rd person — or 3 items when past = past participle.
 */
export function mwForms(entries, word, cleanMarkup) {
  const out = [];
  for (const e of entries || []) {
    if (!e?.meta || lower(String(e.meta.id).split(':')[0]) !== lower(word)) continue;
    const ins = (e.ins || []).filter((i) => i.if && (!i.il || /plural/i.test(i.il)));
    const forms = ins.map((i) => cleanMarkup(i.if).replace(/\s+/g, ''));
    if (e.fl === 'verb' && ins.every((i) => !i.il)) {
      if (forms.length >= 4) out.push({ pos: 'verb', past: [forms[0]], pp: [forms[1]], plural: [] });
      else if (forms.length === 3) out.push({ pos: 'verb', past: [forms[0]], pp: [forms[0]], plural: [] });
    } else if (e.fl === 'noun' && ins.length) {
      out.push({ pos: 'noun', past: [], pp: [], plural: forms });
    }
  }
  return out;
}

/** Wiktionary first (tagged, more complete); MW only for a part of speech Wiktionary lacks. */
export function irregularForms(word, wiktList, mwList) {
  const result = [];
  for (const pos of ['verb', 'noun']) {
    const f = wiktList.find((x) => x.pos === pos && (x.past.length || x.pp.length || x.plural.length))
      || mwList.find((x) => x.pos === pos);
    const irr = f && irregularOnly(word, f);
    if (irr) result.push(irr);
  }
  return result;
}
