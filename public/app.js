'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const state = {
  profileId: store.get('vocab.profile'),
  lookup: null,     // last lookup response
  items: [],        // flat list of displayed senses, index = checkbox key
  selected: new Set(),
  review: { queue: [], idx: 0, right: 0, wrong: 0, answered: false },
  words: [],
};

// ---------- Pronunciation ----------
const settings = {
  get autoplay() { return store.get('vocab.autoplay') === '1'; }, // off by default
  get accent() { return store.get('vocab.accent') || 'uk'; },
};

/**
 * UK / US rows: accent label, IPA (single words only), speaker button.
 * Plays the dictionary recording when there is one, otherwise the device's voice.
 */
function pronHtml(text, p = {}, showIpa = true) {
  const row = (acc, ipa, audio) => `<span class="accent">${acc.toUpperCase()}</span>
    ${showIpa && ipa ? `<span class="ipa">${esc(ipa)}</span>` : ''}
    <button type="button" class="say" title="Play ${acc.toUpperCase()} pronunciation"
      data-text="${esc(text)}" data-lang="${acc === 'uk' ? 'en-GB' : 'en-US'}" data-audio="${esc(audio || '')}"
      data-acc="${acc}" aria-label="Play ${acc.toUpperCase()} pronunciation">🔊</button>`;
  return `<div class="pron">${row('uk', p.uk, p.ukAudio)}<span class="sep">·</span>${row('us', p.us, p.usAudio)}</div>`;
}

let player;
function speakTts(text, lang) {
  if (!('speechSynthesis' in window)) return toast('This device cannot play speech.');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-') === lang);
  if (voice) u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}
function playPron(btn) {
  const { text, lang, audio } = btn.dataset;
  if (player) player.pause();
  if (!audio) return speakTts(text, lang);
  player = new Audio(audio);
  player.play().catch(() => speakTts(text, lang));
  player.onerror = () => speakTts(text, lang);
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.say');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  playPron(btn);
});
function autoPlayIn(container) {
  if (!settings.autoplay) return;
  const btn = container.querySelector(`.say[data-acc="${settings.accent}"]`) || container.querySelector('.say');
  if (btn) playPron(btn);
}

// ---------- Settings ----------
$('#settingsBtn').addEventListener('click', () => {
  $('#autoplayToggle').checked = settings.autoplay;
  $('#accentSelect').value = settings.accent;
  $('#settingsPanel').classList.toggle('hidden');
});
$('#autoplayToggle').addEventListener('change', (e) => store.set('vocab.autoplay', e.target.checked ? '1' : '0'));
$('#accentSelect').addEventListener('change', (e) => store.set('vocab.accent', e.target.value));

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.profileId) headers['X-Profile-Id'] = state.profileId;
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (res.status === 401) { showLogin(); throw new Error('Login required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- Login ----------
function showLogin() { $('#loginOverlay').classList.remove('hidden'); $('#passcode').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ passcode: $('#passcode').value }) });
    $('#loginOverlay').classList.add('hidden');
    start();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

// ---------- Profiles ----------
async function loadProfiles() {
  const profiles = await api('/api/profiles');
  const sel = $('#profileSelect');
  sel.innerHTML = profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (!profiles.length) {
    await addProfile(true);
    return;
  }
  if (!profiles.some((p) => String(p.id) === String(state.profileId))) state.profileId = String(profiles[0].id);
  sel.value = state.profileId;
  store.set('vocab.profile', state.profileId);
}

async function addProfile(first = false) {
  const name = prompt(first ? "Who's learning? Enter a name:" : 'New learner name:');
  if (!name || !name.trim()) return;
  const p = await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
  state.profileId = String(p.id);
  store.set('vocab.profile', state.profileId);
  await loadProfiles();
  onProfileChanged();
}

$('#addProfile').addEventListener('click', () => addProfile().catch((e) => toast(e.message)));
$('#profileSelect').addEventListener('change', (e) => {
  state.profileId = e.target.value;
  store.set('vocab.profile', state.profileId);
  onProfileChanged();
});

function onProfileChanged() {
  state.selected.clear();
  updateSaveBar();
  if (state.lookup) runLookup(state.lookup.query);
  refreshStats();
  if (!$('#tab-words').classList.contains('hidden')) loadWords();
  if (!$('#tab-review').classList.contains('hidden')) showReviewStart();
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((btn) =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  $('#saveBar').classList.toggle('hidden', name !== 'lookup' || !state.selected.size);
  if (name === 'review') showReviewStart();
  if (name === 'words') loadWords();
  if (name === 'lookup') $('#lookupInput').focus();
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const b = $('#dueBadge');
    b.textContent = s.due;
    b.classList.toggle('hidden', !s.due);
    return s;
  } catch { return null; }
}

// ---------- Look up ----------
$('#lookupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#lookupInput').value.trim();
  if (q) runLookup(q);
});

async function runLookup(q) {
  $('#lookupInput').value = q;
  state.selected.clear();
  updateSaveBar();
  $('#lookupResults').innerHTML = '<p class="spinner">Searching dictionaries…</p>';
  try {
    state.lookup = await api(`/api/lookup?q=${encodeURIComponent(q)}`);
    renderLookup();
  } catch (err) {
    $('#lookupResults').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function senseHtml(item, key, query) {
  const labels = (item.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join('');
  const showHw = item.headword && item.headword.toLowerCase() !== query.toLowerCase();
  return `<label class="sense ${item.saved ? 'saved' : ''}">
    <input type="checkbox" data-key="${key}" ${item.saved ? 'checked disabled' : ''}>
    <div class="sense-body">
      <div class="meta">
        ${showHw ? `<span class="hw">${esc(item.headword)}</span>` : ''}
        <span class="pos">${esc(item.pos)}</span>${labels}
        ${item.source === 'ai' ? '<span class="tag ai">AI</span>' : ''}
        ${item.saved ? '<span class="tag saved-tag">saved</span>' : ''}
      </div>
      <div class="def">${esc(item.definition)}</div>
      ${(item.examples || []).map((x) => `<div class="ex">${esc(x)}</div>`).join('')}
    </div>
  </label>`;
}

function renderLookup() {
  const { query, sources, suggestions } = state.lookup;
  state.items = [];
  const add = (it) => { state.items.push(it); return state.items.length - 1; };
  let html = '';
  let total = 0;

  for (const s of sources) {
    if (!s.senses.length && !s.phrases.length && !s.error) continue;
    total += s.senses.length;
    html += `<div class="source"><h2><span>${esc(s.label)}</span>${s.error ? `<span class="err">unavailable</span>` : ''}</h2>`;
    html += s.senses.map((it) => senseHtml(it, add(it), query)).join('');
    if (s.phrases.length) {
      html += `<details class="phrases"><summary>Phrases and idioms with “${esc(query)}” (${s.phrases.length})</summary>`;
      html += s.phrases.map((it) => senseHtml(it, add(it), query)).join('');
      html += '</details>';
    }
    html += '</div>';
  }

  // Pronunciation header. IPA for single words only; phrases get speaker buttons only.
  const isPhrase = query.includes(' ');
  const prons = isPhrase ? [] : state.lookup.pronunciations || [];
  if (total) {
    let rowsHtml;
    if (prons.length) {
      const groups = new Map();
      for (const pr of prons) {
        const k = `${pr.uk}|${pr.us}|${pr.ukAudio}|${pr.usAudio}`;
        if (!groups.has(k)) groups.set(k, { ...pr, poses: [] });
        groups.get(k).poses.push(pr.pos);
      }
      const rows = [...groups.values()];
      rowsHtml = rows
        .map((g) => (rows.length > 1 ? `<div class="pos">${esc(g.poses.filter(Boolean).join(', '))}</div>` : '') + pronHtml(query, g))
        .join('');
    } else {
      rowsHtml = pronHtml(query, {}, !isPhrase);
    }
    html = `<div class="pron-block"><div class="hw-big">${esc(query)}</div>${rowsHtml}</div>` + html;
  }

  if (!total) html = `<p class="muted">No dictionary entry found for “${esc(query)}”.</p>` + html;
  if (suggestions.length) {
    html += `<div class="suggest"><span class="muted">Did you mean:</span><br>${suggestions
      .map((s) => `<button class="secondary small" data-suggest="${esc(s)}">${esc(s)}</button>`)
      .join('')}</div>`;
  }
  if (!sources.some((s) => s.id === 'ai')) {
    html += `<div class="ai-more"><button id="aiMoreBtn" class="ghost">Ask AI for missing meanings (incl. NZ usage)</button></div>`;
  }
  $('#lookupResults').innerHTML = html;
  autoPlayIn($('#lookupResults'));
}

$('#lookupResults').addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  const key = Number(cb.dataset.key);
  if (cb.checked) state.selected.add(key); else state.selected.delete(key);
  cb.closest('.sense').classList.toggle('checked', cb.checked);
  updateSaveBar();
});

$('#lookupResults').addEventListener('click', async (e) => {
  const sug = e.target.closest('[data-suggest]');
  if (sug) return runLookup(sug.dataset.suggest);
  if (e.target.id === 'aiMoreBtn') {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Asking AI…';
    try {
      const known = state.lookup.sources.flatMap((s) => s.senses.map((x) => x.definition));
      const { senses } = await api('/api/ai-more', {
        method: 'POST',
        body: JSON.stringify({ q: state.lookup.query, known }),
      });
      if (!senses.length) {
        toast('AI found nothing important missing.');
        btn.remove();
        return;
      }
      state.lookup.sources.push({ id: 'ai', label: 'AI (not from a dictionary)', senses, phrases: [], suggestions: [] });
      const kept = new Set(state.selected);
      renderLookup();
      // restore checkbox state (keys are stable because existing items keep their order)
      kept.forEach((k) => {
        const cb = document.querySelector(`input[data-key="${k}"]`);
        if (cb) { cb.checked = true; cb.closest('.sense').classList.add('checked'); }
      });
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Ask AI for missing meanings (incl. NZ usage)';
    }
  }
});

function updateSaveBar() {
  const n = state.selected.size;
  $('#saveCount').textContent = `${n} selected`;
  const onLookup = !$('#tab-lookup').classList.contains('hidden');
  $('#saveBar').classList.toggle('hidden', !n || !onLookup);
}

$('#saveBtn').addEventListener('click', async () => {
  const btn = $('#saveBtn');
  const items = [...state.selected].map((k) => {
    const it = state.items[k];
    return {
      headword: it.headword || state.lookup.query,
      pos: it.pos,
      definition: it.definition,
      example: (it.examples || [])[0] || '',
      labels: it.labels || [],
      source: it.source,
      ipa_uk: it.ipa_uk || null,
      ipa_us: it.ipa_us || null,
      audio_uk: it.audio_uk || null,
      audio_us: it.audio_us || null,
    };
  });
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await api('/api/save', { method: 'POST', body: JSON.stringify({ items }) });
    toast(r.saved
      ? `Saved ${r.saved} meaning${r.saved === 1 ? '' : 's'}. Practice sentences are being prepared.`
      : 'Already saved.');
    await runLookup(state.lookup.query);
    refreshStats();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save selected';
  }
});

// ---------- Review ----------
async function showReviewStart() {
  $('#reviewCard').classList.add('hidden');
  $('#reviewDone').classList.add('hidden');
  $('#reviewStart').classList.remove('hidden');
  const s = await refreshStats();
  if (!s) return;
  $('#reviewSummary').textContent = s.total
    ? `${s.due} of ${s.total} saved meaning${s.total === 1 ? '' : 's'} due for review.`
    : 'No saved words yet. Look up a word and save a meaning first.';
  $('#startDue').disabled = !s.due;
  $('#startAll').disabled = !s.total;
}

$('#startDue').addEventListener('click', () => startReview('due'));
$('#startAll').addEventListener('click', () => startReview('all'));

async function startReview(mode) {
  $('#reviewSummary').textContent = 'Preparing sentences…';
  try {
    const { items } = await api(`/api/review?mode=${mode}&limit=20`);
    if (!items.length) { $('#reviewSummary').textContent = 'Nothing to review right now.'; return; }
    state.review = { queue: items, idx: 0, right: 0, wrong: 0, answered: false };
    $('#reviewStart').classList.add('hidden');
    $('#reviewCard').classList.remove('hidden');
    showReviewItem();
  } catch (err) {
    $('#reviewSummary').textContent = err.message;
  }
}

function sentenceHtml(sentence, fill) {
  const parts = sentence.split('_____');
  const blank = fill
    ? `<span class="blank filled">${esc(fill)}</span>`
    : '<span class="blank">&nbsp;</span>';
  return esc(parts[0]) + blank + esc(parts.slice(1).join('_____'));
}

function showReviewItem() {
  const r = state.review;
  const item = r.queue[r.idx];
  r.answered = false;
  $('#reviewProgress').textContent = `${r.idx + 1} / ${r.queue.length}`;
  $('#reviewSentence').innerHTML = sentenceHtml(item.sentence);
  $('#reviewOptions').innerHTML = item.options.map((o) => `<span class="option">${esc(o)}</span>`).join('');
  $('#reviewFeedback').className = 'feedback hidden';
  $('#nextBtn').classList.add('hidden');
  $('#answerInput').value = '';
  $('#answerInput').disabled = false;
  $('#checkBtn').disabled = false;
  $('#answerInput').focus();
}

$('#answerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = state.review;
  if (r.answered) return nextItem();
  const input = $('#answerInput').value.trim();
  if (!input) return;
  const item = r.queue[r.idx];
  $('#checkBtn').disabled = true;
  try {
    const res = await api(`/api/review/${item.id}/answer`, {
      method: 'POST',
      body: JSON.stringify({ input, variant: item.variant }),
    });
    r.answered = true;
    $('#answerInput').disabled = true;
    if (res.result === 'wrong') r.wrong++; else r.right++;

    $('#reviewSentence').innerHTML = sentenceHtml(item.sentence, res.answer);

    const verdict = {
      correct: 'Correct!',
      form: `Right word — the sentence needs “${res.answer}”.`,
      wrong: `Not quite. Answer: “${res.answer}”`,
    }[res.result];
    const next = res.result === 'wrong' ? 'You will see this again soon.' :
      res.nextInDays ? `Next review in ${res.nextInDays} day${res.nextInDays === 1 ? '' : 's'}.` : '';
    const fb = $('#reviewFeedback');
    fb.className = `feedback ${res.result}`;
    fb.innerHTML = `<div class="verdict">${esc(verdict)}</div>
      <div><strong>${esc(res.headword)}</strong> <span class="pos">${esc(res.pos)}</span></div>
      ${pronHtml(res.headword, { uk: res.ipa_uk, us: res.ipa_us, ukAudio: res.audio_uk, usAudio: res.audio_us }, res.entry_type === 'word')}
      <div class="def">${esc(res.definition)}</div>
      ${res.example ? `<div class="ex">${esc(res.example)}</div>` : ''}
      ${next ? `<div class="muted" style="margin-top:6px;font-size:14px">${esc(next)}</div>` : ''}`;
    $('#nextBtn').classList.remove('hidden');
    $('#nextBtn').focus();
    autoPlayIn(fb);
  } catch (err) {
    toast(err.message);
    $('#checkBtn').disabled = false;
  }
});

$('#nextBtn').addEventListener('click', nextItem);

function nextItem() {
  const r = state.review;
  r.idx++;
  if (r.idx < r.queue.length) return showReviewItem();
  $('#reviewCard').classList.add('hidden');
  const done = $('#reviewDone');
  done.classList.remove('hidden');
  done.innerHTML = `<h2>Session finished</h2>
    <p>${r.right} correct, ${r.wrong} to practise again.</p>
    <div class="row"><button id="backToStart">Done</button></div>`;
  $('#backToStart').addEventListener('click', showReviewStart);
  refreshStats();
}

// ---------- My words ----------
let wordsPoll;
async function loadWords(silent = false) {
  clearTimeout(wordsPoll);
  if (!silent) $('#wordsList').innerHTML = '<p class="spinner">Loading…</p>';
  try {
    state.words = await api('/api/words');
    renderWords();
    // While practice sentences are still being generated, check again every 5 s (only on this tab).
    if (state.words.some((w) => !w.sentence_count)) {
      wordsPoll = setTimeout(() => {
        if (!$('#tab-words').classList.contains('hidden') && !document.hidden) loadWords(true);
      }, 5000);
    }
  } catch (err) {
    if (!silent) $('#wordsList').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function dueText(d) {
  const ms = new Date(d) - Date.now();
  if (ms <= 0) return 'due now';
  const days = Math.ceil(ms / 86400000);
  return days <= 1 ? 'due within a day' : `due in ${days} days`;
}

function renderWords() {
  const f = $('#wordsFilter').value.trim().toLowerCase();
  const list = state.words.filter((w) => !f || w.headword.toLowerCase().includes(f) || w.definition.toLowerCase().includes(f));
  if (!list.length) {
    $('#wordsList').innerHTML = `<p class="muted">${state.words.length ? 'No matches.' : 'No saved words yet.'}</p>`;
    return;
  }
  $('#wordsList').innerHTML = list.map((w) => `
    <div class="word">
      <div class="word-head">
        <div><span class="hw">${esc(w.headword)}</span> <span class="pos">${esc(w.pos)}</span>
          ${(w.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join('')}
          ${w.source === 'ai' ? '<span class="tag ai">AI</span>' : ''}</div>
        <div class="word-actions">
          <button class="ghost small" data-regen="${w.id}" title="Make new practice sentences">New sentences</button>
          <button class="ghost small" data-del="${w.id}">Delete</button>
        </div>
      </div>
      ${pronHtml(w.headword, { uk: w.ipa_uk, us: w.ipa_us, ukAudio: w.audio_uk, usAudio: w.audio_us }, w.entry_type === 'word')}
      <div class="def">${esc(w.definition)}</div>
      ${w.example ? `<div class="ex">${esc(w.example)}</div>` : ''}
      <div class="stats">Level ${w.level} · ${dueText(w.due_at)} · ✓ ${w.correct_count} ✗ ${w.wrong_count}${w.sentence_count ? '' : ' · preparing sentences…'}</div>
    </div>`).join('');
}

$('#wordsFilter').addEventListener('input', renderWords);
$('#wordsList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const regen = e.target.closest('[data-regen]');
  try {
    if (del) {
      if (!confirm('Delete this meaning?')) return;
      await api(`/api/words/${del.dataset.del}`, { method: 'DELETE' });
      state.words = state.words.filter((w) => String(w.id) !== del.dataset.del);
      renderWords();
      refreshStats();
    } else if (regen) {
      regen.disabled = true;
      regen.textContent = 'Working…';
      await api(`/api/words/${regen.dataset.regen}/regenerate`, { method: 'POST' });
      toast('New practice sentences ready.');
      loadWords();
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Start ----------
async function start() {
  try {
    await loadProfiles();
    refreshStats();
    $('#lookupInput').focus();
  } catch (err) {
    toast(err.message);
  }
}

(async () => {
  try {
    const st = await fetch('/api/auth-status').then((r) => r.json());
    if (st.required && !st.ok) showLogin();
    else start();
  } catch {
    toast('Cannot reach the server.');
  }
})();

// Resume the "My words" update when the page becomes visible again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('#tab-words').classList.contains('hidden') && state.words.some((w) => !w.sentence_count)) {
    loadWords(true);
  }
});

// Tapping/clicking the search box clears the previous word (but not while you are already typing in it).
$('#lookupInput').addEventListener('pointerdown', (e) => {
  if (document.activeElement !== e.currentTarget) e.currentTarget.value = '';
});
