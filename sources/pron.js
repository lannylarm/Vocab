/**
 * Combine pronunciations per part of speech.
 * IPA: UK prefers Wiktionary, US prefers MW Learner's.
 * Audio: UK from Wiktionary; US prefers MW (recorded by MW), else Wiktionary.
 */
export function mergePron(sources) {
  const mw = sources.find((s) => s.id === 'mw-learners')?.pron || [];
  const wk = sources.find((s) => s.id === 'wiktionary')?.pron || [];
  const byPos = new Map();
  const FIELDS = ['uk', 'us', 'ukAudio', 'usAudio'];
  const put = (p, preferred) => {
    const pos = (p.pos || '').toLowerCase();
    const cur = byPos.get(pos) || { pos, uk: null, us: null, ukAudio: null, usAudio: null };
    for (const f of FIELDS) {
      if (!p[f]) continue;
      if (preferred.includes(f) || !cur[f]) cur[f] = p[f];
    }
    byPos.set(pos, cur);
  };
  wk.forEach((p) => put(p, ['uk', 'ukAudio']));
  mw.forEach((p) => put(p, ['us', 'usAudio']));
  const list = [...byPos.values()].filter((p) => FIELDS.some((f) => p[f]));
  // Fill a missing value from another part of speech only when there is a single distinct value.
  for (const f of FIELDS) {
    const vals = [...new Set(list.map((p) => p[f]).filter(Boolean))];
    if (vals.length === 1) for (const p of list) p[f] ??= vals[0];
  }
  return list; // one row per part of speech; the page groups identical rows for display
}
