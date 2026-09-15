// ---------------------------------------------------------------------------
//  Les deux canaux portent-ils VRAIMENT deux signaux différents ?
//
//  Toute l'attribution des locuteurs (src/speakers.js) repose sur cette
//  hypothèse. Si elle est fausse — carte son mono, PipeWire qui remixe, Chrome
//  qui down-mixe — RIEN ne casse : les vumètres bougent, la transcription passe,
//  la traduction sort. Seulement les deux colonnes deviennent un tirage au sort,
//  et personne ne le voit avant le spectacle. D'où cette mesure, en continu.
//
//  Le critère est la CORRÉLATION de Pearson entre les deux canaux, sur les
//  paquets où il y a du signal :
//
//      r = Σ(l·r) / √(Σl² · Σr²)
//
//  r = 1 exactement  → même échantillon dupliqué : mono déguisé en stéréo.
//  r > 0,98          → même source (un micro repiqué sur les deux canaux, ou
//                      un mixage identique) : l'attribution est impossible.
//  r ≈ 0,3 à 0,8     → deux micros dans la même pièce : la diaphonie corrèle
//                      les canaux, mais chacun garde sa voix dominante. Normal.
//  r < 0,3           → deux sources franchement indépendantes.
//
//  On mesure sur des SOMMES CUMULÉES, pas sur des moyennes de corrélations par
//  paquet : un paquet de 40 ms est trop court pour une corrélation stable, et
//  moyenner des rapports fausserait le résultat.
//
//  `maxDiff` tranche le cas dégénéré sans ambiguïté : si aucun échantillon des
//  deux canaux n'a jamais différé d'un seul bit, ce n'est plus une question de
//  seuil, c'est le même tableau deux fois.
//
//  Aucune dépendance au DOM : tools/check-stereo.mjs fait exactement la même
//  mesure sur un WAV enregistré hors du navigateur, et c'est la comparaison des
//  deux verdicts qui dit si le mono vient du PC ou du logiciel.
// ---------------------------------------------------------------------------

export function createStereoCheck(cfg) {
  let sumLL = 0, sumRR = 0, sumLR = 0;
  let frames = 0;          // frames de SIGNAL retenues (le silence est écarté)
  let maxDiff = 0;
  let rate = cfg.CAPTURE_RATE || 48000;

  return {
    /**
     * Un paquet du worklet. `rmsL`/`rmsR` servent à écarter le silence : deux
     * silences sont parfaitement corrélés et ne prouvent rien.
     */
    push({ frames: n, rmsL, rmsR, sumLL: ll, sumRR: rr, sumLR: lr, maxDiff: md }) {
      if (!n) return;
      if (typeof md === 'number' && md > maxDiff) maxDiff = md;
      const floor = cfg.STEREO_MIN_RMS ?? 0.003;
      // Le canal le plus FORT doit dépasser le plancher : si un seul micro capte
      // (l'autre locuteur se tait), le paquet reste informatif.
      if (Math.max(rmsL ?? 0, rmsR ?? 0) < floor) return;
      sumLL += ll ?? 0;
      sumRR += rr ?? 0;
      sumLR += lr ?? 0;
      frames += n;
    },

    /** Corrélation, ou null tant qu'il n'y a pas assez de signal. */
    correlation() {
      if (sumLL <= 0 || sumRR <= 0) return null;
      const r = sumLR / Math.sqrt(sumLL * sumRR);
      // Les arrondis flottants peuvent sortir de [-1, 1] au millionième.
      return Math.max(-1, Math.min(1, r));
    },

    /** Secondes de signal accumulées. */
    seconds() { return frames / rate; },

    /** Écart maximum entre les deux canaux, sur un échantillon (0 = identiques). */
    maxDiff() { return maxDiff; },

    /**
     * @returns { state, corr, seconds, label, detail }
     *   state : 'waiting' | 'mono' | 'duplicated' | 'suspect' | 'ok'
     *     'mono'       : un seul canal réel dans le flux (dit par l'appelant)
     *     'duplicated' : deux canaux, échantillon pour échantillon identiques
     *     'suspect'    : corrélés au point que l'attribution est ininterprétable
     *     'ok'         : deux signaux distincts
     */
    verdict(channelCount = 2) {
      if (channelCount < 2) {
        return { state: 'mono', corr: null, seconds: this.seconds(),
                 label: 'MONO',
                 detail: 'l\'entrée ne fournit qu\'un canal : aucune séparation possible.' };
      }
      const need = cfg.STEREO_VERDICT_S ?? 3;
      const s = this.seconds();
      const r = this.correlation();
      if (r === null || s < need) {
        return { state: 'waiting', corr: r, seconds: s,
                 label: 'mesure…',
                 detail: `${s.toFixed(1)} s de signal sur ${need} s nécessaires.` };
      }
      if (maxDiff === 0) {
        return { state: 'duplicated', corr: r, seconds: s,
                 label: 'MONO DUPLIQUÉ',
                 detail: 'les deux canaux sont identiques échantillon par échantillon.' };
      }
      if (r >= (cfg.STEREO_IDENTICAL_CORR ?? 0.98)) {
        return { state: 'duplicated', corr: r, seconds: s,
                 label: 'CANAUX IDENTIQUES',
                 detail: `corrélation ${r.toFixed(4)} : c'est la même source sur les deux canaux.` };
      }
      if (r >= (cfg.STEREO_SUSPECT_CORR ?? 0.9)) {
        return { state: 'suspect', corr: r, seconds: s,
                 label: 'SÉPARATION FAIBLE',
                 detail: `corrélation ${r.toFixed(4)} : très proche. Écartez les micros `
                       + 'ou vérifiez que ce ne sont pas deux repiquages du même signal.' };
      }
      return { state: 'ok', corr: r, seconds: s,
               label: 'STÉRÉO OK',
               detail: `corrélation ${r.toFixed(4)} sur ${s.toFixed(1)} s de signal.` };
    },

    reset(newRate) {
      sumLL = sumRR = sumLR = 0;
      frames = 0;
      maxDiff = 0;
      if (newRate) rate = newRate;
    },
  };
}

/**
 * La même mesure sur du PCM 16 bits entrelacé — c'est ce que produit
 * `parecord`/`arecord`, donc ce que lit tools/check-stereo.mjs. Séparé du
 * cumulateur ci-dessus parce qu'ici on a tout le fichier d'un coup.
 *
 * @param pcm  Int16Array entrelacé L,R,L,R…
 */
export function analyseInterleaved(pcm, cfg = {}) {
  let sumLL = 0, sumRR = 0, sumLR = 0, maxDiff = 0, identical = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const l = pcm[i * 2] / 32768, r = pcm[i * 2 + 1] / 32768;
    sumLL += l * l;
    sumRR += r * r;
    sumLR += l * r;
    const d = Math.abs(l - r);
    if (d > maxDiff) maxDiff = d;
    if (pcm[i * 2] === pcm[i * 2 + 1]) identical++;
  }
  const corr = sumLL > 0 && sumRR > 0 ? sumLR / Math.sqrt(sumLL * sumRR) : null;
  return {
    frames: n,
    rmsL: Math.sqrt(sumLL / (n || 1)),
    rmsR: Math.sqrt(sumRR / (n || 1)),
    corr: corr === null ? null : Math.max(-1, Math.min(1, corr)),
    maxDiff,
    // Proportion d'échantillons rigoureusement égaux. À 100 %, la question du
    // seuil ne se pose plus.
    identicalRatio: n ? identical / n : 0,
  };
}
