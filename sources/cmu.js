// CMU Pronouncing Dictionary (General American, ~135k words incl. inflections and many rare words).
// Source: https://github.com/cmusphinx/cmudict  (BSD-style licence, see that repository).
// Downloaded once by the server on first use and kept in memory (~3.5 MB text).

const CMU_URL = process.env.CMUDICT_URL || 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict';
const RETRY_MS = 10 * 60 * 1000;

let dict = null;      // Map word -> [arpabet, ...]
let loading = null;   // in-flight promise
let failedAt = 0;

export function parseCmu(text) {
  const map = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith(';;;')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const word = line.slice(0, sp).replace(/\(\d+\)$/, '').toLowerCase();
    const phones = line.slice(sp + 1).trim();
    if (!map.has(word)) map.set(word, []);
    map.get(word).push(phones);
  }
  return map;
}

function load() {
  if (dict) return Promise.resolve(dict);
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  loading = fetch(CMU_URL, { signal: AbortSignal.timeout(20000) })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((t) => {
      dict = parseCmu(t);
      console.log(`CMU dictionary loaded: ${dict.size} words`);
      return dict;
    })
    .catch((err) => {
      failedAt = Date.now();
      console.error('CMU dictionary download failed:', err.message);
      return null;
    })
    .finally(() => { loading = null; });
  return loading;
}

/** Start the download early so the first lookup does not wait for it. */
export function preloadCmu() {
  load();
}

/** US IPA for a single word, or null. Waits at most `waitMs` for the first download. */
export async function cmuIpa(word, waitMs = 4000) {
  const w = String(word || '').toLowerCase().trim();
  if (!w || /\s/.test(w)) return null;
  const d = dict || (await Promise.race([load(), new Promise((r) => setTimeout(() => r(null), waitMs))]));
  const variants = d?.get(w);
  return variants?.length ? arpabetToIpa(variants[0]) : null;
}

const VOWELS = {
  AA: 'ɑ', AE: 'æ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', EH: 'ɛ', EY: 'eɪ', IH: 'ɪ', IY: 'i',
  OW: 'oʊ', OY: 'ɔɪ', UH: 'ʊ', UW: 'u',
};
const CONS = {
  B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', F: 'f', G: 'ɡ', HH: 'h', JH: 'dʒ', K: 'k', L: 'l', M: 'm',
  N: 'n', NG: 'ŋ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ', V: 'v', W: 'w', Y: 'j',
  Z: 'z', ZH: 'ʒ',
};
// Consonant clusters allowed at the start of an English syllable (used to place stress marks).
const ONSETS = new Set([
  'pl', 'pr', 'bl', 'br', 'tr', 'dr', 'kl', 'kr', 'ɡl', 'ɡr', 'fl', 'fr', 'θr', 'ʃr', 'sp', 'st', 'sk',
  'sm', 'sn', 'sl', 'sw', 'tw', 'dw', 'kw', 'ɡw', 'θw', 'pj', 'bj', 'kj', 'ɡj', 'mj', 'fj', 'vj', 'hj',
  'spl', 'spr', 'str', 'skr', 'skw', 'spj', 'skj',
]);

/** Convert one CMU ARPAbet transcription (e.g. "AH0 B AW1 T") to IPA ("/əˈbaʊt/"). */
export function arpabetToIpa(arpa) {
  const out = [];        // segments
  let consRun = [];      // consonants since the previous vowel
  let sawVowel = false;
  for (const tok of arpa.trim().split(/\s+/)) {
    const m = tok.match(/^([A-Z]+)([012])?$/);
    if (!m) continue;
    const [, ph, stress] = m;
    if (VOWELS[ph] || ph === 'AH' || ph === 'ER') {
      let v;
      if (ph === 'AH') v = stress === '0' ? 'ə' : 'ʌ';
      else if (ph === 'ER') v = stress === '0' ? 'ɚ' : 'ɝ';
      else v = VOWELS[ph];
      // Split preceding consonants into coda (previous syllable) + onset (this syllable).
      let onsetLen = 0;
      if (!sawVowel) onsetLen = consRun.length;
      else {
        for (let k = Math.min(3, consRun.length); k >= 1; k--) {
          const cl = consRun.slice(consRun.length - k);
          if (k === 1 ? cl[0] !== 'ŋ' : ONSETS.has(cl.join(''))) { onsetLen = k; break; }
        }
      }
      const coda = consRun.slice(0, consRun.length - onsetLen);
      const onset = consRun.slice(consRun.length - onsetLen);
      out.push(...coda);
      if (stress === '1') out.push('ˈ');
      else if (stress === '2') out.push('ˌ');
      out.push(...onset, v);
      consRun = [];
      sawVowel = true;
    } else if (CONS[ph]) {
      consRun.push(CONS[ph]);
    }
  }
  out.push(...consRun);
  return `/${out.join('')}/`;
}
