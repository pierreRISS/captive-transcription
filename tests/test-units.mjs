// Tests unitaires des modules purs du pipeline de surtitrage.
//   node tests/test-units.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CONFIG } = await import(join(ROOT, 'config/surtitles.js'));
const { createAgreement, wordKey } = await import(join(ROOT, 'src/agreement.js'));
const { createChunker } = await import(join(ROOT, 'src/chunker.js'));
const { createFeed } = await import(join(ROOT, 'src/feed.js'));
const { createTranslator, buildSystemPrompt } = await import(join(ROOT, 'src/translator.js'));
const { planWords, tokenize, normLang, otherLang, createPipeline } =
  await import(join(ROOT, 'src/pipeline.js'));
const { createSpeakerTracker } = await import(join(ROOT, 'src/speakers.js'));
const { readGapMs, createStage } = await import(join(ROOT, 'src/stage.js'));
const { createStereoCheck, analyseInterleaved } = await import(join(ROOT, 'src/stereo.js'));
const { createCaptionBuffer } = await import(join(ROOT, 'src/captions.js'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      obtenu : ${g}\n      attendu: ${w}`); }
};
const words = (s) => s.split(/\s+/).filter(Boolean)
  .map((t, i) => ({ text: t, start: i * 0.3, end: (i + 1) * 0.3 }));
const texts = (ws) => ws.map((w) => w.text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
console.log('\n--- LocalAgreement-2 (§2) ---');
{
  const a = createAgreement({ agreementN: 2 });
  check('1re partial : rien de stable encore', texts(a.partial(words('Bonsoir à'))), []);
  check('2e partial : le préfixe commun est publié',
    texts(a.partial(words('Bonsoir à toutes'))), ['Bonsoir', 'à']);
  check('3e partial : seul le nouveau stable sort',
    texts(a.partial(words('Bonsoir à toutes et à tous'))), ['toutes']);
}
{
  const a = createAgreement({ agreementN: 2 });
  a.partial(words('je vais vous parler'));
  a.partial(words('je vais vous parler'));
  // Le modèle se corrige : « parler » devient « parier ». Déjà publié.
  const r = a.final(words('je vais vous parier de theatre'));
  check('le final ne retracte rien, il n\'ajoute que la queue',
    texts(r.delta), ['de', 'theatre']);
  check('la divergence est comptée, pas corrigée', r.contradicted, 1);
  check('taux de divergence exposé', Math.round(a.divergenceRate() * 100) / 100, 0.25);
}
{
  const a = createAgreement({ agreementN: 2 });
  a.partial(words('Bonsoir'));
  const d = a.partial(words('Bonsoir,'));
  // Le mot est publié dans la forme de la partial courante — ce qui compte est
  // qu'il soit publié : sans normalisation, le préfixe casserait et TOUT ce qui
  // suit resterait bloqué derrière lui.
  check('la ponctuation qui apparaît ne bloque pas le préfixe', texts(d), ['Bonsoir,']);
}
{
  const a = createAgreement({ agreementN: 3 });
  a.partial(words('un deux trois'));
  check('N=3 : deux partials ne suffisent pas', texts(a.partial(words('un deux trois'))), []);
  check('N=3 : la troisième publie', texts(a.partial(words('un deux trois'))), ['un', 'deux', 'trois']);
}
{
  const a = createAgreement({ agreementN: 2 });
  a.partial(words('un deux trois'));
  a.partial(words('un deux trois'));
  const d = a.partial(words('un deux'));   // le modèle raccourcit
  check('une partial plus courte ne retracte pas', texts(d), []);
}
check('wordKey normalise casse et ponctuation', wordKey({ text: '«Bonsoir,' }), 'bonsoir');

// ===========================================================================
console.log('\n--- Découpage en blocs (§3) ---');
const cfg = { ...CONFIG, MIN_WORDS: 5, MAX_WORDS: 12, IDLE_FLUSH_MS: 800, MAX_BLOCK_AGE_MS: 2200 };
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('bonsoir à toutes et à tous.')) c.push(w, 0);
  check('ponctuation forte : flush immédiat', out.map((b) => b.text),
    ['bonsoir à toutes et à tous.']);
}
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('un deux trois quatre cinq six sept huit neuf dix onze douze treize')) c.push(w, 0);
  check('MAX_WORDS : coupe à 12', out.map((b) => b.words.length), [12]);
  check('le 13e reste en attente', c.pending(), 1);
}
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('je voulais vous parler ce soir mais le temps manque')) c.push(w, 0);
  check('connecteur : on coupe AVANT « mais »', out.map((b) => b.text),
    ['je voulais vous parler ce soir']);
}
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('oui mais non')) c.push(w, 0);
  check('sous MIN_WORDS : le connecteur ne coupe pas', out.length, 0);
}
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('trois mots seulement')) c.push(w, 1000);
  check('avant le délai : rien', out.length, 0);
  c.timeCheck(1000 + cfg.IDLE_FLUSH_MS + 1);
  check('IDLE_FLUSH_MS : les orphelins ne restent pas bloqués', out.map((b) => b.text),
    ['trois mots seulement']);
}
{
  // Règle d'âge : en parole CONTINUE (des mots arrivent sans cesse), l'écran ne
  // doit pas rester figé jusqu'à MAX_WORDS. C'est le critère n°4.
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  let t = 0;
  for (const w of words('phrase longue sans aucune ponctuation')) { c.push(w, t); t += 300; }
  // t = 1500 : le buffer a 1,5 s d'âge, sous les 2,2 s → rien ne part encore.
  check('avant l\'âge maxi : le bloc attend', c.timeCheck(1500), null);
  c.push({ text: 'forte', end: 9 }, 1500);
  // 2250 ms : toujours en parole (dernier mot il y a 750 ms < IDLE), mais le
  // buffer a dépassé MAX_BLOCK_AGE_MS.
  check('âge maximum : le bloc part quand même', c.timeCheck(2250)?.reason, 'max_age');
  check('… et il contient bien la phrase en cours', out[0].words.length, 6);
}
{
  const out = [];
  const c = createChunker(cfg, (b) => out.push(b));
  for (const w of words('deux mots')) c.push(w, 0);
  c.flush('final');
  check('fin d\'utterance : flush sans condition', out.map((b) => b.reason), ['final']);
  check('endAudio porté par le bloc', out[0].endAudio, 0.6);
  check('startAudio porté par le bloc', out[0].startAudio, 0);
}

// ===========================================================================
console.log('\n--- Cadence mot à mot (retard constant) ---');
{
  const c = { EST_WORDS_PER_SECOND: 2.6 };
  const p = planWords('good evening everyone tonight', 10, 12, c);
  check('un mot par mot, dans l\'ordre', p.map((w) => w.text),
    ['good', 'evening', 'everyone', 'tonight']);
  check('le premier mot est daté au début du segment', p[0].audioAt, 10);
  check('les dates sont croissantes et dans le segment',
    p.every((w, i) => w.audioAt >= 10 && w.audioAt < 12 && (i === 0 || w.audioAt > p[i - 1].audioAt)),
    true);
  // La durée attribuée à un mot est celle qui le sépare du suivant : « good »
  // (4 lettres) doit tenir moins longtemps que « everyone » (8 lettres).
  check('un mot long occupe plus de temps qu\'un mot court',
    (p[1].audioAt - p[0].audioAt) < (p[3].audioAt - p[2].audioAt), true);
}
{
  const c = { EST_WORDS_PER_SECOND: 2 };
  // Moteur 'claude' : un bloc ne porte que sa fin. On remonte au débit supposé.
  const p = planWords('one two three four', null, 10, c);
  check('sans start : le segment est reconstitué au débit supposé', p[0].audioAt, 8);
  check('sans aucun timing : pas d\'ancrage, la cadence prend le relais',
    planWords('a b', null, null, c).map((w) => w.audioAt), [null, null]);
  check('un début postérieur à la fin ne produit pas de dates absurdes',
    planWords('a b', 12, 10, c).every((w) => w.audioAt === null), true);
  check('texte vide : rien', planWords('   ', 0, 1, c), []);
}
check('tokenize garde start et end (timings des mots)',
  tokenize({ words: [{ word: 'salut', start: 1, end: 1.4 }] }), [{ text: 'salut', start: 1, end: 1.4 }]);
{
  // L'ORIGINAL a les timings réels de Gladia : on ne doit rien estimer.
  const p = planWords('ignoré', 0, 10, { EST_WORDS_PER_SECOND: 2.6 },
    [{ text: 'un', start: 1 }, { text: 'deux', start: 4.5 }]);
  check('timings réels : utilisés tels quels',
    p, [{ text: 'un', audioAt: 1 }, { text: 'deux', audioAt: 4.5 }]);
}

// ===========================================================================
console.log('\n--- Deux locuteurs, deux langues ---');
check('normLang normalise les formes de Gladia',
  ['fr-FR', 'FRENCH', 'en-US', 'english', '', null].map(normLang),
  ['fr', 'fr', 'en', 'en', null, null]);
{
  const c = { LANGUAGES: ['fr', 'en'], SOURCE_LANGUAGE: 'fr', TARGET_LANGUAGE: 'en' };
  check('on traduit toujours vers l\'AUTRE langue',
    [otherLang('fr', c), otherLang('en-US', c), otherLang(null, c)], ['en', 'fr', 'en']);
}
{
  const c = { SPEAKERS: [{ id: 'L', channel: 0 }, { id: 'R', channel: 1 }],
              SPEAKER_MIN_RATIO: 1.6, ENERGY_WINDOW_S: 30, CHUNK_MS: 40 };
  const t = createSpeakerTracker(c);
  // 0 → 1 s : G parle (D ne capte que la diaphonie). 1 → 2 s : D parle.
  for (let i = 0; i < 25; i++) t.push({ tStart: i * .04, tEnd: (i + 1) * .04, rmsL: .25, rmsR: .09 });
  for (let i = 25; i < 50; i++) t.push({ tStart: i * .04, tEnd: (i + 1) * .04, rmsL: .09, rmsR: .25 });
  check('énoncé sur le canal gauche → locuteur G', t.speakerOf(0, 1), 'L');
  check('énoncé sur le canal droit → locuteur D', t.speakerOf(1, 2), 'R');
  // À cheval sur les deux : l'énergie s'équilibre, on refuse de trancher plutôt
  // que d'écrire dans la mauvaise colonne.
  check('indécis → null (le pipeline garde le locuteur précédent)', t.speakerOf(0, 2), null);
  check('hors de toute énergie connue → null', t.speakerOf(90, 95), null);
  check('sans timing exploitable → null', t.speakerOf(null, null), null);
  check('la balance penche du bon côté', t.balance() > 60, true);
}
{
  // Diaphonie forte : les deux micros captent les deux voix à niveau proche.
  // Le système doit alors refuser de trancher, pas deviner.
  const c = { SPEAKERS: [{ id: 'L' }, { id: 'R' }], SPEAKER_MIN_RATIO: 1.6, ENERGY_WINDOW_S: 30 };
  const t = createSpeakerTracker(c);
  for (let i = 0; i < 25; i++) t.push({ tStart: i * .04, tEnd: (i + 1) * .04, rmsL: .25, rmsR: .22 });
  check('diaphonie trop forte : indécis assumé', t.speakerOf(0, 1), null);
}

// ===========================================================================
console.log('\n--- Place FIXE par langue (grille locuteur × langue) ---');
{
  // Retard nul et cadence libre : les mots sortent tout de suite, on teste le
  // ROUTAGE, pas la cadence (mesurée par le harnais et par le bloc « plancher de
  // lisibilité » plus bas). MAX_REVEAL_CPS: 0 débranche ce plancher — sans ça
  // les mots seraient espacés de leur temps de lecture, ce qui est le
  // comportement voulu en scène mais rendrait ce test-ci dépendant d'un sleep.
  const c = { ...CONFIG, DISPLAY_DELAY_MS: 0, MIN_WORD_GAP_MS: 1, CATCH_UP_RATE: 99,
              MAX_REVEAL_CPS: 0, TRANSLATION_ENGINE: 'gladia' };
  const out = [];
  const p = createPipeline(c, {
    onDisplay: (u) => out.push(u), onEvent: () => {}, speakerOf: () => 'L',
  });
  check('les cases sont locuteur × LANGUE, pas original/traduction',
    p.stageKeys, ['L:fr', 'L:en', 'R:fr', 'R:en']);

  p.startAudioClock(Date.now());
  // Le locuteur G parle ANGLAIS. Son original doit aller dans la colonne
  // ANGLAISE, et sa traduction dans la française : c'est l'inverse du cas
  // habituel, et c'est exactement ce que la place fixe exige.
  p.onGladiaMessage({ type: 'transcript', data: { is_final: true, utterance: {
    text: 'good evening', language: 'en', start: 0, end: .08,
    words: [{ word: 'good', start: 0, end: .04 }, { word: 'evening', start: .04, end: .08 }] } } });
  p.onGladiaMessage({ type: 'translation', data: {
    utterance: { text: 'good evening', language: 'en', start: 0, end: .08 },
    original_language: 'en', target_language: 'fr',
    translated_utterance: { text: 'bonsoir à tous', language: 'fr', start: 0, end: .08 } } });
  // Traduction identité renvoyée par Gladia (2 langues cibles) : à jeter.
  p.onGladiaMessage({ type: 'translation', data: {
    utterance: { text: 'good evening', language: 'en', start: 0, end: .08 },
    original_language: 'en', target_language: 'en',
    translated_utterance: { text: 'good evening', language: 'en', start: 0, end: .08 } } });
  await sleep(150);

  check('l\'anglais parlé va dans la colonne anglaise',
    out.filter((u) => u.key === 'L:en').map((u) => u.text), ['good', 'evening']);
  check('sa traduction va dans la colonne française',
    out.filter((u) => u.key === 'L:fr').map((u) => u.text), ['bonsoir', 'à', 'tous']);
  check('AUCUN mot hors de sa colonne de langue',
    out.every((u) => u.key.split(':')[1] === u.meta.lang), true);
  check('la traduction identité est écartée', p.metrics().identityFiltered, 1);
  check('rien n\'est parti chez l\'autre locuteur',
    out.some((u) => u.key.startsWith('R:')), false);
}
{
  // Une langue inattendue ne doit pas faire disparaître du texte en silence.
  const c = { ...CONFIG, DISPLAY_DELAY_MS: 0, MIN_WORD_GAP_MS: 1, MAX_REVEAL_CPS: 0,
              TRANSLATION_ENGINE: 'gladia' };
  const out = [], events = [];
  const p = createPipeline(c, {
    onDisplay: (u) => out.push(u), onEvent: (e) => events.push(e), speakerOf: () => 'R',
  });
  p.startAudioClock(Date.now());
  p.onGladiaMessage({ type: 'transcript', data: { is_final: true, utterance: {
    text: 'hola amigos', language: 'es', start: 0, end: .08 } } });
  await sleep(120);
  check('langue inconnue : le texte est rangé, pas perdu', out.length, 2);
  check('… et l\'anomalie est loggée',
    events.some((e) => e.type === 'lang_unexpected'), true);
}

// ===========================================================================
console.log('\n--- Affichage append-only (§5, critère n°1) ---');
{
  const f = createFeed({ MAX_CHARS_PER_LINE: 20, MAX_LINES: 2 });
  // Les mots arrivent un par un et remplissent la ligne du bas.
  for (const w of 'good evening'.split(' ')) f.append(w);
  check('la ligne se remplit mot à mot', f.lines().map((l) => l.text), ['good evening']);
  check('les mots sont exposés un par un à la vue',
    f.lines()[0].words.map((w) => w.text), ['good', 'evening']);

  f.append('everyone');
  check('quand la ligne est pleine, une ligne neuve s\'ouvre',
    f.lines().map((l) => l.text), ['good evening', 'everyone']);
  const idsBefore = f.lines().map((l) => l.id);
  f.append('welcome');
  check('la ligne du bas garde son identité en s\'allongeant',
    f.lines().map((l) => l.id), idsBefore);
  check('… et le mot est bien ajouté', f.lines()[1].text, 'everyone welcome');

  f.append('to the show tonight');
  check('2 lignes maximum visibles', f.lines().length, 2);
  check('la ligne la plus ancienne est sortie par le haut',
    f.lines().some((l) => l.text === 'good evening'), false);

  // Une respiration ouvre une ligne neuve, même si la ligne courante a de la place.
  const g = createFeed({ MAX_CHARS_PER_LINE: 40, MAX_LINES: 2 });
  g.append('yes');
  g.append('and then', { breakBefore: true });
  check('breakBefore ouvre une ligne neuve', g.lines().map((l) => l.text), ['yes', 'and then']);

  // La garantie structurelle : un mot émis n'a jamais changé.
  const emitted = f.emitted();
  check('tous les mots émis sont gelés', emitted.every((x) => Object.isFrozen(x)), true);
  const before = emitted.map((x) => x.text);
  f.append('one more');
  const after = f.emitted().slice(0, before.length).map((x) => x.text);
  check('aucun mot déjà émis n\'est réécrit', after, before);
  check('aucune API de mutation n\'existe',
    ['update', 'replace', 'remove', 'set', 'edit'].filter((m) => typeof f[m] === 'function'), []);
}

// ===========================================================================
console.log('\n--- File de traduction (§4) ---');
{
  // Séquentialité stricte : jamais deux appels en vol.
  let inFlight = 0, maxInFlight = 0;
  const t = createTranslator({ ...cfg, TRANSLATION_RETRIES: 0, MAX_PENDING_BLOCKS: 99 }, {
    translate: async (text) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight--;
      return 'EN:' + text;
    },
    onResult: (b) => done.push(b),
  });
  const done = [];
  for (const text of ['un', 'deux', 'trois']) t.submit({ seq: done.length, text, endAudio: 1 });
  await sleep(120);
  check('jamais plus d\'un appel en vol', maxInFlight, 1);
  check('ordre préservé', done.map((b) => b.target), ['EN:un', 'EN:deux', 'EN:trois']);
}
{
  // Contexte glissant : le 3e appel voit les 2 blocs précédents.
  const seen = [];
  const t = createTranslator({ ...cfg, CONTEXT_BLOCKS: 2, TRANSLATION_RETRIES: 0 }, {
    translate: async (text, context) => { seen.push(context.map((c) => c.source)); return 'EN:' + text; },
    onResult: () => {},
  });
  for (const text of ['a', 'b', 'c']) t.submit({ seq: 0, text, endAudio: 1 });
  await sleep(60);
  check('contexte glissant de 2 blocs', seen, [[], ['a'], ['a', 'b']]);
}
{
  // Timeout imposé par la file, même si le traducteur l'ignore.
  const errs = [];
  const t = createTranslator({ ...cfg, TRANSLATION_TIMEOUT_MS: 40, TRANSLATION_RETRIES: 1 }, {
    translate: () => new Promise(() => {}),          // ne résout jamais
    onResult: () => {},
    onError: (b, e) => errs.push(e.message),
  });
  t.submit({ seq: 0, text: 'bloqué', endAudio: 1 });
  await sleep(200);
  check('timeout + 1 retry, puis abandon', errs.length, 1);
  check('c\'est bien un timeout', /timeout/.test(errs[0] || ''), true);
  check('la file n\'est pas bloquée', t.pending(), 0);
}
{
  // Anti-accumulation : au-delà de 3 blocs pendants, on fusionne.
  const done = [];
  const t = createTranslator({ ...cfg, MAX_PENDING_BLOCKS: 3, TRANSLATION_RETRIES: 0 }, {
    translate: async (text) => { await sleep(25); return 'EN:' + text; },
    onResult: (b) => done.push(b),
  });
  for (let i = 0; i < 7; i++) t.submit({ seq: i, text: 'bloc' + i, endAudio: i,
                                         speaker: 'L', source: 'fr', targetLang: 'en' });
  await sleep(300);
  check('les blocs en retard sont fusionnés', t.stats.merged > 0, true);
  check('moins d\'appels que de blocs soumis', done.length < 7, true);
  check('le retard est rattrapé', t.pending(), 0);
}
{
  // Le sens de traduction voyage avec le bloc : les deux locuteurs peuvent
  // parler l'un en français, l'autre en anglais.
  const seen = [];
  const t = createTranslator({ ...cfg, TRANSLATION_RETRIES: 0 }, {
    translate: async (text, ctx, ms, dir) => { seen.push(`${dir.source}>${dir.target}`); return 'X'; },
    onResult: () => {},
  });
  t.submit({ seq: 0, text: 'bonsoir', endAudio: 1, speaker: 'L', source: 'fr', targetLang: 'en' });
  t.submit({ seq: 1, text: 'good evening', endAudio: 2, speaker: 'R', source: 'en', targetLang: 'fr' });
  await sleep(80);
  check('chaque bloc est traduit dans SA direction', seen, ['fr>en', 'en>fr']);
}
{
  // Le contexte glissant est PAR locuteur et PAR direction : donner à Claude le
  // fil de l'autre voix comme s'il s'agissait de la même phrase la ferait
  // dériver, et un contexte français pour une phrase anglaise encore plus.
  const ctxSeen = [];
  const t = createTranslator({ ...cfg, CONTEXT_BLOCKS: 2, TRANSLATION_RETRIES: 0 }, {
    translate: async (text, context) => { ctxSeen.push(context.map((c) => c.source)); return 'T:' + text; },
    onResult: () => {},
  });
  const L = { speaker: 'L', source: 'fr', targetLang: 'en' };
  const R = { speaker: 'R', source: 'en', targetLang: 'fr' };
  t.submit({ seq: 0, text: 'a1', endAudio: 1, ...L });
  t.submit({ seq: 1, text: 'b1', endAudio: 2, ...R });
  t.submit({ seq: 2, text: 'a2', endAudio: 3, ...L });
  await sleep(120);
  check('chaque locuteur a son propre contexte', ctxSeen, [[], [], ['a1']]);
}
{
  // Fusion : jamais entre deux locuteurs. Coller deux voix dans un seul appel
  // produirait une phrase qui n'a jamais été dite, dans une seule colonne.
  const done = [];
  const t = createTranslator({ ...cfg, MAX_PENDING_BLOCKS: 1, TRANSLATION_RETRIES: 0 }, {
    translate: async (text) => { await sleep(20); return 'T:' + text; },
    onResult: (b) => done.push(b),
  });
  const L = { speaker: 'L', source: 'fr', targetLang: 'en' };
  const R = { speaker: 'R', source: 'en', targetLang: 'fr' };
  t.submit({ seq: 0, text: 'g1', endAudio: 1, ...L });
  t.submit({ seq: 1, text: 'g2', endAudio: 2, ...L });
  t.submit({ seq: 2, text: 'd1', endAudio: 3, ...R });
  t.submit({ seq: 3, text: 'd2', endAudio: 4, ...R });
  await sleep(300);
  const speakers = done.map((b) => b.speaker);
  const texts = done.map((b) => b.text);
  check('aucun bloc ne mélange deux locuteurs',
    texts.every((x) => !/g\d.*d\d|d\d.*g\d/.test(x)), true);
  check('chaque locuteur garde ses propres blocs', speakers.every((s) => s === 'L' || s === 'R'), true);
  check('tout finit par sortir', done.length > 0 && t.pending(), 0);
}

// ===========================================================================
console.log('\n--- Plancher de lisibilité (cadence d\'affichage) ---');
{
  const c = { MIN_WORD_GAP_MS: 45, MAX_REVEAL_CPS: 22 };
  // Un mot long doit rester à l'écran plus longtemps qu'un mot court.
  check('mot de 2 lettres → 136 ms', Math.round(readGapMs(2, c)), 136);
  check('mot de 12 lettres → 591 ms', Math.round(readGapMs(12, c)), 591);
  check('le plancher dur s\'applique quand même', Math.round(readGapMs(0, c)), 45);
  check('MAX_REVEAL_CPS=0 revient à l\'ancien comportement',
    readGapMs(20, { ...c, MAX_REVEAL_CPS: 0 }), 45);
}
{
  // Le cas réel : DEUX textes qui se recouvrent dans la même case (traduction
  // fusionnée, ou parole simultanée mal attribuée). Leurs dates se retrouvent
  // écrasées sur la même valeur, donc `gapMs` vaut 0 — et sans plancher tous les
  // mots sortaient à 45 ms d'intervalle, c'est-à-dire d'un bloc.
  const shown = [];
  let now = 0;
  const clock = { now: () => now };
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ at: now + (ms || 0), fn }); return timers.length; };
  globalThis.clearTimeout = (id) => { if (id) timers[id - 1] = null; };
  try {
    const c = { ...CONFIG, DISPLAY_DELAY_MS: 0, MAX_REVEAL_CPS: 22, MIN_WORD_GAP_MS: 45 };
    const st = createStage(c, {
      key: 'L:fr', getEpoch: () => 0, clock,
      onDisplay: (u) => shown.push({ t: now, text: u.text }),
    });
    // Huit mots datés IDENTIQUEMENT : le pire cas.
    st.enqueue('alors nous avons décidé de partir ensemble maintenant',
      { startAudio: 10, endAudio: 10 });
    // On avance le temps pas à pas en déclenchant les timers échus.
    for (let step = 0; step < 4000 && shown.length < 8; step += 10) {
      now = step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t && t.at <= now) { timers[i] = null; t.fn(); }
      }
    }
    let minGap = Infinity, violations = 0;
    for (let i = 1; i < shown.length; i++) {
      const gap = shown[i].t - shown[i - 1].t;
      minGap = Math.min(minGap, gap);
      if (gap < readGapMs(shown[i - 1].text.length, c) - 11) violations++;
    }
    check('les 8 mots superposés sortent quand même', shown.length, 8);
    check('aucun mot sous son temps de lecture', violations, 0);
    check('et pas au plancher dur de 45 ms', minGap > 100, true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

// ===========================================================================
console.log('\n--- Séparation stéréo (deux canaux ou un seul dupliqué ?) ---');
{
  // Signal de référence : deux sinusoïdes indépendantes, comme deux voix.
  const N = 48000;
  const two = new Int16Array(N * 2), same = new Int16Array(N * 2);
  for (let i = 0; i < N; i++) {
    const l = Math.sin(2 * Math.PI * 300 * i / 48000) * 0.3;
    const r = Math.sin(2 * Math.PI * 700 * i / 48000) * 0.3;
    two[i * 2] = l * 32767; two[i * 2 + 1] = r * 32767;
    same[i * 2] = l * 32767; same[i * 2 + 1] = l * 32767;
  }
  const a = analyseInterleaved(two, CONFIG);
  const b = analyseInterleaved(same, CONFIG);
  check('deux signaux → corrélation quasi nulle', Math.abs(a.corr) < 0.05, true);
  check('deux signaux → des échantillons diffèrent', a.maxDiff > 0.1, true);
  check('canal dupliqué → corrélation 1', Math.round(b.corr * 1000) / 1000, 1);
  check('canal dupliqué → écart max nul', b.maxDiff, 0);
  check('canal dupliqué → 100 % d\'échantillons égaux', b.identicalRatio, 1);
}
{
  // Le cas RÉEL de la scène : deux micros qui captent chacun les deux voix.
  // La diaphonie corrèle les canaux — le contrôle ne doit PAS crier au mono.
  const N = 48000;
  const pcm = new Int16Array(N * 2);
  for (let i = 0; i < N; i++) {
    const a = Math.sin(2 * Math.PI * 300 * i / 48000) * 0.3;
    const b = Math.sin(2 * Math.PI * 700 * i / 48000) * 0.3;
    pcm[i * 2] = (a * 0.95 + b * 0.35) * 32767;
    pcm[i * 2 + 1] = (b * 0.95 + a * 0.35) * 32767;
  }
  const r = analyseInterleaved(pcm, CONFIG).corr;
  check('diaphonie 35 % reste sous le seuil « identiques »',
    r < CONFIG.STEREO_IDENTICAL_CORR, true);
  check('… et sous le seuil « suspect »', r < CONFIG.STEREO_SUSPECT_CORR, true);
}
{
  // Le cumulateur temps réel, alimenté comme le worklet le fait.
  const chunk = (rmsL, rmsR, ll, rr, lr, md) =>
    ({ frames: 1920, rmsL, rmsR, sumLL: ll, sumRR: rr, sumLR: lr, maxDiff: md });
  const s = createStereoCheck({ ...CONFIG, STEREO_VERDICT_S: 1, CAPTURE_RATE: 48000 });
  check('sans signal : pas de verdict', s.verdict(2).state, 'waiting');
  // Du silence, même beaucoup, ne doit jamais conclure : deux silences sont
  // parfaitement corrélés et ne prouvent rien.
  for (let i = 0; i < 100; i++) s.push(chunk(1e-5, 1e-5, 1e-9, 1e-9, 1e-9, 0));
  check('le silence est écarté, pas compté', s.verdict(2).state, 'waiting');
  // Puis du vrai signal, décorrélé.
  for (let i = 0; i < 40; i++) s.push(chunk(0.2, 0.2, 80, 80, 1, 0.4));
  check('du signal décorrélé → stéréo OK', s.verdict(2).state, 'ok');
  check('une entrée mono est signalée comme telle', s.verdict(1).state, 'mono');

  const dup = createStereoCheck({ ...CONFIG, STEREO_VERDICT_S: 1, CAPTURE_RATE: 48000 });
  for (let i = 0; i < 40; i++) dup.push(chunk(0.2, 0.2, 80, 80, 80, 0));
  check('canaux identiques → « duplicated »', dup.verdict(2).state, 'duplicated');
  dup.reset();
  check('reset repart de zéro', dup.verdict(2).state, 'waiting');
}

// ===========================================================================
//  Le VRAI worklet, exécuté hors du navigateur.
//
//  `pcm-worklet.js` est le seul fichier que le harnais ne peut pas rejouer : il
//  ne tourne que dans un AudioWorklet. Or c'est lui qui produit les sommes
//  croisées dont dépend tout le contrôle stéréo — une erreur de signe ou un
//  cumul oublié passerait inaperçu jusqu'à la scène. On lui fabrique donc les
//  deux globales dont il a besoin et on lui pousse de l'audio.
console.log('\n--- Le worklet PCM lui-même (sommes croisées) ---');
{
  const captured = {};
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } };
  globalThis.registerProcessor = (name, cls) => { captured[name] = cls; };
  await import(join(ROOT, 'pcm-worklet.js'));
  check('le worklet s\'enregistre bien', typeof captured['pcm-chunker'], 'function');

  /** Fait tourner le worklet sur deux canaux et renvoie ses paquets. */
  const run = (fillL, fillR) => {
    const msgs = [];
    const node = new captured['pcm-chunker']({
      processorOptions: { sampleRate: 48000, chunkMs: 40, channelL: 0, channelR: 1, stereo: true },
    });
    node.port.postMessage = (m) => msgs.push(m);
    const N = 128;
    for (let blk = 0; blk < 400; blk++) {
      const L = new Float32Array(N), R = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const t = (blk * N + i) / 48000;
        L[i] = fillL(t);
        R[i] = fillR(t);
      }
      node.process([[L, R]]);
    }
    return msgs;
  };

  const sine = (f) => (t) => Math.sin(2 * Math.PI * f * t) * 0.3;
  const feed = (msgs, cfgIn) => {
    const s = createStereoCheck({ ...CONFIG, ...cfgIn, STEREO_VERDICT_S: 0.5, CAPTURE_RATE: 48000 });
    for (const m of msgs) s.push(m);
    return s;
  };

  const distinct = run(sine(300), sine(700));
  check('le worklet produit des paquets datés', distinct.length > 5, true);
  check('chaque paquet porte ses sommes croisées',
    distinct.every((m) => typeof m.sumLL === 'number' && typeof m.sumRR === 'number'
                       && typeof m.sumLR === 'number' && typeof m.maxDiff === 'number'), true);
  check('deux voix distinctes → verdict « stéréo OK »', feed(distinct).verdict(2).state, 'ok');

  // Le cas de la panne : le même signal sur les deux canaux.
  const dup = run(sine(300), sine(300));
  check('canal dupliqué → verdict « duplicated »', feed(dup).verdict(2).state, 'duplicated');
  check('canal dupliqué → écart max exactement nul', feed(dup).maxDiff(), 0);

  // Le worklet en mode UN micro : chL et chR pointent sur le même canal. Le
  // contrôle doit dire « mono », pas « duplicated » — ce n'est pas une panne.
  const mono = run(sine(300), sine(300));
  check('un seul locuteur : « mono », pas une panne', feed(mono).verdict(1).state, 'mono');

  delete globalThis.sampleRate;
  delete globalThis.AudioWorkletProcessor;
  delete globalThis.registerProcessor;
}

// ===========================================================================
console.log('\n--- Lexique du spectacle (noms propres) ---');
{
  const p = buildSystemPrompt('fr', 'en', ['Captivea', 'Odoo']);
  check('les mots sont dans le prompt', /Captivea, Odoo/.test(p), true);
  check('avec la consigne de ne pas les traduire', /TELS QUELS/.test(p), true);
  const empty = buildSystemPrompt('fr', 'en', []);
  check('lexique vide : aucune ligne ajoutée', /TELS QUELS/.test(empty), false);
  check('lexique vide : le prompt reste celui d\'avant',
    empty, buildSystemPrompt('fr', 'en'));
}
{
  // Le lexique doit descendre jusqu'à l'appel réseau : c'est le seul endroit
  // où il agit, et le seul câblage facile à casser sans que rien ne le montre.
  let seen = null;
  const t = createTranslator({ ...cfg, VOCABULARY: ['Riss'] }, {
    translate: async (text, ctx, ms, opts) => { seen = opts; return 'T'; },
    onResult: () => {},
  });
  t.submit({ seq: 0, text: 'bonjour', source: 'fr', targetLang: 'en', speaker: 'L' });
  await sleep(30);
  check('le lexique atteint la fonction de traduction', seen?.vocabulary, ['Riss']);
}

// ===========================================================================
console.log('\n--- Mode fichier (les .txt relus par OBS) ---');
{
  // Le fichier n'est pas un flux : il doit contenir, à chaque instant, ce qui
  // est à l'écran — donc les lignes se mettent à jour SUR PLACE quand elles
  // s'allongent, elles ne s'empilent pas.
  const c = createCaptionBuffer({ LANGUAGES: ['fr', 'en'], CAPTION_MAX_LINES: 2 });
  const fr = createFeed({ MAX_CHARS_PER_LINE: 20, MAX_LINES: 4 });
  const u = { key: 'L:fr', meta: { lang: 'fr', speaker: 'L' } };
  c.push(u, fr.append('Bonsoir'));
  check('un mot : le fichier le porte', c.texts().fr, 'Bonsoir');
  c.push(u, fr.append('à toutes'));
  check('la ligne s\'allonge, elle ne se duplique pas', c.texts().fr, 'Bonsoir à toutes');
  check('l\'autre langue reste vide', c.texts().en, '');
}
{
  // Deux locuteurs, une seule piste par langue : l'ordre est celui de la
  // parole, et une reprise ne fait pas sauter la ligne de l'autre.
  const c = createCaptionBuffer({ LANGUAGES: ['fr', 'en'], CAPTION_MAX_LINES: 3 });
  const l = createFeed({ MAX_CHARS_PER_LINE: 40, MAX_LINES: 4 });
  const r = createFeed({ MAX_CHARS_PER_LINE: 40, MAX_LINES: 4 });
  const uL = { key: 'L:fr', meta: { lang: 'fr' } }, uR = { key: 'R:fr', meta: { lang: 'fr' } };
  c.push(uL, l.append('je disais'));
  c.push(uR, r.append('oui'));
  c.push(uL, l.append('donc'));
  check('les deux locuteurs se suivent dans l\'ordre de parole',
    c.texts().fr, 'je disais donc\noui');
}
{
  // Plafond : un surtitre incrusté qui grandirait sans fin mangerait l'image.
  const c = createCaptionBuffer({ LANGUAGES: ['fr'], CAPTION_MAX_LINES: 2 });
  const f = createFeed({ MAX_CHARS_PER_LINE: 6, MAX_LINES: 4 });
  const u = { key: 'L:fr', meta: { lang: 'fr' } };
  for (const w of ['aaaa', 'bbbb', 'cccc', 'dddd']) c.push(u, f.append(w));
  check('deux lignes au plus, les plus récentes', c.texts().fr, 'cccc\ndddd');
  check('blank() vide tous les fichiers', c.blank(), { fr: '' });
  c.clear();
  check('clear() aussi', c.texts(), { fr: '' });
}
{
  // Une langue inconnue ne doit pas créer de fichier fantôme.
  const c = createCaptionBuffer({ LANGUAGES: ['fr', 'en'] });
  const f = createFeed({ MAX_CHARS_PER_LINE: 40, MAX_LINES: 4 });
  c.push({ key: 'L:de', meta: { lang: 'de' } }, f.append('Guten Abend'));
  check('langue hors config : ignorée', c.texts(), { fr: '', en: '' });
}

console.log(`\n================  ${pass} réussis, ${fail} échoués  ================`);
process.exit(fail ? 1 : 0);
