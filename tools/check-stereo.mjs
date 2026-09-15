// ---------------------------------------------------------------------------
//  « Les deux canaux sont identiques : ça vient de mon PC ou du logiciel ? »
//
//  Ce script répond à cette question, et c'est sa seule raison d'être. Il fait
//  EXACTEMENT la même mesure que la régie (src/stereo.js, partagé), mais HORS du
//  navigateur : on enregistre directement depuis le système, sans Chrome, sans
//  getUserMedia, sans AudioWorklet. Ensuite on compare les deux verdicts :
//
//     ce script          la régie (pastille « Stéréo »)   → conclusion
//     ─────────────────────────────────────────────────────────────────────────
//     STÉRÉO OK          STÉRÉO OK                        tout va bien
//     STÉRÉO OK          CANAUX IDENTIQUES                → c'est LE LOGICIEL
//                                                           (Chrome down-mixe :
//                                                            voir §Chrome plus bas)
//     CANAUX IDENTIQUES  CANAUX IDENTIQUES                → c'est LE PC
//                                                           (carte son, câble,
//                                                            réglage PipeWire)
//     CANAUX IDENTIQUES  STÉRÉO OK                        impossible en pratique ;
//                                                           deux entrées différentes
//                                                           ont été comparées.
//
//  Usage :
//     node tools/check-stereo.mjs                    # entrée par défaut, 6 s
//     node tools/check-stereo.mjs --list             # les entrées disponibles
//     node tools/check-stereo.mjs --device <nom> --seconds 10
//     node tools/check-stereo.mjs --file spectacle.wav   # un enregistrement déjà fait
//
//  Le mode --file est le plus fiable de tous : le WAV que la régie écrit est
//  stéréo, donc on peut vérifier APRÈS COUP qu'une répétition avait bien deux
//  canaux — sans rien rebrancher.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CONFIG } = await import(join(ROOT, 'config/surtitles.js'));
const { analyseInterleaved } = await import(join(ROOT, 'src/stereo.js'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const RATE = Number(opt('--rate', CONFIG.CAPTURE_RATE || 48000));
const SECONDS = Number(opt('--seconds', 6));
const DEVICE = opt('--device', '');

const sh = (cmd, args) => new Promise((ok) => {
  const p = spawn(cmd, args);
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => ok(null));
  p.on('close', (code) => ok(code === 0 ? out : null));
});

// --- les entrées du système ------------------------------------------------
//
// On lit la CARTE DES CANAUX autant que le nom : une source annoncée `1ch` ou
// `mono` ne pourra jamais séparer deux locuteurs, et c'est déjà une réponse.
async function listSources() {
  const raw = await sh('pactl', ['list', 'sources']);
  if (!raw) return [];
  const out = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^Source #(\d+)/);
    if (m) { cur = { index: m[1] }; out.push(cur); continue; }
    if (!cur) continue;
    const kv = line.match(/^\s+([A-Za-z ]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === 'Name') cur.name = v;
    else if (k === 'Description') cur.desc = v;
    else if (k === 'Sample Specification') cur.spec = v;
    else if (k === 'Channel Map') cur.map = v;
  }
  return out;
}

function printSources(sources) {
  if (sources.length === 0) {
    console.log('  (pactl indisponible — le système n\'expose pas PulseAudio/PipeWire)');
    return;
  }
  for (const s of sources) {
    const mono = /\bmono\b/.test(s.map || '') || /\b1ch\b/.test(s.spec || '');
    const monitor = /\.monitor$/.test(s.name || '');
    console.log(`  ${mono ? '✗' : monitor ? '·' : '✓'} ${s.desc || s.name}`);
    console.log(`      nom    : ${s.name}`);
    console.log(`      format : ${s.spec}   canaux : ${s.map}`
      + (mono ? '   ← MONO : deux locuteurs impossibles' : '')
      + (monitor ? '   (retour de sortie, pas une entrée micro)' : ''));
  }
}

// --- enregistrement --------------------------------------------------------
//
// parecord d'abord : c'est la même couche que celle que voit le navigateur, donc
// la comparaison est juste. arecord en secours (ALSA direct), utile quand on veut
// justement CONTOURNER PipeWire pour savoir si c'est lui qui remixe.
function record() {
  const useAlsa = flag('--alsa');
  const cmd = useAlsa ? 'arecord' : 'parecord';
  const args = useAlsa
    ? ['-D', DEVICE || 'default', '-f', 'S16_LE', '-c', '2', '-r', String(RATE),
       '-d', String(SECONDS), '-t', 'raw', '-q']
    : ['--format=s16le', '--channels=2', `--rate=${RATE}`, '--raw',
       ...(DEVICE ? [`--device=${DEVICE}`] : [])];

  return new Promise((ok, ko) => {
    const p = spawn(cmd, args);
    const chunks = [];
    let bytes = 0;
    const want = RATE * SECONDS * 4;          // 2 canaux × 16 bits
    p.stdout.on('data', (d) => {
      chunks.push(d);
      bytes += d.length;
      process.stderr.write(`\r  enregistrement… ${(bytes / want * 100).toFixed(0)} %`);
      // parecord ne s'arrête pas tout seul : on coupe à la durée voulue.
      if (bytes >= want) p.kill('SIGINT');
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => ko(new Error(`${cmd} introuvable (${e.code}). `
      + 'Installez pulseaudio-utils (parecord) ou alsa-utils (arecord).')));
    p.on('close', () => {
      process.stderr.write('\r' + ' '.repeat(40) + '\r');
      if (bytes === 0) ko(new Error(`${cmd} n'a rien capté.\n${err.trim().slice(0, 400)}`));
      else ok(Buffer.concat(chunks));
    });
  });
}

// --- lecture d'un WAV existant ---------------------------------------------
//
// On ne suppose pas que `data` est au décalage 44 : les WAV écrits par d'autres
// outils intercalent des morceaux (LIST, fact…). On parcourt les morceaux.
async function readWav(path) {
  const buf = await readFile(path);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF'
      || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} n'est pas un WAV.`);
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
              rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      // Un en-tête provisoire (taille 0xFFFFFFDB, écrit par la régie tant que le
      // fichier n'est pas refermé) ne doit pas faire échouer la lecture.
      const end = Math.min(buf.length, body + size);
      data = buf.subarray(body, end);
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV sans morceau fmt ou data.');
  // La régie écrit du 16 bits, mais on accepte ce que produisent sox, ffmpeg ou
  // un enregistreur de terrain : refuser un fichier pour son format ne dirait
  // rien sur la question posée.
  return { fmt, pcm: toInt16(data, fmt) };
}

/** Ramène n'importe quel PCM entrelacé à de l'Int16 entrelacé. */
function toInt16(data, fmt) {
  const FLOAT = 3;                                   // WAVE_FORMAT_IEEE_FLOAT
  const bytes = fmt.bits >> 3;
  if (fmt.format === FLOAT && fmt.bits === 32) {
    const src = new Float32Array(data.buffer, data.byteOffset, Math.floor(data.length / 4));
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
    }
    return out;
  }
  if (fmt.bits === 16) {
    // `subarray` peut tomber sur un décalage impair : Int16Array l'interdit.
    const aligned = data.byteOffset % 2 === 0 ? data : Buffer.from(data);
    return new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length >> 1);
  }
  if (fmt.bits === 24 || fmt.bits === 32) {
    const n = Math.floor(data.length / bytes);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      // On ne garde que les deux octets de poids fort : la corrélation ne se
      // joue pas dans les bits de bruit.
      out[i] = data.readInt16LE(i * bytes + bytes - 2);
    }
    return out;
  }
  if (fmt.bits === 8) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = (data[i] - 128) << 8;
    return out;
  }
  throw new Error(`WAV en ${fmt.bits} bits (format ${fmt.format}) : non géré.`);
}

// --- verdict ---------------------------------------------------------------
function report(a, rate, origin) {
  const dur = a.frames / rate;
  console.log(`\n  source              : ${origin}`);
  console.log(`  durée analysée      : ${dur.toFixed(1)} s (${a.frames} frames à ${rate} Hz)`);
  console.log(`  niveau RMS gauche   : ${a.rmsL.toFixed(5)}`);
  console.log(`  niveau RMS droite   : ${a.rmsR.toFixed(5)}`);
  console.log(`  corrélation G/D     : ${a.corr === null ? '—' : a.corr.toFixed(5)}`);
  console.log(`  écart max G−D       : ${a.maxDiff.toFixed(6)}`);
  console.log(`  échantillons égaux  : ${(a.identicalRatio * 100).toFixed(2)} %`);

  const quiet = Math.max(a.rmsL, a.rmsR) < (CONFIG.STEREO_MIN_RMS ?? 0.003);
  console.log('');
  if (quiet) {
    console.log('  ⚠ SILENCE — rien d\'exploitable. Le micro est coupé, le mauvais');
    console.log('    périphérique est sélectionné, ou personne n\'a parlé pendant la mesure.');
    console.log('    Reprenez en parlant dans UN SEUL micro du début à la fin.');
    return 'quiet';
  }
  if (a.maxDiff === 0) {
    console.log('  ✗ MONO DUPLIQUÉ — les deux canaux sont identiques échantillon par');
    console.log('    échantillon. Ce n\'est pas une question de seuil : le système');
    console.log('    fournit un seul signal recopié deux fois.');
    return 'duplicated';
  }
  if (a.corr >= (CONFIG.STEREO_IDENTICAL_CORR ?? 0.98)) {
    console.log('  ✗ CANAUX IDENTIQUES — même source sur les deux canaux (au bruit de');
    console.log('    quantification près). L\'attribution des locuteurs est impossible.');
    return 'duplicated';
  }
  if (a.corr >= (CONFIG.STEREO_SUSPECT_CORR ?? 0.9)) {
    console.log('  ⚠ SÉPARATION FAIBLE — les canaux diffèrent, mais très peu.');
    console.log('    Soit les deux micros sont côte à côte, soit l\'un des deux ne capte');
    console.log('    presque rien. Écartez-les et refaites la mesure.');
    return 'suspect';
  }
  const ratio = a.rmsL > a.rmsR ? a.rmsL / a.rmsR : a.rmsR / a.rmsL;
  console.log('  ✓ STÉRÉO RÉELLE — deux signaux distincts sur les deux canaux.');
  console.log(`    Déséquilibre de niveau : ×${ratio.toFixed(2)} `
    + `(${a.rmsL > a.rmsR ? 'gauche' : 'droite'} domine).`);
  if (ratio < (CONFIG.SPEAKER_MIN_RATIO ?? 1.6)) {
    console.log(`    ⚠ Ce déséquilibre est sous SPEAKER_MIN_RATIO (${CONFIG.SPEAKER_MIN_RATIO}).`);
    console.log('      Les canaux sont bien distincts, mais si une seule personne parlait');
    console.log('      pendant la mesure, son micro devrait dominer plus franchement —');
    console.log('      sinon l\'attribution restera indécise et gardera le locuteur précédent.');
  }
  return 'ok';
}

function conclusion(state) {
  console.log('\n  ───────────────────────────────────────────────────────────────────');
  console.log('  MAINTENANT, COMPAREZ avec la régie : démarrez la session, parlez, et');
  console.log('  lisez la pastille « Stéréo » en haut de http://localhost:8123/operator');
  console.log('  (le bouton « Diagnostic stéréo » en imprime les mêmes chiffres).');
  console.log('');
  if (state === 'ok') {
    console.log('   • régie « STÉRÉO OK »            → tout est en ordre.');
    console.log('   • régie « CANAUX IDENTIQUES »    → LE PROBLÈME EST LOGICIEL : le');
    console.log('     système sépare bien, c\'est le navigateur qui remixe. Vérifiez que');
    console.log('     l\'entrée choisie dans la liste de la régie est bien celle-ci, puis');
    console.log('     voir la section « Chrome down-mixe » du README.');
  } else if (state === 'duplicated' || state === 'suspect') {
    console.log('   • la régie dira la même chose → LE PROBLÈME EST DANS LE PC, en amont');
    console.log('     du navigateur. Rien à corriger dans le logiciel. Dans l\'ordre :');
    console.log('       1. `node tools/check-stereo.mjs --list` : l\'entrée est-elle');
    console.log('          annoncée en 2 canaux ? Une source `mono` ne séparera jamais.');
    console.log('       2. Le câble : une prise jack TRS 3 points ne transporte qu\'UNE');
    console.log('          voie de micro. Il faut deux entrées physiques (interface audio,');
    console.log('          ou une entrée ligne stéréo alimentée par deux récepteurs).');
    console.log('       3. Le récepteur du micro sans fil : s\'il sort les deux capsules');
    console.log('          « mixées » (mode MONO / MIX), il faut le passer en mode où');
    console.log('          chaque capsule a sa sortie (souvent « STEREO » ou « DUAL »).');
    console.log('       4. `node tools/check-stereo.mjs --alsa --device hw:0,0` :');
    console.log('          contourne PipeWire. Si c\'est stéréo par ALSA mais mono par');
    console.log('          parecord, c\'est le profil PipeWire/Pulse qu\'il faut changer.');
  }
}

// ---------------------------------------------------------------------------
console.log('\n  Contrôle de la séparation stéréo — même mesure que la régie, hors navigateur\n');

if (flag('--list') || flag('-l')) {
  console.log('  Entrées audio du système :\n');
  printSources(await listSources());
  console.log('\n  Relancez avec  --device <nom>  pour en mesurer une en particulier.\n');
  process.exit(0);
}

try {
  let a, rate, origin;
  const file = opt('--file', '');
  if (file) {
    const { fmt, pcm: all } = await readWav(file);
    rate = fmt.rate;
    origin = `${file} (${fmt.channels} canaux, ${fmt.bits} bits, ${fmt.rate} Hz)`;
    if (fmt.channels < 2) {
      console.log(`\n  ✗ ${file} est MONO (${fmt.channels} canal) : il n'y a rien à séparer.`);
      console.log('    Si c\'est un enregistrement de la régie, la session a tourné avec');
      console.log('    TWO_SPEAKERS désactivé ou sur une entrée mono.\n');
      process.exit(1);
    }
    // Un WAV multicanal : on ne regarde que les deux premiers canaux.
    let pcm = all;
    if (fmt.channels > 2) {
      const n = Math.floor(pcm.length / fmt.channels);
      const two = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        two[i * 2] = pcm[i * fmt.channels];
        two[i * 2 + 1] = pcm[i * fmt.channels + 1];
      }
      pcm = two;
    }
    a = analyseInterleaved(pcm, CONFIG);
  } else {
    const sources = await listSources();
    const chosen = DEVICE ? sources.find((s) => s.name === DEVICE) : null;
    if (DEVICE && !chosen && !flag('--alsa')) {
      console.log(`  ⚠ « ${DEVICE} » n'est pas dans la liste de pactl — on essaie quand même.`);
    }
    if (chosen) console.log(`  entrée : ${chosen.desc}\n          ${chosen.map}`);
    else if (!DEVICE) console.log('  entrée : celle par défaut du système (--list pour les autres)');
    console.log(`\n  PARLEZ DANS UN SEUL MICRO pendant ${SECONDS} s — c'est ce déséquilibre`);
    console.log('  qui prouve la séparation. Deux silences sont toujours « identiques ».\n');
    const buf = await record();
    rate = RATE;
    origin = (flag('--alsa') ? 'arecord ' : 'parecord ') + (DEVICE || 'défaut');
    a = analyseInterleaved(new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1), CONFIG);
  }

  const state = report(a, rate, origin);
  if (state !== 'quiet') conclusion(state);
  console.log('');
  process.exit(state === 'ok' ? 0 : 1);
} catch (e) {
  console.error('\n  !! ' + e.message + '\n');
  process.exit(2);
}
