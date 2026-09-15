// ---------------------------------------------------------------------------
//  Le tampon du MODE FICHIER : ce qui part dans les .txt lus par OBS.
//
//  OBS n'a pas de canal temps réel : une source « Texte (GDI+) » en mode
//  « lire à partir d'un fichier » relit le fichier en boucle et affiche ce
//  qu'elle y trouve. Le fichier ne s'ajoute donc pas, il se REMPLACE : il doit
//  contenir, à chaque instant, exactement ce qui doit être à l'écran.
//
//  Un fichier PAR LANGUE, pas par locuteur. L'écran de scène a quatre cases
//  (locuteur × langue) parce qu'il a la place et la couleur pour les
//  distinguer ; un fichier texte n'a ni l'une ni l'autre. Les deux locuteurs
//  partagent donc la même piste par langue, dans l'ordre où ils ont parlé —
//  c'est la forme d'un sous-titre.
//
//  Les lignes viennent de src/feed.js, donc le découpage est EXACTEMENT celui
//  de l'écran public. Une ligne déjà écrite continue de s'allonger : on la
//  retrouve par son identité (flux + id de ligne) et on la met à jour sur
//  place, sans la déplacer. C'est ce qui évite qu'un locuteur qui reprend la
//  parole fasse sauter la ligne de l'autre.
//
//  Aucune E/S ici : le tampon dit seulement QUOI écrire. L'écriture est faite
//  par le serveur (voir /api/captions), parce que le navigateur ne peut pas
//  écrire à un chemin fixe sans redemander un fichier à chaque fois.
// ---------------------------------------------------------------------------

export function createCaptionBuffer(cfg = {}) {
  const langs = (cfg.LANGUAGES ?? ['fr', 'en']).map((l) => String(l).toLowerCase());
  // Moins de lignes qu'à l'écran de scène : dans une incrustation vidéo, deux
  // lignes est la hauteur qu'on peut tenir sans manger l'image.
  const max = Math.max(1, cfg.CAPTION_MAX_LINES ?? 2);
  const rows = new Map(langs.map((l) => [l, []]));   // lang -> [{ id, text }]
  // La dernière ligne vue par flux. L'écran de scène en garde quatre, le
  // fichier deux : une ligne sortie du fichier est encore visible à l'écran et
  // revient donc à chaque mot suivant. Sans cette borne, elle serait remise en
  // fin de fichier et le texte se retrouverait dans le désordre.
  const seen = new Map();                            // flux -> plus grand id de ligne

  return {
    langs: langs.slice(),

    /**
     * Reporte l'état d'un flux après l'ajout d'un mot.
     *
     * `unit` est l'unité d'affichage du pipeline ({ key, meta: { lang } }) et
     * `lines` l'instantané renvoyé par le feed de ce flux.
     */
    push(unit, lines) {
      const lang = String(unit?.meta?.lang ?? unit?.lang ?? '').toLowerCase();
      const buf = rows.get(lang);
      if (!buf || !Array.isArray(lines)) return;
      const last = seen.get(unit.key);
      for (const line of lines) {
        const text = String(line?.text ?? '').trim();
        if (text === '') continue;
        const id = `${unit.key}#${line.id}`;
        const cur = buf.find((e) => e.id === id);
        if (cur) cur.text = text;                    // la ligne s'allonge, elle ne bouge pas
        else if (last === undefined || line.id > last) buf.push({ id, text });
        // sinon : ligne déjà sortie du fichier, on ne la fait pas revenir.
      }
      const top = lines[lines.length - 1]?.id;
      if (typeof top === 'number') seen.set(unit.key, Math.max(last ?? -Infinity, top));
      while (buf.length > max) buf.shift();
    },

    /** Le contenu exact de chaque fichier, à cet instant. */
    texts() {
      return Object.fromEntries(langs.map((l) => [l, rows.get(l).map((e) => e.text).join('\n')]));
    },

    /** Tous les fichiers vides — blackout, arrêt, mode fichier décoché. */
    blank() {
      return Object.fromEntries(langs.map((l) => [l, '']));
    },

    /**
     * Vider (blackout, silence prolongé, bouton « Vider », arrêt).
     *
     * Les flux repartent aussi de zéro : après un arrêt, les feeds sont
     * reconstruits et leurs lignes renumérotées depuis 0 — garder les anciens
     * repères ferait taire le fichier pour toute la session suivante.
     */
    clear() {
      for (const l of langs) rows.set(l, []);
      seen.clear();
    },
  };
}
