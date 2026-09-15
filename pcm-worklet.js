// AudioWorklet : DEUX micros sur les deux canaux d'une seule entrée stéréo.
//
// Chaque paquet de CHUNK_MS produit trois choses :
//   - `mix`    : la somme des deux canaux, en PCM16 mono → c'est ce qui part
//                chez Gladia (le plan ne permet qu'UNE session live) ;
//   - `stereo` : les deux canaux entrelacés, en PCM16 → c'est ce qui va sur le
//                disque, pour ne pas perdre la séparation des voix ;
//   - l'ÉNERGIE de chaque canal (RMS + crête) et la date du paquet en secondes
//     d'audio → c'est ce qui permet d'attribuer chaque énoncé au bon locuteur.
//
// La date est comptée en frames traitées depuis le démarrage, exactement comme
// Gladia compte les secondes depuis son premier octet reçu : les deux horloges
// sont donc la même, à un paquet près.

function f2i(s) {
  if (s > 1) s = 1; else if (s < -1) s = -1;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

class PcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.rate = o.sampleRate || sampleRate;
    this.frames = Math.max(128, Math.round((this.rate * o.chunkMs) / 1000));
    // Canal de chaque locuteur. Mono (un seul micro) : les deux pointent sur 0.
    this.chL = o.channelL | 0;
    this.chR = o.channelR == null ? (o.channelL | 0) : (o.channelR | 0);
    this.stereo = !!o.stereo;

    this.bufL = new Float32Array(this.frames);
    this.bufR = new Float32Array(this.frames);
    this.n = 0;
    this.elapsed = 0;          // frames traitées depuis le démarrage
    this.reset();

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if ('channelL' in e.data) this.chL = e.data.channelL | 0;
      if ('channelR' in e.data) this.chR = e.data.channelR | 0;
      // Vidange du reliquat à l'arrêt : sans ça les derniers CHUNK_MS d'audio
      // n'atteignent jamais le disque.
      if (e.data.flush && this.n > 0) this.flush();
    };
  }

  reset() {
    this.peakL = 0; this.peakR = 0;
    this.sumL = 0; this.sumR = 0;
    // Produit croisé et écart maximum : de quoi calculer la corrélation des deux
    // canaux en aval (src/stereo.js). C'est ce qui détecte une entrée « stéréo »
    // qui n'est en fait qu'un canal dupliqué — cas où l'attribution des
    // locuteurs devient un tirage au sort sans que rien d'autre ne le montre.
    this.sumLR = 0;
    this.maxDiff = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const srcL = input[this.chL] || input[0];
    const srcR = input[this.chR] || input[0];
    if (!srcL) return true;

    for (let i = 0; i < srcL.length; i++) {
      const l = srcL[i], r = srcR ? srcR[i] : 0;
      this.bufL[this.n] = l;
      this.bufR[this.n] = r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > this.peakL) this.peakL = al;
      if (ar > this.peakR) this.peakR = ar;
      this.sumL += l * l;
      this.sumR += r * r;
      this.sumLR += l * r;
      const d = l > r ? l - r : r - l;
      if (d > this.maxDiff) this.maxDiff = d;
      if (++this.n === this.frames) this.flush();
    }
    return true;
  }

  flush() {
    const n = this.n;
    const tStart = this.elapsed / this.rate;      // secondes d'audio
    this.elapsed += n;

    // Somme mono pour Gladia. /2 pour ne pas saturer quand les deux parlent.
    const mix = new Int16Array(n);
    for (let i = 0; i < n; i++) mix[i] = f2i((this.bufL[i] + this.bufR[i]) / 2);

    const transfer = [mix.buffer];
    let stereo = null;
    if (this.stereo) {
      stereo = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        stereo[i * 2] = f2i(this.bufL[i]);
        stereo[i * 2 + 1] = f2i(this.bufR[i]);
      }
      transfer.push(stereo.buffer);
    }

    this.port.postMessage({
      mix, stereo, frames: n, tStart, tEnd: this.elapsed / this.rate,
      peakL: this.peakL, peakR: this.peakR,
      // RMS : c'est l'énergie qui décide du locuteur, pas la crête (une crête
      // isolée peut venir d'un choc sur le pied de micro).
      rmsL: Math.sqrt(this.sumL / n), rmsR: Math.sqrt(this.sumR / n),
      // Sommes BRUTES, non normalisées : elles doivent être cumulables sur
      // plusieurs paquets pour donner une corrélation stable (src/stereo.js).
      sumLL: this.sumL, sumRR: this.sumR, sumLR: this.sumLR,
      maxDiff: this.maxDiff,
    }, transfer);

    this.n = 0;
    this.reset();
  }
}

registerProcessor('pcm-chunker', PcmChunker);
