// ---------------------------------------------------------------------------
//  Le modèle d'affichage. APPEND-ONLY, garanti par la structure de données et
//  pas seulement par convention (critère d'acceptation n°1).
//
//  L'unité n'est pas la ligne : c'est le MOT. Les mots arrivent un par un, au
//  rythme de la parole, et remplissent la ligne du bas ; quand elle est pleine
//  une nouvelle ligne s'ouvre et le contenu monte d'un cran.
//
//  Il n'existe AUCUNE méthode pour modifier ou retirer un mot déjà émis. La
//  seule opération est append(). Un mot est gelé à la création, et il n'est
//  jamais déplacé d'une ligne à l'autre : le texte à l'écran ne se recompose
//  jamais, il ne fait que s'allonger.
// ---------------------------------------------------------------------------

export function createFeed(cfg) {
  let lines = [];        // [{ id, words: [mot gelé] }] — max MAX_LINES
  let nextLineId = 0, nextWordId = 0;
  const emittedLog = []; // trace de tous les mots émis, pour les tests

  // Largeur d'une ligne, espaces de jointure comprises.
  const width = (line) => line.words.reduce((n, w) => n + w.text.length + 1, -1);

  function openLine() {
    lines.push({ id: nextLineId++, words: [] });
    while (lines.length > cfg.MAX_LINES) lines.shift();
  }

  return {
    /**
     * Ajoute un ou plusieurs mots à la ligne courante. `breakBefore` force une
     * ligne neuve (après une respiration). Retourne les lignes visibles.
     */
    append(text, { breakBefore = false } = {}) {
      const words = String(text).trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return this.lines();

      let brk = breakBefore;
      for (const t of words) {
        const cur = lines[lines.length - 1];
        if (!cur || brk || width(cur) + 1 + t.length > cfg.MAX_CHARS_PER_LINE) openLine();
        brk = false;
        const word = Object.freeze({ id: nextWordId++, text: t });
        lines[lines.length - 1].words.push(word);
        emittedLog.push(word);
      }
      return this.lines();
    },

    /**
     * Les lignes visibles. Instantané : l'appelant ne peut pas muter l'état, et
     * les mots qu'il reçoit sont les objets gelés eux-mêmes — leur identité
     * stable est ce qui permet à la vue de n'ajouter que ce qui manque.
     */
    lines() {
      return lines.map((l) => Object.freeze({
        id: l.id,
        words: l.words.slice(),
        text: l.words.map((w) => w.text).join(' '),
      }));
    },

    /** Vider l'écran (blackout / silence prolongé). N'altère aucun mot. */
    clear() {
      lines = [];
      return this.lines();
    },

    /** Tout ce qui a été émis depuis le début — lecture seule, pour les tests. */
    emitted() {
      return emittedLog.slice();
    },
  };
}
