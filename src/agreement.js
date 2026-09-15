// ---------------------------------------------------------------------------
//  LocalAgreement-N — la couche de validation. C'est le cœur du système.
//
//  Un mot n'est publié que lorsqu'il est stable : qu'il apparaît au même
//  endroit dans N partials consécutives. Empiriquement un mot qui survit à
//  deux partials ne bouge quasiment plus.
//
//  Règle absolue : ON NE RETRACTE JAMAIS. Le final peut contredire un mot
//  déjà publié ; on accepte la divergence et on n'ajoute que la queue. Mais
//  on la MESURE — c'est la métrique de réglage principale.
// ---------------------------------------------------------------------------

// Clé de comparaison : on ignore la ponctuation et la casse, que le modèle
// ajoute et retire au fil des partials. Sans ça un simple « Bonsoir » devenu
// « Bonsoir, » casserait le préfixe commun et bloquerait TOUT ce qui suit.
export function wordKey(word) {
  return String(word.text ?? word)
    .toLowerCase()
    .replace(/^[«"'([]+/, '')
    .replace(/[.,!?;:…»"')\]]+$/, '');
}

// Plus long préfixe commun à plusieurs listes de mots.
// Il faut AU MOINS deux listes : un accord avec soi-même n'est pas un accord.
// Sans ce garde-fou la première partial publierait tout son contenu d'un coup,
// ce qui vide LocalAgreement de son sens.
function commonPrefix(lists) {
  if (lists.length < 2) return 0;
  const shortest = Math.min(...lists.map((l) => l.length));
  let i = 0;
  outer: for (; i < shortest; i++) {
    const k = wordKey(lists[0][i]);
    for (let j = 1; j < lists.length; j++) {
      if (wordKey(lists[j][i]) !== k) break outer;
    }
  }
  return i;
}

export function createAgreement({ agreementN = 2 } = {}) {
  if (agreementN < 2) throw new Error('agreementN doit valoir au moins 2');

  let committedCount = 0;    // mots déjà validés pour l'utterance courante
  let committedWords = [];   // ce qu'on a publié, pour mesurer la divergence
  let history = [];          // les (agreementN - 1) partials précédentes

  const stats = { committed: 0, contradicted: 0, utterances: 0 };

  function reset() {
    committedCount = 0;
    committedWords = [];
    history = [];
  }

  return {
    /**
     * Partial reçue (is_final: false). Retourne les mots devenus stables,
     * jamais encore publiés.
     */
    partial(words) {
      let delta = [];
      // Il faut agreementN partials au total, donc (agreementN - 1) en
      // historique, avant que quoi que ce soit puisse être déclaré stable.
      if (history.length >= agreementN - 1) {
        const stable = commonPrefix([words, ...history]);
        if (stable > committedCount) {
          delta = words.slice(committedCount, stable);
          committedCount = stable;
          committedWords.push(...delta);
          stats.committed += delta.length;
        }
      }
      history.unshift(words);
      history.length = Math.min(history.length, agreementN - 1);
      return delta;
    },

    /**
     * Final reçu (is_final: true). Autoritaire : on vide la queue restante et
     * on compte les mots déjà publiés que le final contredit.
     */
    final(words) {
      let contradicted = 0;
      const overlap = Math.min(committedWords.length, words.length);
      for (let i = 0; i < overlap; i++) {
        if (wordKey(committedWords[i]) !== wordKey(words[i])) contradicted++;
      }
      // Un final plus court que ce qu'on a publié : le surplus est contredit
      // de fait (il n'existe pas dans la version autoritaire).
      contradicted += Math.max(0, committedWords.length - words.length);
      stats.contradicted += contradicted;
      stats.utterances++;

      const delta = words.slice(committedCount);
      reset();
      return { delta, contradicted };
    },

    reset,

    /** Taux de mots validés puis contredits par le final. < 3 % = OK. */
    divergenceRate() {
      return stats.committed === 0 ? 0 : stats.contradicted / stats.committed;
    },

    stats,
  };
}
