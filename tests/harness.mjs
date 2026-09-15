// ---------------------------------------------------------------------------
//  Harnais de test hors-ligne (§7).
//
//  Impossible de régler les seuils en répétant avec un micro : il faut pouvoir
//  rejouer le MÊME audio en boucle et comparer deux configs.
//
//  Trois modes :
//    --simulate                  flux de partials synthétique, sans réseau ni quota
//    --record <fichier.wav>      streame un WAV réel vers Gladia → fixture JSONL
//    --replay <fixture.jsonl>    rejoue une fixture dans le pipeline
//
//  Le flux simulé comporte DEUX locuteurs (canaux 0 et 1) qui parlent tantôt
//  français tantôt anglais, y compris un changement de langue en cours de
//  spectacle. L'attribution des locuteurs passe par le VRAI tracker d'énergie
//  (src/speakers.js), alimenté en énergies synthétiques : c'est le même code
//  qu'en direct, avec la même diaphonie entre les deux micros.
//
//  Le rejeu se fait en temps réel simulé 1× : la cadence d'affichage repose sur
//  de vrais timers et sur l'horloge audio, accélérer la fausserait.
// ---------------------------------------------------------------------------
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CONFIG } = await import(join(ROOT, 'config/surtitles.js'));
const { createPipeline } = await import(join(ROOT, 'src/pipeline.js'));
const { createTranslator, httpTranslate } = await import(join(ROOT, 'src/translator.js'));
const { createFeed } = await import(join(ROOT, 'src/feed.js'));
const { createSpeakerTracker } = await import(join(ROOT, 'src/speakers.js'));

// --- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const cfg = { ...CONFIG };
if (opt('--agreement')) cfg.AGREEMENT_N = Number(opt('--agreement'));
if (opt('--min-words')) cfg.MIN_WORDS = Number(opt('--min-words'));
if (opt('--max-words')) cfg.MAX_WORDS = Number(opt('--max-words'));
if (opt('--idle')) cfg.IDLE_FLUSH_MS = Number(opt('--idle'));
if (opt('--max-age')) cfg.MAX_BLOCK_AGE_MS = Number(opt('--max-age'));
if (opt('--engine')) cfg.TRANSLATION_ENGINE = opt('--engine');
// Le retard suit le moteur, comme dans la régie : chaque moteur a son plancher.
cfg.DISPLAY_DELAY_MS = cfg.DISPLAY_DELAY_BY_ENGINE?.[cfg.TRANSLATION_ENGINE]
  ?? cfg.DISPLAY_DELAY_MS;
if (opt('--delay')) cfg.DISPLAY_DELAY_MS = Number(opt('--delay'));
if (opt('--catch-up')) cfg.CATCH_UP_RATE = Number(opt('--catch-up'));
if (opt('--bleed')) cfg.__BLEED = Number(opt('--bleed'));
if (opt('--ratio')) cfg.SPEAKER_MIN_RATIO = Number(opt('--ratio'));
if (flag('--one-speaker')) cfg.TWO_SPEAKERS = false;
if (opt('--reveal-cps')) cfg.MAX_REVEAL_CPS = Number(opt('--reveal-cps'));
const GLADIA_MODE = cfg.TRANSLATION_ENGINE === 'gladia';
const VERBOSE = flag('--verbose');
// Longues phrases, un seul locuteur : le cas où l'affichage part en rattrapage.
const MONO_MODE = flag('--monologue');
if (MONO_MODE) cfg.TWO_SPEAKERS = false;
// Médiane du traducteur simulé, en ms. Défaut = la médiane mesurée sur Haiku.
const STUB_LAG = Number(opt('--stub-lag', 870));

// --- dialogue source de la simulation --------------------------------------
// Deux locuteurs, deux langues, un changement de langue en cours de route (le
// locuteur G passe à l'anglais) : c'est exactement le cas que le système doit
// tenir, et le seul qui exerce le code-switching et la traduction inversée.
const DIALOGUE = [
  { sp: 'L', lang: 'fr', text: "Bonsoir à toutes et à tous, merci d'être venus ce soir.",
    tr: "Good evening everyone, thank you for coming tonight." },
  { sp: 'R', lang: 'en', text: "We started this show almost two years ago, and it has changed a lot since then.",
    tr: "On a commencé ce spectacle il y a presque deux ans, et il a beaucoup changé depuis." },
  { sp: 'L', lang: 'fr', text: "Au départ c'était une histoire de famille, mais très vite c'est devenu autre chose.",
    tr: "At first it was a family story, but very quickly it became something else." },
  { sp: 'R', lang: 'en', text: "I think what interests us is the question of memory.",
    tr: "Je crois que ce qui nous intéresse, c'est la question de la mémoire." },
  { sp: 'L', lang: 'en', text: "What do we keep, what do we let go, and who decides?",
    tr: "Qu'est-ce qu'on garde, qu'est-ce qu'on laisse partir, et qui décide ?" },
  { sp: 'R', lang: 'fr', text: "On a travaillé avec des archives, des enregistrements, des lettres.",
    tr: "We worked with archives, recordings, letters." },
  { sp: 'L', lang: 'fr', text: "Certaines choses que vous allez entendre sont vraies, d'autres pas du tout.",
    tr: "Some of the things you are about to hear are true, others not at all." },
  { sp: 'R', lang: 'en', text: "And I will not tell you which ones.",
    tr: "Et je ne vous dirai pas lesquelles." },
];

// Les deux locuteurs PARLENT EN MÊME TEMPS. Deux micros séparés, donc deux
// énoncés qui se recouvrent dans le temps. L'affichage doit rester correct :
// quatre files indépendantes, chacune à sa cadence, aucune ne bloque l'autre.
//
// L'ATTRIBUTION, elle, ne peut pas être parfaite : une seule session Gladia est
// autorisée, donc les deux voix arrivent mélangées dans un seul canal mono et
// l'énergie des deux micros est simultanément forte. Le harnais mesure les deux
// régimes SÉPARÉMENT plutôt que de faire semblant.
const OVERLAP = [
  { sp: 'L', lang: 'fr', text: "attends, je voulais dire quelque chose là-dessus",
    tr: "wait, I wanted to say something about that" },
  { sp: 'R', lang: 'en', text: "no but that is exactly my point",
    tr: "non mais c'est exactement ce que je dis" },
];

// PRNG déterministe : deux runs sur la même config sont comparables.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const WPS = 2.6;                 // mots par seconde (débit scène)

// ---------------------------------------------------------------------------
//  Monologue de LONGUES phrases, un seul locuteur.
//
//  C'est le cas que le dialogue ci-dessus n'exerçait pas : des phrases de 25 à
//  40 mots sans respiration, donc découpées de force par Gladia toutes les 5 s,
//  donc traduites par blocs qui s'empilent — c'est là que l'affichage part en
//  rattrapage et que le défaut « le texte s'affiche d'un coup » se produit.
//  `--monologue` remplace le dialogue par celui-ci.
// ---------------------------------------------------------------------------
const MONOLOGUE = [
  { sp: 'L', lang: 'fr',
    text: "Ce que je voudrais vous raconter ce soir c'est une histoire qui commence il y a très longtemps, dans une maison qui n'existe plus, avec des gens dont je n'ai jamais vu les visages autrement que sur des photographies abîmées.",
    tr: "What I would like to tell you tonight is a story that begins a very long time ago, in a house that no longer exists, with people whose faces I have only ever seen in damaged photographs." },
  { sp: 'L', lang: 'fr',
    text: "Ma grand-mère gardait tout dans une boîte en fer, les lettres et les tickets et les faire-part, et quand elle est morte on a trouvé la boîte et personne n'a su quoi en faire pendant presque dix ans.",
    tr: "My grandmother kept everything in a tin box, the letters and the tickets and the announcements, and when she died we found the box and nobody knew what to do with it for almost ten years." },
  { sp: 'L', lang: 'fr',
    text: "Alors j'ai commencé à lire, et plus je lisais plus je comprenais que ce que ma famille racontait depuis toujours et ce qui était écrit sur ces papiers-là n'étaient pas du tout la même histoire.",
    tr: "So I started reading, and the more I read the more I understood that what my family had always told and what was written on those papers were not at all the same story." },
  { sp: 'L', lang: 'fr',
    text: "Et je ne vous dirai pas laquelle des deux est vraie, parce que je n'en sais rien, et parce qu'à un moment il faut accepter de vivre avec des trous.",
    tr: "And I will not tell you which of the two is true, because I do not know, and because at some point you have to accept living with holes." },
];

/**
 * Découpe le dialogue en UTTERANCES, pas en phrases.
 *
 * Gladia coupe de force à `maximum_duration_without_endpointing` (5 s, plancher
 * dur de l'API) même sans silence. Une phrase de 20 mots arrive donc en deux
 * utterances, pas en une. Sans le simuler, le harnais mesurait un retard
 * structurel que le direct ne produit pas.
 */
function splitUtterances(source = DIALOGUE) {
  const maxWords = Math.max(1, Math.floor(cfg.MAX_DURATION_WITHOUT_ENDPOINTING * WPS));
  const out = [];
  for (const turn of source) {
    const src = turn.text.split(/\s+/);
    const tgt = turn.tr.split(/\s+/);
    const parts = Math.ceil(src.length / maxWords);
    const srcPer = Math.ceil(src.length / parts), tgtPer = Math.ceil(tgt.length / parts);
    for (let p = 0; p < parts; p++) {
      out.push({
        sp: cfg.TWO_SPEAKERS ? turn.sp : 'L',
        lang: turn.lang,
        words: src.slice(p * srcPer, (p + 1) * srcPer),
        tr: tgt.slice(p * tgtPer, (p + 1) * tgtPer).join(' '),
        // Une coupe forcée n'est pas une fin de tour : pas de respiration.
        breathAfter: p === parts - 1,
      });
    }
  }
  return out;
}

/**
 * Fabrique un flux de messages Gladia plausible : partials qui s'allongent mot
 * à mot, avec révision occasionnelle de la queue (c'est précisément ce que
 * LocalAgreement doit absorber), puis un final par utterance.
 *
 * Renvoie aussi la VÉRITÉ (qui parlait quand) et les énergies à injecter dans le
 * tracker de locuteurs.
 */
function simulateMessages() {
  const rand = rng();
  const msgs = [];
  const truth = [];
  const energy = [];
  const ASR_LAG = Number(opt('--asr-lag', 450)) / 1000;
  const GLADIA_TRANSLATE_MS = Number(opt('--gladia-lag', 600));
  // Diaphonie : chaque micro capte AUSSI l'autre voix. C'est la difficulté
  // réelle de l'attribution — 0.35 = l'autre voix à -9 dB, plausible en scène.
  const BLEED = cfg.__BLEED ?? 0.35;

  /**
   * Émet une utterance qui démarre à `startT`. Retourne sa fin, en secondes
   * d'audio. `overlap` marque la vérité comme « parole simultanée » : ces mots
   * sont comptés à part, l'attribution ne pouvant pas y être fiable.
   */
  function emit(utt, startT, overlap = false) {
    const words = utt.words;
    const text = words.join(' ');
    const timed = words.map(() => ({ word: '', start: 0, end: 0 }));
    const other = utt.lang === 'fr' ? 'en' : 'fr';

    // Durée de CHAQUE mot, et pas la durée moyenne partout.
    //
    // C'est indispensable pour mesurer la cadence d'affichage : les vrais timings
    // de Gladia sont très irréguliers — « il y a un » tient dans 400 ms, un mot
    // de douze lettres en prend presque une seconde. Un débit uniforme (1/WPS
    // partout) faisait croire à une révélation lisse et cachait exactement le
    // défaut qu'on corrige. On étale donc au prorata de la longueur, plus un peu
    // de bruit, en normalisant pour garder le même débit moyen qu'avant.
    const raw = words.map((w) => (w.length + 1) * (0.85 + 0.3 * rand()));
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
    const dur = raw.map((r) => r / mean / WPS);
    const off = [0];
    for (let i = 0; i < dur.length; i++) off.push(off[i] + dur[i]);
    let t = startT;

    for (let n = 1; n <= words.length; n++) {
      t = startT + off[n];
      for (let i = 0; i < n; i++) {
        timed[i].word = words[i];
        timed[i].start = startT + off[i];
        timed[i].end = startT + off[i + 1];
      }
      const shown = timed.slice(0, n).map((w) => ({ ...w }));
      if (n < words.length && rand() < 0.55) {
        const last = shown[shown.length - 1];
        last.word = last.word.slice(0, Math.max(2, last.word.length - 2)) + 'e';
      }
      msgs.push({
        at: (t + ASR_LAG) * 1000,
        msg: { type: 'transcript', data: { is_final: false,
               utterance: { text: shown.map((w) => w.word).join(' '), language: utt.lang,
                            start: startT, end: t, words: shown } } },
      });
    }
    const endT = t;

    msgs.push({
      at: (endT + 0.25 + ASR_LAG) * 1000,
      msg: { type: 'transcript', data: { is_final: true,
             utterance: { text, language: utt.lang, start: startT, end: endT, words: timed } } },
    });

    // Moteur 'gladia' : la traduction arrive APRÈS le final, pour l'utterance
    // entière. Avec DEUX langues cibles, Gladia renvoie aussi l'identité
    // (fr → fr) : on l'émet pour vérifier que le pipeline la filtre.
    if (GLADIA_MODE) {
      const baseAt = (endT + 0.25 + ASR_LAG) * 1000 + GLADIA_TRANSLATE_MS;
      msgs.push({
        at: baseAt,
        msg: { type: 'translation', data: {
          utterance: { text, language: utt.lang, start: startT, end: endT },
          original_language: utt.lang, target_language: other,
          translated_utterance: { text: utt.tr, language: other, start: startT, end: endT },
        } },
      });
      msgs.push({
        at: baseAt + 20,
        msg: { type: 'translation', data: {
          utterance: { text, language: utt.lang, start: startT, end: endT },
          original_language: utt.lang, target_language: utt.lang,
          translated_utterance: { text, language: utt.lang, start: startT, end: endT },
        } },
      });
    }

    truth.push({ from: startT, to: endT, sp: utt.sp, lang: utt.lang, overlap });
    // Énergie par paquets de CHUNK_MS sur toute la durée de l'énoncé. En parole
    // simultanée les deux canaux sont forts : c'est ce qui rend l'attribution
    // structurellement indécise, et c'est voulu qu'on le voie.
    const step = cfg.CHUNK_MS / 1000;
    for (let x = startT; x < endT; x += step) {
      const strong = 0.25, weak = 0.25 * BLEED;
      energy.push({ tStart: x, tEnd: Math.min(x + step, endT),
                    rmsL: utt.sp === 'L' ? strong : weak,
                    rmsR: utt.sp === 'R' ? strong : weak });
    }
    return endT;
  }

  let audioT = 0.4;              // secondes d'audio écoulées
  for (const utt of splitUtterances(MONO_MODE ? MONOLOGUE : DIALOGUE)) {
    audioT = emit(utt, audioT);
    audioT += utt.breathAfter ? 0.25 + 0.5 + rand() * 0.8 : 0.05;
  }

  // Passage en parole SIMULTANÉE : les deux démarrent au même instant.
  if (!flag('--no-overlap') && cfg.TWO_SPEAKERS && !MONO_MODE) {
    const startT = audioT + 0.6;
    let end = startT;
    for (const turn of OVERLAP) {
      end = Math.max(end, emit({ ...turn, words: turn.text.split(/\s+/) }, startT, true));
    }
    audioT = end + 0.8;
  }

  return { msgs, truth, energy };
}

// --- traducteur ------------------------------------------------------------
/**
 * Modélise Haiku SANS réseau ni quota — mais avec sa DISPERSION, pas sa médiane.
 *
 * Un stub à délai constant est trompeur : c'est la queue de la distribution qui
 * fait s'empiler les blocs, déclenche la fusion et met l'affichage en
 * rattrapage. Mesuré sur l'API réelle (20 appels, bloc de 11 mots) :
 *   min 0,65 s · médiane 0,87 s · p90 1,45 s · max 2,97 s
 * On reproduit ça par une log-normale bornée, tirée du PRNG déterministe : deux
 * exécutions sur la même config restent comparables.
 */
function stubTranslate(medianMs = 870) {
  const rand = rng(7);
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    // Box-Muller. u > 0 : log(0) = -∞.
    const u = Math.max(1e-9, rand()), v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return async (text, context, timeoutMs, { target = 'en' } = {}) => {
    // σ = 0,45 en log donne p90 ≈ 1,55 × médiane, comme la mesure réelle.
    const d = Math.min(3000, Math.max(650, medianMs * Math.exp(0.45 * gauss())));
    await new Promise((r) => setTimeout(r, d));
    return `[${target}] ` + text;
  };
}

// --- exécution -------------------------------------------------------------
async function run({ messages, truth = [], energy = [] }, { logPath, live }) {
  const events = [];
  const displayed = [];
  const t0 = Date.now();

  // Le VRAI tracker : même code qu'en direct. On lui pousse les énergies au fur
  // et à mesure, à leur date audio, pour qu'il ne sache jamais l'avenir.
  const tracker = createSpeakerTracker(cfg);
  let energyIdx = 0;
  const feedEnergyUpTo = (audioSeconds) => {
    while (energyIdx < energy.length && energy[energyIdx].tStart <= audioSeconds) {
      tracker.push(energy[energyIdx++]);
    }
  };

  const translator = GLADIA_MODE ? null : createTranslator(cfg, {
    translate: live
      ? httpTranslate(`http://127.0.0.1:${await port()}/api/translate`)
      : stubTranslate(STUB_LAG),
    onResult: (b) => pipeline.onTranslated(b),
    onError: (b, e) => events.push({ t: Date.now(), type: 'translation_failed',
                                     seq: b.seq, error: String(e?.message).slice(0, 120) }),
  });

  let feeds = new Map();
  const vLine = new Map();
  const pipeline = createPipeline(cfg, {
    translator,
    speakerOf: (a, b) => tracker.speakerOf(a, b),
    // Un mot à la fois. En --verbose le terminal reproduit ce que fait l'écran :
    // chaque colonne s'écrit progressivement, au rythme de la parole.
    onDisplay: (u) => {
      const feed = feeds.get(u.key);
      if (!feed) return;
      const lines = feed.append(u.text, { breakBefore: u.breakBefore });
      const line = lines[lines.length - 1];
      displayed.push({ at: Date.now() - t0, latency: u.latency, batch: u.batch,
                       key: u.key, audioAt: u.audioAt, meta: u.meta });
      if (VERBOSE) {
        if (vLine.get(u.key) !== line.id) {
          vLine.set(u.key, line.id);
          const tag = `${u.key.padEnd(5)}`;
          process.stdout.write(`\n  [${String(Math.round((Date.now() - t0) / 100) / 10).padStart(5)}s] `
            + `${u.latency != null ? String(Math.round(u.latency)).padStart(5) + 'ms' : '  —  '} ${tag}│ `);
        }
        process.stdout.write(u.text + ' ');
      }
    },
    onEvent: (e) => events.push(e),
  });
  feeds = new Map(pipeline.stageKeys.map((k) => [k, createFeed(cfg)]));

  pipeline.startAudioClock(t0);
  const ticker = setInterval(() => {
    feedEnergyUpTo((Date.now() - t0) / 1000);
    pipeline.tick();
  }, 100);

  // Rejeu en temps réel : chaque message part à son horodatage audio.
  await new Promise((done) => {
    let i = 0;
    const step = () => {
      if (i >= messages.length) {
        // On laisse la file de traduction ET le retard d'affichage se vider :
        // à la fin du flux, DISPLAY_DELAY_MS de mots sont encore en file.
        setTimeout(done, cfg.DISPLAY_DELAY_MS + 3000);
        return;
      }
      const { at, msg } = messages[i++];
      const wait = Math.max(0, at - (Date.now() - t0));
      setTimeout(() => {
        feedEnergyUpTo((Date.now() - t0) / 1000);
        pipeline.onGladiaMessage(msg);
        step();
      }, wait);
    };
    step();
  });

  clearInterval(ticker);
  if (VERBOSE) process.stdout.write('\n');

  // --- rapport -------------------------------------------------------------
  const m = pipeline.metrics();
  // Fluidité : ce sont les intervalles entre deux mots DU MÊME FLUX et du même
  // segment qui comptent. Entre deux segments, un long intervalle est une
  // respiration du comédien ; entre deux colonnes, il n'a aucun sens.
  const intraGaps = [];
  const lastOf = new Map();
  for (const d of displayed) {
    const prev = lastOf.get(d.key);
    if (prev && prev.batch === d.batch) intraGaps.push(d.at - prev.at);
    lastOf.set(d.key, d);
  }
  const sortedIntra = intraGaps.slice().sort((a, b) => a - b);
  const p95Intra = sortedIntra.length
    ? sortedIntra[Math.min(sortedIntra.length - 1, Math.ceil(0.95 * sortedIntra.length) - 1)] : null;
  const burstRate = displayed.length ? m.burstWords / displayed.length : 0;

  // Attribution : chaque mot affiché est-il dans la bonne ligne ? On compare au
  // locuteur qui parlait réellement à la date audio de ce mot.
  //
  // La parole SIMULTANÉE est comptée à part : avec une seule session ASR, les
  // deux voix arrivent mélangées et l'énergie des deux micros est forte en même
  // temps. On mesure les deux régimes séparément au lieu de faire semblant.
  const at = (t) => truth.filter((r) => t >= r.from - 0.01 && t <= r.to + 0.01);
  let attributed = 0, misattributed = 0, ovWords = 0, ovMis = 0;
  for (const d of displayed) {
    if (d.audioAt == null) continue;
    const rs = at(d.audioAt);
    if (rs.length === 0) continue;
    const sp = d.key.split(':')[0];
    if (rs.length > 1 || rs[0].overlap) {
      ovWords++;
      // En simultané, « juste » = le mot est chez l'un des deux locuteurs qui
      // parlaient vraiment. Aucun n'est faux dans l'absolu.
      if (!rs.some((r) => r.sp === sp)) ovMis++;
      continue;
    }
    attributed++;
    if (sp !== rs[0].sp) misattributed++;
  }
  const misRate = attributed ? misattributed / attributed : 0;

  // Les quatre cases (locuteur × langue) doivent avoir reçu du texte, sinon une
  // case reste muette.
  const emptyStreams = pipeline.stageKeys.filter((k) => (m.perStage[k]?.words ?? 0) === 0);

  // PLACE FIXE : une case ne doit contenir QUE sa langue. C'est l'invariant de
  // la grille — si un mot anglais atterrit dans la colonne française, le
  // spectateur ne sait plus où regarder.
  const wrongLang = displayed.filter((d) =>
    d.meta?.lang && d.key.split(':')[1] !== String(d.meta.lang).toLowerCase().slice(0, 2));

  // Un trou ne compte que « pendant une parole continue » : on ne retient que
  // les intervalles durant lesquels des mots ont effectivement été validés.
  const commits = events.filter((e) => e.type === 'words_committed' || e.type === 'partial');
  const speechGaps = [];
  for (let i = 1; i < displayed.length; i++) {
    const a = t0 + displayed[i - 1].at, b = t0 + displayed[i].at;
    if (commits.some((c) => c.t > a && c.t <= b)) speechGaps.push(b - a);
  }
  const maxGap = speechGaps.length ? Math.max(...speechGaps) : 0;

  const target = cfg.DISPLAY_DELAY_MS;
  console.log('\n================ CRITÈRES D\'ACCEPTATION (§9) ================');
  const rows = [
    ['1. Zéro mutation (structure append-only)',
      [...feeds.values()].every((f) => f.emitted().every((w) => Object.isFrozen(w))), true],
    ['2. Retard médian conforme à la cible (±500 ms)',
      m.latencyMedian != null && Math.abs(m.latencyMedian - target) <= 500,
      `${m.latencyMedian != null ? Math.round(m.latencyMedian) : '—'} ms pour ${target} ms visés`],
    ['2b. Retard p95 < cible + 1,5 s',
      m.latencyP95 != null && m.latencyP95 < target + 1500,
      `${m.latencyP95 != null ? Math.round(m.latencyP95) : '—'} ms`],
    ['2c. Retard au DÉBUT d\'un segment',
      m.latencyStartMedian == null || m.latencyStartMedian <= target + 1500,
      `${m.latencyStartMedian != null ? 'méd. ' + Math.round(m.latencyStartMedian)
         + ' ms / p95 ' + Math.round(m.latencyStartP95) : '—'} ms`],
    ['3. Révélation fluide (p95 entre 2 mots < 900 ms)',
      p95Intra != null && p95Intra < 900, `p95 ${p95Intra ?? '—'} ms`],
    ['3b. Pas de rafale (< 10 % des mots au plancher dur)',
      burstRate < 0.10, `${(burstRate * 100).toFixed(1)} % (${m.burstWords} mots)`],
    // Le critère qui compte vraiment pour la lisibilité : aucun mot ne doit
    // sortir plus vite que MAX_REVEAL_CPS ne l'autorise, même en rattrapage.
    ['3c. Plancher de lisibilité respecté (' + (cfg.MAX_REVEAL_CPS || '—') + ' car/s)',
      m.tooFastWords === 0, `${m.tooFastWords} mot(s) trop rapide(s)`],
    ['4. Aucun trou > 4 s en parole continue',
      maxGap <= 4000, `max ${Math.round(maxGap)} ms`],
    ['5. Taux de divergence validé/final loggé',
      true, m.divergenceRate == null ? 'sans objet (moteur Gladia)'
        : `${(m.divergenceRate * 100).toFixed(1)} %`],
    ['6. Bon locuteur (< 2 % de mots mal attribués)',
      misRate < 0.02, `${(misRate * 100).toFixed(1)} % (${misattributed}/${attributed})`
        + ' hors parole simultanée'],
    ['7. Les quatre cases locuteur × langue alimentées',
      emptyStreams.length === 0,
      emptyStreams.length ? 'cases muettes : ' + emptyStreams.join(', ')
        : `les ${pipeline.stageKeys.length} cases alimentées`],
    ['8. Place FIXE : chaque case ne reçoit que sa langue',
      wrongLang.length === 0,
      wrongLang.length ? `${wrongLang.length} mot(s) dans la mauvaise colonne`
        : `${displayed.length} mots, aucun hors de sa colonne`],
    ['9. Parole simultanée : texte préservé pour les deux',
      ovWords === 0 || ovMis / ovWords < 0.5,
      ovWords === 0 ? 'sans objet'
        : `${ovWords} mots en simultané, ${ovMis} chez personne`],
  ];
  for (const [label, ok, detail] of rows) {
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(48)} ${detail === true ? '' : detail}`);
  }

  // Le harnais sert à TROUVER le bon retard, pas seulement à le juger : si le
  // retard réel dépasse durablement la cible, c'est que la cible est sous le
  // plancher du moteur (durée d'utterance + temps de traduction).
  if (m.latencyMedian != null && m.latencyMedian > target + 400) {
    console.log(`\n  ⚠ retard visé trop court pour ce moteur : ${m.lateWords} mot(s) en `
      + `rattrapage.\n    Essayer DISPLAY_DELAY_MS = ${Math.ceil(m.latencyMedian / 250) * 250}.`);
  }

  console.log('\n  moteur             :', m.engine === 'gladia'
    ? 'GLADIA (traduction en fin de phrase)' : 'CLAUDE (traduction par bloc)');
  console.log('  mots affichés      :', m.wordsDisplayed, '| segments :', m.utterances,
              '| retard visé :', target, 'ms');
  console.log('  en rattrapage      :', m.lateWords, 'mot(s) au-delà de +500 ms',
              m.maxLateness != null ? `| pire écart ${Math.round(m.maxLateness)} ms` : '');
  console.log('  par flux           :', pipeline.stageKeys
    .map((k) => `${k}=${m.perStage[k]?.words ?? 0}`).join('  '));
  console.log('  attribution        :', `${attributed} mots datés,`,
              `${misattributed} mal attribués,`, m.unattributed, 'énoncés indécis',
              `(diaphonie ${((cfg.__BLEED ?? 0.35) * 100).toFixed(0)} %)`);
  if (ovWords > 0) {
    console.log('  parole simultanée  :', ovWords, 'mots pendant que les DEUX parlaient,',
                ovMis, 'attribués à personne\n' +
                '                       (une seule session ASR autorisée : les deux voix arrivent\n' +
                '                        mélangées. L\'affichage reste correct, l\'attribution non.)');
  }
  if (m.identityFiltered) {
    console.log('  identités filtrées :', m.identityFiltered,
                '(traductions fr→fr renvoyées par Gladia, écartées)');
  }
  if (m.engine === 'claude') {
    console.log('  mots validés       :', m.committedWords, '| contredits :', m.contradictedWords);
    console.log('  traductions        :', m.translations.done, 'ok,',
                m.translations.failed, 'échouées,', m.translations.merged, 'fusionnées');
    console.log('  config             : AGREEMENT_N=' + cfg.AGREEMENT_N,
                'MIN/MAX_WORDS=' + cfg.MIN_WORDS + '/' + cfg.MAX_WORDS,
                'AGE=' + cfg.MAX_BLOCK_AGE_MS + 'ms');
  }

  if (m.engine === 'gladia') {
    console.log('  (LocalAgreement et le découpage au mot sont inactifs :');
    console.log('   la traduction Gladia ne peut pas arriver avant la fin de la phrase.)');
  }
  const divergenceAdvice = m.divergenceRate == null ? '' : m.divergenceRate > 0.05
    ? '  ⚠ divergence > 5 % → passer à AGREEMENT_N=3 (§2)'
    : m.divergenceRate < 0.03 ? '  divergence < 3 % → OK' : '  divergence entre 3 et 5 % → surveiller';
  if (divergenceAdvice) console.log(divergenceAdvice);

  if (logPath) {
    await writeFile(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    console.log(`\n  journal horodaté : ${logPath} (${events.length} événements)`);
  }

  return rows.filter(([, ok]) => !ok).length;
}

async function port() {
  try {
    return (await readFile(join(process.env.XDG_RUNTIME_DIR || '/tmp',
      'captive-transcription.port'), 'utf8')).trim();
  } catch { return '8123'; }
}

// --- enregistrement d'une fixture depuis un vrai WAV ----------------------
async function record(wavPath) {
  const key = (await readFile(join(ROOT, '.env'), 'utf8')).match(/GLADIA_API_KEY=(.+)/)?.[1]?.trim();
  if (!key) { console.error('GLADIA_API_KEY absente de .env'); process.exit(1); }

  const wav = await readFile(wavPath);
  const pcm = wav.subarray(44);
  const body = {
    encoding: 'wav/pcm', sample_rate: cfg.SEND_RATE, bit_depth: 16, channels: 1,
    model: 'solaria-1',
    endpointing: cfg.ENDPOINTING,
    maximum_duration_without_endpointing: cfg.MAX_DURATION_WITHOUT_ENDPOINTING,
    language_config: { languages: cfg.LANGUAGES, code_switching: !!cfg.CODE_SWITCHING },
    messages_config: { receive_partial_transcripts: true, receive_final_transcripts: true,
                       receive_speech_events: true },
  };
  const r = await fetch('https://api.gladia.io/v2/live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-gladia-key': key },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('init', r.status, await r.text()); process.exit(1); }
  const { url } = await r.json();

  const out = wavPath.replace(/\.wav$/i, '') + '.fixture.jsonl';
  await writeFile(out, '');
  const t0 = Date.now();
  const ws = new WebSocket(url);
  const BYTES = (cfg.SEND_RATE * cfg.CHUNK_MS / 1000) * 2;

  await new Promise((done) => {
    ws.onopen = () => {
      let off = 0;
      const timer = setInterval(() => {
        if (off >= pcm.length) {
          clearInterval(timer);
          ws.send(JSON.stringify({ type: 'stop_recording' }));
          setTimeout(() => { try { ws.close(1000); } catch {} done(); }, 8000);
          return;
        }
        ws.send(pcm.subarray(off, off + BYTES));
        off += BYTES;
      }, cfg.CHUNK_MS);
    };
    ws.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'transcript') return;
      await appendFile(out, JSON.stringify({ at: Date.now() - t0, msg: m }) + '\n');
      process.stdout.write(m.data?.is_final ? 'F' : '.');
    };
  });
  console.log(`\n  fixture écrite : ${out}`);
  console.log(`  rejouez-la :  node tests/harness.mjs --replay ${out}`);
}

// --- point d'entrée --------------------------------------------------------
const SP = join(ROOT, 'tests', 'tmp');

if (flag('--record')) {
  await record(opt('--record'));
} else if (flag('--replay')) {
  const path = opt('--replay');
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  console.log(`Rejeu de ${lines.length} messages depuis ${path}`);
  console.log('(fixture réelle : pas de vérité de locuteur, le critère 6 est sans objet)\n');
  process.exit(await run({ messages: lines.map((l) => JSON.parse(l)) },
    { logPath: join(SP, 'harness-log.jsonl'), live: flag('--live-translate') }) ? 1 : 0);
} else {
  const sim = simulateMessages();
  const dur = (sim.msgs[sim.msgs.length - 1].at / 1000).toFixed(1);
  console.log(`Simulation : ${DIALOGUE.length} tours de parole, ${sim.msgs.length} messages, ${dur} s d'audio`);
  console.log(`Locuteurs  : ${cfg.TWO_SPEAKERS ? 'G (canal 0) et D (canal 1)' : 'un seul'}`
    + ` | langues : ${cfg.LANGUAGES.join('/')} détectées, traduction vers l'autre`);
  console.log(`Moteur     : ${GLADIA_MODE ? 'gladia (traduction en fin de phrase)'
    : 'claude ' + (flag('--live-translate') ? '(API réelle)'
       : `(simulée, médiane ${STUB_LAG} ms, dispersion Haiku)`)}\n`);
  process.exit(await run({ messages: sim.msgs, truth: sim.truth, energy: sim.energy },
    { logPath: join(SP, 'harness-log.jsonl'), live: flag('--live-translate') }) ? 1 : 0);
}
