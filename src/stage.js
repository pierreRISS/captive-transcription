// ---------------------------------------------------------------------------
//  UN étage d'affichage cadencé : une file de mots datés, révélés à retard
//  constant.
//
//  Le texte arrive par paquets (une utterance entière, jusqu'à 5 s de parole
//  d'un coup) ; il ressort un mot à la fois, chaque mot affiché à la date où il
//  a été prononcé + DISPLAY_DELAY_MS. L'écran ne se fige plus en attendant une
//  phrase, puis ne la lâche plus d'un bloc : il écrit au rythme de la voix.
//
//  Il en existe un par FLUX indépendant. Avec deux locuteurs et l'original en
//  plus de la traduction, il y en a quatre : L:src, L:tgt, R:src, R:tgt. Chacun
//  a sa propre file, son propre rythme et ses propres mesures — un locuteur qui
//  se taît n'immobilise pas l'autre.
//
//  Aucune dépendance au DOM ni au réseau.
// ---------------------------------------------------------------------------

/**
 * Répartit les mots d'un segment sur sa durée audio.
 *
 * Sur l'ORIGINAL, Gladia donne les timings mot par mot : on les utilise tels
 * quels (`words`), c'est exact. Sur la TRADUCTION il n'y en a pas — l'autre
 * langue n'a ni le même nombre de mots ni le même ordre — alors on étale les
 * mots cibles sur [start, end] au prorata de leur longueur : un mot long prend
 * plus de temps à dire qu'un mot court. Chaque mot reçoit la date, en secondes
 * d'audio, à laquelle il COMMENCE à être prononcé.
 *
 * `audioAt: null` = aucun timing exploitable ; l'appelant cadencera au débit
 * supposé, sans ancrage sur l'horloge audio.
 */
export function planWords(text, startAudio, endAudio, cfg, timedWords = null) {
  // Timings réels disponibles : rien à estimer.
  if (Array.isArray(timedWords) && timedWords.length > 0) {
    const out = timedWords
      .map((w) => ({
        text: String(w.text ?? w.word ?? '').trim(),
        audioAt: typeof w.start === 'number' ? w.start
          : typeof w.end === 'number' ? w.end : null,
      }))
      .filter((w) => w.text !== '');
    // On les REFUSE s'ils sont dégénérés — tous identiques. C'est ce que produit
    // une utterance sans tableau `words[]` : chaque mot hérite du début de
    // l'énoncé. Les prendre au mot ferait sortir toute la phrase en rafale, ce
    // qui est précisément le défaut qu'on corrige. Mieux vaut estimer.
    const dated = out.filter((w) => w.audioAt !== null);
    const distinct = new Set(dated.map((w) => w.audioAt)).size;
    if (dated.length > 0 && (out.length === 1 || distinct > 1)) return out;
  }

  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  let start = typeof startAudio === 'number' ? startAudio : null;
  const end = typeof endAudio === 'number' ? endAudio : null;
  // Sans début : on remonte depuis la fin au débit supposé. C'est le cas des
  // blocs du moteur 'claude', qui ne portent que leur fin.
  if (start === null && end !== null) {
    start = Math.max(0, end - words.length / cfg.EST_WORDS_PER_SECOND);
  }
  if (start === null || end === null || !(end > start)) {
    return words.map((text) => ({ text, audioAt: null }));
  }

  const weights = words.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  let acc = 0;
  return words.map((text, i) => {
    const audioAt = start + (acc / total) * span;
    acc += weights[i];
    return { text, audioAt };
  });
}

/**
 * Temps de lecture minimum à accorder à un mot DÉJÀ affiché avant d'en poser un
 * autre à côté. C'est le plancher de lisibilité : il est proportionnel à la
 * longueur, parce que lire « anniversaire » prend plus longtemps que lire « et ».
 *
 * Il ne remplace pas MIN_WORD_GAP_MS, il s'y ajoute — MIN_WORD_GAP_MS reste le
 * plancher dur (et le seul, si MAX_REVEAL_CPS est mis à 0).
 */
export function readGapMs(chars, cfg) {
  const hard = Math.max(1, cfg.MIN_WORD_GAP_MS);
  const cps = cfg.MAX_REVEAL_CPS;
  if (!cps || cps <= 0) return hard;
  // +1 : l'espace qui suit le mot fait partie de ce qu'il y a à parcourir.
  return Math.max(hard, ((chars + 1) * 1000) / cps);
}

/**
 * @param cfg       la config (lue à CHAQUE mot : les curseurs de la régie
 *                  agissent en direct)
 * @param key       identifiant du flux, p.ex. 'L:tgt' — remonté dans onDisplay
 * @param getEpoch  () => date locale (ms) du premier octet d'audio, ou null
 * @param onDisplay (unit) => void — un mot prêt à afficher
 * @param onEvent   (event) => void — journal
 */
export function createStage(cfg, { key, getEpoch, onDisplay, onEvent, clock = Date }) {
  let queue = [];              // mots en attente d'affichage
  let timer = null, dueAtCached = null;
  let seq = 0, batch = 0;
  let lastQueuedAudioAt = null, lastDisplayAt = null, lastBatchSeen = null;
  // Longueur du mot actuellement à l'écran : c'est LUI qu'il reste à lire, donc
  // c'est lui qui fixe le délai avant le suivant.
  let lastChars = 0;
  const latencies = [], latenciesStart = [], lateness = [], gaps = [];
  const stats = { wordsQueued: 0, bursts: 0, tooFast: 0 };

  const log = (type, data) => onEvent?.({ t: clock.now(), type, key, ...data });

  function enqueue(text, { startAudio = null, endAudio = null, words = null,
                           meta = null, forceBreak = false } = {}) {
    const planned = planWords(text, startAudio, endAudio, cfg, words);
    if (planned.length === 0) return;
    batch++;
    const fallbackGap = 1000 / cfg.EST_WORDS_PER_SECOND;
    let first = true;

    for (const p of planned) {
      // Monotonie : deux segments qui se recouvrent (traduction fusionnée,
      // estimation approximative) ne doivent jamais faire RECULER l'horloge
      // d'affichage, sinon les mots suivants partiraient en rafale.
      const audioAt = p.audioAt !== null && lastQueuedAudioAt !== null
        ? Math.max(p.audioAt, lastQueuedAudioAt)
        : p.audioAt;
      const gapMs = audioAt !== null && lastQueuedAudioAt !== null
        ? (audioAt - lastQueuedAudioAt) * 1000
        : fallbackGap;

      queue.push(Object.freeze({
        key, seq: seq++, batch, text: p.text, audioAt, gapMs, meta,
        // Après une respiration, la phrase suivante repart sur une ligne neuve.
        // `forceBreak` fait de même quand la case passe de l'original à la
        // traduction : ce sont deux textes différents, pas une suite.
        breakBefore: (first && forceBreak) || gapMs >= cfg.LINE_BREAK_SILENCE_MS,
      }));
      first = false;
      stats.wordsQueued++;
      if (audioAt !== null) lastQueuedAudioAt = audioAt;
    }
    schedule();
  }

  /**
   * Date d'affichage d'un mot.
   *
   *  - à l'heure : sa date de parole + le retard visé. Le retard est donc
   *    exactement constant, et les silences de la parole sont des silences à
   *    l'écran.
   *  - en retard (traduction lente, phrase plus longue que le retard visé) : on
   *    ne le lâche PAS immédiatement — on rejoue l'intervalle de parole accéléré
   *    de CATCH_UP_RATE. Le rattrapage reste lisible au lieu d'être une rafale.
   *    Un long silence, lui, n'est pas rejoué (MAX_PACE_GAP_MS) : c'est
   *    précisément là qu'on rattrape.
   *
   * Dans les deux cas le résultat est borné par le PLANCHER DE LISIBILITÉ
   * (readGapMs) : jamais plus vite que MAX_REVEAL_CPS caractères par seconde.
   * C'est ce qui empêche une phrase longue — ou deux textes qui se recouvrent
   * dans la même case — de sortir en bloc, y compris quand les timings de
   * l'ASR sont saccadés ou identiques.
   */
  function dueAt(unit) {
    const epoch = getEpoch();
    const target = epoch !== null && unit.audioAt !== null
      ? epoch + unit.audioAt * 1000 + cfg.DISPLAY_DELAY_MS
      : null;
    if (lastDisplayAt === null) return target ?? clock.now();
    const pace = Math.max(
      readGapMs(lastChars, cfg),
      Math.min(unit.gapMs, cfg.MAX_PACE_GAP_MS) / Math.max(1, cfg.CATCH_UP_RATE)
    );
    const earliest = lastDisplayAt + pace;
    return target === null ? earliest : Math.max(target, earliest);
  }

  function schedule() {
    if (timer || queue.length === 0) return;
    const due = dueAt(queue[0]);
    dueAtCached = due;
    const fire = () => {
      timer = null;
      const unit = queue.shift();
      if (unit) commit(unit);
      schedule();
    };
    // `pace` ≥ 1 ms garantit qu'on repasse par un timer : pas de récursion
    // profonde même si toute la file est due.
    if (due - clock.now() <= 0) fire();
    else timer = setTimeout(fire, due - clock.now());
  }

  function commit(unit) {
    const now = clock.now();
    if (lastDisplayAt !== null) {
      const gap = now - lastDisplayAt;
      gaps.push(gap);
      if (gap <= Math.max(1, cfg.MIN_WORD_GAP_MS) + 5) stats.bursts++;
      // Plus fin que `bursts` : un mot peut sortir bien au-dessus du plancher dur
      // et rester illisible. C'est CE compteur qui mesure le défaut corrigé.
      if (gap < readGapMs(lastChars, cfg) - 5) stats.tooFast++;
    }
    lastDisplayAt = now;
    lastChars = unit.text.length;

    const epoch = getEpoch();
    let latency = null;
    if (epoch !== null && unit.audioAt !== null) {
      latency = now - (epoch + unit.audioAt * 1000);
      latencies.push(latency);
      lateness.push(latency - cfg.DISPLAY_DELAY_MS);
      // Le vécu du spectateur au DÉBUT d'un segment : c'est là que le retard est
      // le plus grand en moteur 'gladia' (rien ne sort avant la fin de phrase).
      if (unit.batch !== lastBatchSeen) { latenciesStart.push(latency); lastBatchSeen = unit.batch; }
    }
    log('word_displayed', { seq: unit.seq, batch: unit.batch, text: unit.text,
                            latency, breakBefore: unit.breakBefore });
    onDisplay({ ...unit, latency });
  }

  return {
    key,
    enqueue,

    /**
     * À appeler périodiquement (~100 ms). Filet à deux titres : un timer perdu
     * (onglet en arrière-plan, throttling) est rattrapé, et si la régie BAISSE
     * DISPLAY_DELAY_MS le mot déjà programmé est avancé au lieu d'attendre son
     * ancienne date.
     */
    tick() {
      if (timer && queue.length > 0 && dueAt(queue[0]) < dueAtCached - 50) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    },

    raw: { latencies, latenciesStart, lateness, gaps, stats },
    queued: () => queue.length,

    clear() {
      queue = [];
      if (timer) { clearTimeout(timer); timer = null; }
      // L'horloge audio continue de tourner : on ne remet pas lastQueuedAudioAt
      // à zéro, sinon les mots suivants recevraient des dates du passé.
    },
  };
}
