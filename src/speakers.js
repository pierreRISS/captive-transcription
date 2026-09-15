// ---------------------------------------------------------------------------
//  Qui a parlé ? Attribution d'un énoncé à un locuteur, en local.
//
//  Le plan Gladia n'autorise qu'UNE session live simultanée : on ne peut pas
//  ouvrir une session par micro. On envoie donc la somme des deux canaux, et
//  c'est ici qu'on retrouve qui parlait — en comparant l'énergie des deux canaux
//  sur la plage de temps de l'énoncé, que Gladia nous donne en secondes d'audio.
//
//  Deux micros sur scène captent TOUS LES DEUX les deux voix. Le niveau absolu
//  ne dit donc rien ; c'est l'écart RELATIF qui identifie. Sous SPEAKER_MIN_RATIO
//  on refuse de trancher (retourne null) : mieux vaut garder le locuteur
//  précédent que d'écrire dans la mauvaise colonne.
//
//  Aucune dépendance au DOM : le harnais injecte ses propres énergies.
// ---------------------------------------------------------------------------

export function createSpeakerTracker(cfg) {
  // Fenêtre glissante de paquets { t0, t1, eL, eR }. eX = énergie (rms² × durée),
  // additive : l'énergie d'un intervalle est la somme de celles des paquets.
  let chunks = [];
  let newest = 0;

  const idOf = (n) => cfg.SPEAKERS?.[n]?.id ?? (n === 0 ? 'L' : 'R');

  return {
    /** Un paquet du worklet. `tStart`/`tEnd` en secondes d'audio. */
    push({ tStart, tEnd, rmsL, rmsR }) {
      const dur = Math.max(0, (tEnd ?? tStart) - tStart);
      chunks.push({ t0: tStart, t1: tEnd ?? tStart, eL: rmsL * rmsL * dur, eR: rmsR * rmsR * dur });
      newest = Math.max(newest, tEnd ?? tStart);
      const cutoff = newest - (cfg.ENERGY_WINDOW_S ?? 30);
      // Purge amortie : on ne recompacte pas à chaque paquet.
      if (chunks.length > 64 && chunks[0].t1 < cutoff) {
        chunks = chunks.filter((c) => c.t1 >= cutoff);
      }
    },

    /**
     * @returns 'L' | 'R' | null (indécis : au-dessous du ratio, ou hors fenêtre)
     */
    speakerOf(startAudio, endAudio) {
      if (typeof startAudio !== 'number' && typeof endAudio !== 'number') return null;
      const a = typeof startAudio === 'number' ? startAudio : endAudio;
      const b = typeof endAudio === 'number' ? endAudio : startAudio;
      const from = Math.min(a, b), to = Math.max(a, b);

      let eL = 0, eR = 0;
      for (const c of chunks) {
        if (c.t1 <= from || c.t0 >= to) continue;   // hors de l'énoncé
        eL += c.eL;
        eR += c.eR;
      }
      if (eL === 0 && eR === 0) return null;        // aucune énergie mémorisée
      const ratio = cfg.SPEAKER_MIN_RATIO ?? 1.6;
      if (eL > eR * ratio) return idOf(0);
      if (eR > eL * ratio) return idOf(1);
      return null;
    },

    /** Pour la régie : le niveau relatif instantané, en % (0 = G, 100 = D). */
    balance() {
      const tail = chunks.slice(-8);
      let eL = 0, eR = 0;
      for (const c of tail) { eL += c.eL; eR += c.eR; }
      if (eL + eR === 0) return 50;
      return Math.round((eR / (eL + eR)) * 100);
    },

    reset() { chunks = []; newest = 0; },
  };
}
