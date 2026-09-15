// ---------------------------------------------------------------------------
//  Le pipeline. Il ne calcule pas la cadence (c'est stage.js) et ne dessine
//  rien : il ROUTE.
//
//  Deux locuteurs × deux langues = quatre flux d'affichage indépendants, et la
//  clé d'un flux est `locuteur:LANGUE` — jamais `original` ou `traduction` :
//
//      L:fr  ce que dit le locuteur G, en français     L:en  … en anglais
//      R:fr  ce que dit le locuteur D, en français     R:en  … en anglais
//
//  C'est ce qui donne une PLACE FIXE à chaque langue. Quand un locuteur passe du
//  français à l'anglais, sa case française reçoit désormais la traduction au lieu
//  de l'original : le contenu change de nature, l'emplacement ne bouge pas. Un
//  spectateur sait donc toujours où regarder.
//
//  Les quatre files sont indépendantes : deux locuteurs simultanés s'écrivent en
//  parallèle, chacun à sa cadence.
//
//  Pour chaque énoncé il faut donc répondre à trois questions :
//    QUI parle   → `speakerOf(start, end)`, injecté (énergie des deux canaux)
//    QUELLE langue → `utterance.language` (code_switching activé)
//    VERS QUOI traduire → l'autre langue de cfg.LANGUAGES
//
//  Deux moteurs de traduction :
//   'gladia' : Gladia transcrit ET traduit. Avec deux langues cibles, il renvoie
//              aussi la traduction identité (fr→fr) : on la filtre.
//   'claude' : Gladia transcrit seulement. LocalAgreement publie les mots
//              stables, on les regroupe en blocs de sens et on traduit chaque
//              bloc à la volée, dans la direction détectée.
//
//  Aucune dépendance au DOM ni au réseau : tout est injecté. C'est ce qui
//  permet au harnais hors-ligne de rejouer un enregistrement dans exactement
//  le même code que le direct.
// ---------------------------------------------------------------------------

import { createAgreement } from './agreement.js';
import { createChunker } from './chunker.js';
import { createStage, planWords } from './stage.js';

export { planWords };

/** Tokenise une utterance Gladia. Préfère `words[]` : il porte les timings. */
export function tokenize(utterance) {
  if (Array.isArray(utterance?.words) && utterance.words.length > 0) {
    return utterance.words
      .map((w) => ({ text: String(w.word ?? '').trim(), start: w.start ?? null, end: w.end ?? null }))
      .filter((w) => w.text !== '');
  }
  const text = String(utterance?.text ?? '').trim();
  if (text === '') return [];
  return text.split(/\s+/).map((t) => ({ text: t, start: utterance?.start ?? null,
                                         end: utterance?.end ?? null, approx: true }));
}

/** 'fr-FR' / 'french' / 'fr' → 'fr'. Gladia n'est pas constant sur la forme. */
export function normLang(lang) {
  const s = String(lang ?? '').toLowerCase().trim();
  if (s === '') return null;
  const two = s.slice(0, 2);
  if (s.startsWith('fre') || s.startsWith('fra') || two === 'fr') return 'fr';
  if (s.startsWith('eng') || two === 'en') return 'en';
  return two;
}

/** L'autre langue de la paire. C'est la cible de traduction. */
export function otherLang(lang, cfg) {
  const src = normLang(lang) || cfg.SOURCE_LANGUAGE;
  const pair = cfg.LANGUAGES?.length === 2 ? cfg.LANGUAGES : [cfg.SOURCE_LANGUAGE, cfg.TARGET_LANGUAGE];
  const other = pair.find((l) => normLang(l) !== src);
  return other ? normLang(other) : cfg.TARGET_LANGUAGE;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function createPipeline(cfg, {
  translator,          // requis par le moteur 'claude' seulement
  onDisplay,           // (unit) => void — un mot prêt à afficher, unit.key = flux
  onEvent,             // (event) => void — journal horodaté
  speakerOf,           // (startAudio, endAudio) => 'L' | 'R' | null
  clock = Date,
}) {
  const engine = cfg.TRANSLATION_ENGINE || 'claude';
  const useClaude = engine === 'claude';
  // Un seul locuteur : un seul jeu de flux. Sinon la colonne de droite existerait
  // sans jamais rien recevoir.
  const declared = cfg.SPEAKERS?.length ? cfg.SPEAKERS : [{ id: 'L' }];
  const speakerIds = (cfg.TWO_SPEAKERS ? declared : [declared[0]]).map((s) => s.id);
  const soloSpeaker = speakerIds[0];

  let audioEpoch = null;
  const getEpoch = () => audioEpoch;
  const stats = { utterances: 0, unattributed: 0, identityFiltered: 0 };

  function log(type, data = {}) {
    onEvent?.({ t: clock.now(), type, ...data });
  }

  // --- les quatre étages d'affichage : locuteur × LANGUE --------------------
  const langs = (cfg.LANGUAGES?.length ? cfg.LANGUAGES : [cfg.SOURCE_LANGUAGE, cfg.TARGET_LANGUAGE])
    .map(normLang).filter(Boolean);
  const stages = new Map();
  for (const id of speakerIds) {
    for (const lang of langs) {
      const key = `${id}:${lang}`;
      stages.set(key, createStage(cfg, { key, getEpoch, onDisplay, onEvent, clock }));
    }
  }

  // Une case ne reçoit QUE sa langue. Si Gladia renvoie une langue inattendue
  // (code_switching sur un mot isolé), on ne jette pas le texte en silence : on
  // le range dans la langue source par défaut et on le loggue.
  const lastKindOf = new Map();
  function stage(speaker, lang, kind) {
    const sp = stages.has(`${speaker}:${langs[0]}`) ? speaker : soloSpeaker;
    let l = normLang(lang);
    if (!stages.has(`${sp}:${l}`)) {
      log('lang_unexpected', { lang, fallback: langs[0], speaker: sp });
      l = langs[0];
    }
    const key = `${sp}:${l}`;
    // Dans une même case, l'original et la traduction sont deux textes
    // différents : on ne les laisse pas se coller sur la même ligne.
    const forceBreak = kind !== undefined && lastKindOf.get(key) !== undefined
                       && lastKindOf.get(key) !== kind;
    if (kind !== undefined) lastKindOf.set(key, kind);
    return { st: stages.get(key), forceBreak };
  }

  /**
   * Qui parle ? L'attribution vient de l'énergie des deux canaux, injectée. Si
   * elle est indécise (les deux micros au même niveau : personne ne parle, ou
   * les deux à la fois), on garde le dernier locuteur identifié plutôt que
   * d'envoyer le texte dans la mauvaise colonne.
   */
  let lastSpeaker = soloSpeaker;
  function whoSpoke(startAudio, endAudio) {
    if (!cfg.TWO_SPEAKERS || speakerIds.length < 2) return soloSpeaker;
    const got = speakerOf?.(startAudio, endAudio) ?? null;
    if (got && speakerIds.includes(got)) { lastSpeaker = got; return got; }
    stats.unattributed++;
    return lastSpeaker;
  }

  // --- moteur 'claude' : validation au mot + découpage en blocs de sens -----
  const agreement = useClaude ? createAgreement({ agreementN: cfg.AGREEMENT_N }) : null;
  const chunker = useClaude
    ? createChunker(cfg, (block) => {
        // Le bloc hérite de la langue et du locuteur du dernier final : c'est la
        // seule information disponible au moment où il part en traduction.
        const source = normLang(currentLang) || cfg.SOURCE_LANGUAGE;
        const enriched = { ...block, source, target: null,
                           targetLang: otherLang(source, cfg),
                           speaker: whoSpoke(block.startAudio, block.endAudio) };
        log('block_flushed', { seq: block.seq, text: block.text, reason: block.reason,
                               words: block.words.length, source: enriched.source,
                               targetLang: enriched.targetLang, speaker: enriched.speaker });
        translator.submit(enriched);
      })
    : null;
  let currentLang = cfg.SOURCE_LANGUAGE;

  return {
    engine,
    stageKeys: [...stages.keys()],

    /** À appeler quand le premier octet d'audio part vers Gladia. */
    startAudioClock(at = clock.now()) {
      audioEpoch = at;
      log('audio_clock_start', { engine });
    },

    /** Message brut reçu de Gladia. */
    onGladiaMessage(msg) {
      if (msg?.error) { log('gladia_error', { error: msg.error }); return; }

      // ---- traduction native Gladia (moteur 'gladia') ---------------------
      if (msg?.type === 'translation') {
        if (useClaude) return;   // on traduit nous-mêmes, on ignore
        const d = msg.data || {};
        const tu = d.translated_utterance;
        const text = String(tu?.text ?? '').trim();
        if (!text) return;

        // Deux langues cibles ⇒ Gladia renvoie AUSSI l'identité (fr→fr). Elle
        // n'apporte rien et écraserait la vraie traduction dans la colonne.
        const from = normLang(d.original_language ?? d.utterance?.language);
        const to = normLang(d.target_language ?? tu?.language);
        if (from && to && from === to) {
          stats.identityFiltered++;
          log('translation_identity_skipped', { lang: to, text });
          return;
        }

        const startAudio = tu?.start ?? d.utterance?.start ?? null;
        const endAudio = tu?.end ?? d.utterance?.end ?? null;
        const speaker = whoSpoke(startAudio, endAudio);
        log('translation_received', { text, from, to, speaker, endAudio });
        // La traduction va dans la case de SA langue, pas dans une case
        // « traduction » : c'est ça, la place fixe.
        const { st, forceBreak } = stage(speaker, to ?? otherLang(from, cfg), 'tgt');
        st.enqueue(text, { startAudio, endAudio, forceBreak,
                           meta: { speaker, lang: to, kind: 'tgt' } });
        return;
      }

      if (msg?.type !== 'transcript') return;
      const d = msg.data || {};
      const u = d.utterance;
      if (!u) return;

      const lang = normLang(u.language) || cfg.SOURCE_LANGUAGE;
      const words = tokenize(u);

      if (!d.is_final) {
        log('partial', { text: u.text, words: words.length, lang });
        if (!useClaude) return;
        currentLang = lang;
        const delta = agreement.partial(words);
        for (const w of delta) chunker.push(w, clock.now());
        if (delta.length) log('words_committed', { n: delta.length,
                                                   text: delta.map((w) => w.text).join(' ') });
        return;
      }

      // ---- final : c'est lui qui porte l'ORIGINAL affiché -----------------
      // Les deux moteurs passent par là. L'original n'a rien à attendre d'une
      // traduction, et Gladia donne ses timings mot par mot : il est révélé
      // exactement au rythme où il a été prononcé.
      stats.utterances++;
      currentLang = lang;
      const speaker = whoSpoke(u.start ?? null, u.end ?? null);
      log('final', { text: u.text, lang, speaker });
      if (String(u.text ?? '').trim() !== '') {
        // L'original va dans la case de la langue RÉELLEMENT parlée.
        const { st, forceBreak } = stage(speaker, lang, 'src');
        st.enqueue(u.text, {
          startAudio: u.start ?? null, endAudio: u.end ?? null, words, forceBreak,
          meta: { speaker, lang, kind: 'src' },
        });
      }

      if (!useClaude) return;

      const { delta, contradicted } = agreement.final(words);
      for (const w of delta) chunker.push(w, clock.now());
      if (delta.length) log('words_committed', { n: delta.length,
                                                 text: delta.map((w) => w.text).join(' ') });
      if (contradicted > 0) log('divergence', { contradicted, rate: agreement.divergenceRate() });
      chunker.flush('final');
    },

    /** Moteur 'claude' : un bloc traduit est prêt. */
    onTranslated(block) {
      log('translated', { seq: block.seq, target: block.target,
                          speaker: block.speaker, to: block.targetLang });
      const { st, forceBreak } = stage(block.speaker || lastSpeaker, block.targetLang, 'tgt');
      st.enqueue(block.target, {
        startAudio: block.startAudio ?? null,
        endAudio: block.endAudio ?? null, forceBreak,
        meta: { speaker: block.speaker, lang: block.targetLang, kind: 'tgt' },
      });
    },

    /** À appeler périodiquement (~100 ms). */
    tick(now = clock.now()) {
      chunker?.timeCheck(now);
      for (const s of stages.values()) s.tick();
    },

    metrics() {
      // Agrégat sur les quatre flux : ce qui compte est le vécu du spectateur,
      // pas la performance d'une colonne.
      const all = [...stages.values()];
      const cat = (f) => all.flatMap((s) => f(s.raw));
      const latencies = cat((r) => r.latencies);
      const sorted = latencies.slice().sort((a, b) => a - b);
      const sortedStart = cat((r) => r.latenciesStart).sort((a, b) => a - b);
      const lateness = cat((r) => r.lateness);
      const gaps = cat((r) => r.gaps);
      const bursts = all.reduce((n, s) => n + s.raw.stats.bursts, 0);
      const tooFast = all.reduce((n, s) => n + s.raw.stats.tooFast, 0);

      const perStage = {};
      for (const s of all) {
        perStage[s.key] = { words: s.raw.latencies.length, queued: s.queued() };
      }

      return {
        engine,
        wordsDisplayed: latencies.length,
        latencyMedian: percentile(sorted, 50),
        latencyP95: percentile(sorted, 95),
        latencyStartMedian: percentile(sortedStart, 50),
        latencyStartP95: percentile(sortedStart, 95),
        // Écart au retard VISÉ. C'est la mesure de régie : à 0, l'écran suit la
        // voix avec exactement DISPLAY_DELAY_MS de retard.
        targetDelay: cfg.DISPLAY_DELAY_MS,
        maxLateness: lateness.length ? Math.max(...lateness) : null,
        lateWords: lateness.filter((x) => x > 500).length,
        burstWords: bursts,
        // Mots révélés plus vite que le plancher de lisibilité ne l'autorise.
        // C'est la mesure du défaut « le texte s'affiche d'un coup ».
        tooFastWords: tooFast,
        maxGap: gaps.length ? Math.max(...gaps) : null,
        queued: all.reduce((n, s) => n + s.queued(), 0),
        utterances: stats.utterances,
        // Deux locuteurs
        perStage,
        unattributed: stats.unattributed,
        identityFiltered: stats.identityFiltered,
        // Spécifique au moteur 'claude'
        divergenceRate: agreement ? agreement.divergenceRate() : null,
        committedWords: agreement ? agreement.stats.committed : null,
        contradictedWords: agreement ? agreement.stats.contradicted : null,
        pendingBlocks: translator ? translator.pending() : 0,
        pendingWords: chunker ? chunker.pending() : 0,
        translations: translator ? translator.stats : null,
      };
    },

    clearQueue() {
      for (const s of stages.values()) s.clear();
    },

    reset() {
      agreement?.reset();
      chunker?.reset();
      translator?.reset();
      this.clearQueue();
    },
  };
}
