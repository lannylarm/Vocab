/** Combine pronunciations per part of speech: UK prefers Wiktionary, US prefers MW Learner's. */
export function mergePron(sources) {
  const mw = sources.find((s) => s.id === 'mw-learners')?.pron || [];
  const wk = sources.find((s) => s.id === 'wiktionary')?.pron || [];
  const byPos = new Map();
  const put = (p, pref) => {
    const pos = (p.pos || '').toLowerCase();
    const cur = byPos.get(pos) || { pos, uk: null, us: null };
    if (pref === 'mw') { cur.us = p.us || cur.us; cur.uk = cur.uk || p.uk; }
    else { cur.uk = p.uk || cur.uk; cur.us = cur.us || p.us; }
    byPos.set(pos, cur);
  };
  wk.forEach((p) => put(p, 'wk'));
  mw.forEach((p) => put(p, 'mw'));
  const list = [...byPos.values()].filter((p) => p.uk || p.us);
  // Fill a missing accent from another part of speech only when there is a single distinct value.
  const ukVals = [...new Set(list.map((p) => p.uk).filter(Boolean))];
  const usVals = [...new Set(list.map((p) => p.us).filter(Boolean))];
  for (const p of list) {
    if (!p.uk && ukVals.length === 1) p.uk = ukVals[0];
    if (!p.us && usVals.length === 1) p.us = usVals[0];
  }
  return list; // one row per part of speech; the page groups identical rows for display
}
