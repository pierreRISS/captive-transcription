// ---------------------------------------------------------------------------
//  Découpage en blocs de sens (5 à 12 mots).
//
//  Pas mot à mot (contexte insuffisant, traduction incohérente), pas phrase
//  par phrase (trop lent). Des unités de sens.
// ---------------------------------------------------------------------------

const STRONG_PUNCT = /[.!?…]["»')\]]*$/;

export function createChunker(cfg, onBlock) {
  const connectors = new Set(cfg.CONNECTORS.map((c) => c.toLowerCase()));

  let buf = [];
  let lastWordAt = 0;    // horodatage du dernier mot poussé (ms, horloge locale)
  let firstWordAt = 0;   // horodatage du premier mot du buffer courant
  let seq = 0;

  const plain = (w) => String(w.text ?? w);

  function emit(reason) {
    if (buf.length === 0) return null;
    const words = buf;
    buf = [];
    const block = Object.freeze({
      seq: seq++,
      words,
      text: words.map(plain).join(' ').replace(/\s+/g, ' ').trim(),
      // Bornes du bloc en secondes d'audio. `endAudio` sert à mesurer la latence
      // audio → affichage ; `startAudio` sert à étaler les mots de la traduction
      // sur la durée réelle du bloc à l'affichage.
      startAudio: words[0]?.start ?? null,
      endAudio: words[words.length - 1]?.end ?? null,
      reason,
    });
    onBlock(block);
    return block;
  }

  return {
    /**
     * Pousse un mot validé. `now` est l'horloge locale en ms.
     */
    push(word, now) {
      const text = plain(word);

      // Un connecteur ouvre l'unité suivante : on coupe AVANT lui, à condition
      // d'avoir déjà de quoi faire un bloc lisible.
      if (buf.length >= cfg.MIN_WORDS && connectors.has(wordLower(text))) {
        emit('connector');
      }

      if (buf.length === 0) firstWordAt = now;
      buf.push(word);
      lastWordAt = now;

      // Ponctuation forte : frontière naturelle, on vide tout de suite.
      if (STRONG_PUNCT.test(text)) return emit('punctuation');
      if (buf.length >= cfg.MAX_WORDS) return emit('max_words');
      return null;
    },

    /** Fin d'utterance : frontière naturelle, on vide sans condition. */
    flush(reason = 'final') {
      return emit(reason);
    },

    /**
     * Les deux règles temporelles. À appeler périodiquement (~100 ms).
     *
     *  - inactivité : sans elle, 3 mots orphelins restent bloqués dans le
     *    buffer quand le locuteur s'arrête ;
     *  - âge maximum : sans elle, une phrase longue sans ponctuation forte ni
     *    connecteur fige l'écran jusqu'à MAX_WORDS (critère d'acceptation n°4).
     */
    timeCheck(now) {
      if (buf.length === 0) return null;
      if (now - lastWordAt >= cfg.IDLE_FLUSH_MS) return emit('idle');
      if (cfg.MAX_BLOCK_AGE_MS && now - firstWordAt >= cfg.MAX_BLOCK_AGE_MS) {
        return emit('max_age');
      }
      return null;
    },

    pending() {
      return buf.length;
    },

    reset() {
      buf = [];
    },
  };
}

function wordLower(text) {
  return text.toLowerCase().replace(/^[«"'([]+/, '').replace(/[.,!?;:…»"')\]]+$/, '');
}
