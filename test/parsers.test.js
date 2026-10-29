// Offline tests for the dictionary parsers, using fixtures shaped like real API responses.
import assert from 'node:assert/strict';
import { parseMw, cleanMarkup, mwAudioUrl } from '../sources/mw.js';
import { parseWikt } from '../sources/wiktionary.js';
import { mergePron } from '../sources/pron.js';
import { arpabetToIpa, parseCmu } from '../sources/cmu.js';

// --- MW markup ---
assert.equal(cleanMarkup('{bc}to move {it}quickly{/it} on foot'), 'to move quickly on foot');
assert.equal(cleanMarkup('{bc}{sx|leave||} {dx}see also {dxt|go||}{/dx}'), 'leave');
assert.equal(cleanMarkup('{ldquo}Hi{rdquo}'), '“Hi”');

// --- MW Learner's-like fixture ---
const mwTake = [
  {
    meta: { id: 'take:1', stems: ['take', 'took', 'taken', 'take off', 'take after'] },
    hwi: { hw: 'take' },
    fl: 'verb',
    def: [{
      sseq: [
        [['sense', { sn: '1', dt: [['text', '{bc}to get into your hands'], ['vis', [{ t: 'She {it}took{/it} the book.' }]]] }]],
        [['pseq', [['bs', { sense: { dt: [['text', '{bc}to carry something with you']] } }]]]],
      ],
    }],
    dros: [
      { drp: 'take off', gram: 'phrasal verb', def: [{ sseq: [[['sense', { dt: [['text', '{bc}to leave the ground and begin flying'], ['vis', [{ t: 'The plane {it}took off{/it} on time.' }]]] }]]] }] },
      { drp: 'take (someone) after', def: [{ sseq: [[['sense', { dt: [['text', '{bc}to look or behave like an older relative']] }]]] }] },
    ],
  },
];

let r = parseMw(mwTake, 'take', 'mw-learners');
assert.equal(r.senses.length, 2, 'two main senses (incl. pseq/bs)');
assert.equal(r.senses[0].definition, 'to get into your hands');
assert.deepEqual(r.senses[0].examples, ['She took the book.']);
assert.equal(r.phrases.length, 2);

r = parseMw(mwTake, 'take off', 'mw-learners');
assert.equal(r.senses.length, 1, 'phrase query matches run-on');
assert.equal(r.senses[0].headword, 'take off');
assert.equal(r.senses[0].pos, 'phrasal verb');

r = parseMw(mwTake, 'take after', 'mw-learners');
assert.equal(r.senses.length, 1, 'parenthetical object ignored when matching');

r = parseMw(mwTake, 'took', 'mw-learners');
assert.equal(r.senses.length, 0);
assert.deepEqual(r.suggestions, ['take'], 'inflected form suggests base');

r = parseMw(['sweat', 'swear'], 'sweet ass', 'mw-learners');
assert.deepEqual(r.suggestions, ['sweat', 'swear'], 'not-found returns suggestions');

// --- Wiktionary fixture (shape from kaikki.org "sweet as") ---
const wikt = [{
  word: 'sweet as', lang: 'English', lang_code: 'en', pos: 'adj',
  senses: [{ glosses: ['Wonderful, extremely good.'], examples: [{ text: 'His new car is sweet as.', type: 'example' }], tags: ['Australia', 'New-Zealand', 'UK', 'not-comparable', 'slang'] }],
}];
r = parseWikt(wikt);
assert.equal(r.senses.length, 1);
assert.equal(r.senses[0].pos, 'adjective');
assert.deepEqual(r.senses[0].labels, ['Australia', 'New Zealand', 'UK', 'slang']);
assert.deepEqual(r.senses[0].examples, ['His new car is sweet as.']);

const wiktRan = [{ word: 'ran', lang_code: 'en', pos: 'verb', senses: [{ glosses: ['simple past of run'], tags: ['form-of'], form_of: [{ word: 'run' }] }] }];
r = parseWikt(wiktRan);
assert.equal(r.senses.length, 0);
assert.deepEqual(r.suggestions, ['run']);

// --- Pronunciation ---
mwTake[0].hwi.prs = [{ ipa: 'ˈteɪk' }];
r = parseMw(mwTake, 'take', 'mw-learners');
assert.deepEqual(r.pron, [{ pos: 'verb', uk: null, us: '/ˈteɪk/', ukAudio: null, usAudio: null }]);
mwTake[0].hwi.prs = [{ ipa: 'ˈteɪk', sound: { audio: 'take0001' } }];
r = parseMw(mwTake, 'take', 'mw-learners');
assert.equal(r.pron[0].usAudio, 'https://media.merriam-webster.com/audio/prons/en/us/mp3/t/take0001.mp3');
assert.match(mwAudioUrl('bixoo01'), /\/mp3\/bix\/bixoo01\.mp3$/);
assert.match(mwAudioUrl('ggask01'), /\/mp3\/gg\//);
assert.match(mwAudioUrl('3d000001'), /\/mp3\/number\//);

const wiktTomato = [{
  word: 'tomato', lang_code: 'en', pos: 'noun',
  sounds: [
    { ipa: '/təˈmɑːtəʊ/', tags: ['Received-Pronunciation'] },
    { ipa: '[tʰəˈmɑːtəʊ]', tags: ['Received-Pronunciation'] },
    { ipa: '/təˈmeɪtoʊ/', tags: ['General-American'] },
    { audio: 'En-uk-tomato.ogg', mp3_url: 'https://upload.wikimedia.org/a/En-uk-tomato.ogg.mp3' },
    { audio: 'en-us-tomato.ogg', mp3_url: 'https://upload.wikimedia.org/b/en-us-tomato.ogg.mp3', tags: ['US'] },
  ],
  senses: [{ glosses: ['A fruit.'] }],
}];
const wt = parseWikt(wiktTomato);
assert.deepEqual(wt.pron, [{
  pos: 'noun', uk: '/təˈmɑːtəʊ/', us: '/təˈmeɪtoʊ/',
  ukAudio: 'https://upload.wikimedia.org/a/En-uk-tomato.ogg.mp3',
  usAudio: 'https://upload.wikimedia.org/b/en-us-tomato.ogg.mp3',
}]);

const merged = mergePron([
  { id: 'mw-learners', pron: [{ pos: 'noun', uk: null, us: '/təˈmeɪtoʊ/', ukAudio: null, usAudio: 'mw.mp3' }] },
  { id: 'wiktionary', pron: [{ pos: 'noun', uk: '/təˈmɑːtəʊ/', us: '/təˈmeɪtəʊ/', ukAudio: 'wk-uk.mp3', usAudio: 'wk-us.mp3' }] },
]);
assert.deepEqual(merged, [{ pos: 'noun', uk: '/təˈmɑːtəʊ/', us: '/təˈmeɪtoʊ/', ukAudio: 'wk-uk.mp3', usAudio: 'mw.mp3' }],
  'UK from Wiktionary, US from MW');

const untagged = parseWikt([{ word: 'cat', lang_code: 'en', pos: 'noun', sounds: [{ ipa: '/kæt/' }], senses: [{ glosses: ['An animal.'] }] }]);
assert.deepEqual(untagged.pron[0], { pos: 'noun', uk: '/kæt/', us: '/kæt/', ukAudio: null, usAudio: null }, 'untagged IPA applies to both');

// --- CMU (ARPAbet -> IPA) ---
assert.equal(arpabetToIpa('AH0 B AW1 T'), '/əˈbaʊt/');
assert.equal(arpabetToIpa('S W AA1 P'), '/ˈswɑp/');
assert.equal(arpabetToIpa('K ER0 F AH1 F AH0 L'), '/kɚˈfʌfəl/');
assert.equal(arpabetToIpa('EH1 K S T R AH0'), '/ˈɛkstrə/');
assert.equal(arpabetToIpa('AH2 N D ER0 S T AE1 N D'), '/ˌʌndɚˈstænd/');
const cmu = parseCmu(';;; c\nrecord R EH1 K ER0 D\nrecord(2) R IH0 K AO1 R D # verb\n');
assert.deepEqual(cmu.get('record'), ['R EH1 K ER0 D', 'R IH0 K AO1 R D']);

console.log('All parser tests passed.');
