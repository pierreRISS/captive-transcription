// Serveur local minimal. Trois raisons d'exister, aucune de plus :
//
//  1. getUserMedia() et la File System Access API exigent un "secure context".
//     file:// n'en est pas un ; http://localhost en est un.
//  2. Il sert la clé Gladia depuis .env sans l'écrire dans le code.
//  3. Il relaie les appels de traduction vers l'API Claude, pour que la clé
//     Anthropic ne descende jamais dans le navigateur.
//
//   node server.mjs      puis    http://localhost:8123
//
// L'appel POST /v2/live vers Gladia est fait DIRECTEMENT par le navigateur :
// CORS y renvoie `access-control-allow-origin: *`, aucun proxy nécessaire.

import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const STARTED = Date.now();

// --- .env ------------------------------------------------------------------
const env = {};
try {
  const raw = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  console.error('!! .env introuvable — créez-le avec GLADIA_API_KEY=... et ANTHROPIC_API_KEY=...');
}

const PORT = Number(env.PORT || 8123);
const GLADIA_KEY = env.GLADIA_API_KEY || '';
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || '';
if (!GLADIA_KEY) console.error('!! GLADIA_API_KEY absente de .env');
if (!ANTHROPIC_KEY) console.error('!! ANTHROPIC_API_KEY absente de .env — la traduction ne marchera pas');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Liste blanche : fichiers exacts + tout .js sous src/ et config/. Surtout,
// .env n'est JAMAIS servi (il contient les deux clés).
const SERVED_FILES = new Set([
  '/operator.html', '/display.html', '/pcm-worklet.js',
]);
const SERVED_PREFIXES = ['/src/', '/config/'];
// Alias de confort : /operator et /display, comme dans la spec.
const ALIASES = { '/': '/operator.html', '/operator': '/operator.html', '/display': '/display.html' };

function isServed(p) {
  if (SERVED_FILES.has(p)) return true;
  return SERVED_PREFIXES.some((pre) => p.startsWith(pre)) && p.endsWith('.js') && !p.includes('..');
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((ok, ko) => {
  let n = 0; const parts = [];
  req.on('data', (c) => {
    n += c.length;
    if (n > 1_000_000) { ko(new Error('corps trop volumineux')); req.destroy(); return; }
    parts.push(c);
  });
  req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
  req.on('error', ko);
});

// ---------------------------------------------------------------------------
//  MODE FICHIER : les surtitres dans des .txt, pour OBS.
//
//  OBS ne sait pas recevoir du texte en direct ; sa source « Texte (GDI+) »
//  sait en revanche relire un fichier en boucle. On lui en donne un PAR LANGUE,
//  à un chemin FIXE : c'est le serveur qui écrit, pas le navigateur — la File
//  System Access API redemanderait un fichier à chaque session, et OBS a besoin
//  d'un chemin qui ne change jamais.
//
//  Les fichiers sont créés vides au démarrage du serveur : on doit pouvoir les
//  désigner dans OBS AVANT le spectacle, pas seulement une fois le son lancé.
//
//  Écriture atomique (fichier temporaire + rename) : OBS relit en permanence,
//  et une écriture en place le ferait tomber, tôt ou tard, sur un fichier
//  tronqué — un surtitre à moitié effacé, en public.
// ---------------------------------------------------------------------------
const CAPTION_DIR = join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'captive-transcription');
const CAPTION_LANGS = ['fr', 'en'];
const captionFile = (lang) => join(CAPTION_DIR, `surtitres-${lang}.txt`);
const captionPaths = () => Object.fromEntries(CAPTION_LANGS.map((l) => [l, captionFile(l)]));
// Un surtitre, ce sont deux lignes : au-delà, c'est un fichier qui part en
// vrille, pas un sous-titre. Le tampon côté régie plafonne déjà, ceci est la
// ceinture de sécurité côté serveur.
const CAPTION_MAX_CHARS = 2000;

let captionSeq = 0;
async function captionWrite(lang, text) {
  const clean = String(text).replace(/\r/g, '').slice(0, CAPTION_MAX_CHARS);
  const dst = captionFile(lang);
  const tmp = `${dst}.${process.pid}.${captionSeq++}.tmp`;
  await writeFile(tmp, clean, 'utf8');
  await rename(tmp, dst);   // atomique : OBS lit l'ancien OU le nouveau, jamais un mélange
}

function captionInit() {
  try {
    mkdirSync(CAPTION_DIR, { recursive: true });
    for (const l of CAPTION_LANGS) writeFileSync(captionFile(l), '');
  } catch (e) {
    console.error('!! fichiers de surtitres indisponibles :', e.message);
  }
}

// À l'arrêt, on vide : sinon la dernière phrase du spectacle reste incrustée
// dans OBS jusqu'au prochain lancement.
function captionBlank() {
  for (const l of CAPTION_LANGS) { try { writeFileSync(captionFile(l), ''); } catch {} }
}

// ---------------------------------------------------------------------------
//  Traduction FR → EN, un bloc à la fois.
//
//  Modèle rapide (Haiku) : budget cible < 500 ms. Pas de `thinking` ni
//  d'`effort` — les deux échouent ou sont inutiles sur Haiku 4.5, et on ne
//  veut surtout pas de réflexion qui rallongerait la latence.
//  Pas de cache_control non plus : le prompt système est très en dessous du
//  minimum cachable de Haiku (4096 tokens), ce serait silencieusement inutile.
// ---------------------------------------------------------------------------
//  La direction n'est PAS fixée : les deux locuteurs peuvent parler français ou
//  anglais, Gladia détecte, et on traduit vers l'autre langue. Le sens arrive
//  donc dans la requête, il n'est pas câblé ici.
const LANG_NAMES = { fr: 'français', en: 'anglais' };
const langName = (c) => LANG_NAMES[c] || c;
// Liste blanche : le sens de traduction vient du client, on ne le recopie pas
// tel quel dans un prompt.
const LANGS = new Set(['fr', 'en']);
const safeLang = (v, fallback) => {
  const s = String(v ?? '').toLowerCase().slice(0, 2);
  return LANGS.has(s) ? s : fallback;
};

// Le lexique vient du navigateur et finit dans un prompt : on le nettoie ici.
// Ce sont des noms propres, donc on écarte tout ce qui n'en a pas la forme —
// retours à la ligne (qui casseraient la structure du prompt), longueurs
// aberrantes, listes interminables.
const MAX_VOCAB = 60;
const safeVocabulary = (v) => (Array.isArray(v) ? v : [])
  .map((w) => String(w ?? '').replace(/[\r\n]+/g, ' ').trim())
  .filter((w) => w !== '' && w.length <= 40)
  .slice(0, MAX_VOCAB);

// Prompt système. Court exprès : il part à chaque bloc, sur un modèle choisi
// pour sa vitesse. Pas de cache_control — le prompt est très en dessous du
// minimum cachable de Haiku, la directive serait silencieusement inutile.
const systemPrompt = (source, target, vocabulary = []) => {
  // Sans cette ligne, un nom de marque est traduit comme un mot ordinaire :
  // « Captivea » ressort en « Captive A », « Odoo » en « Odo ».
  const lex = vocabulary.length > 0
    ? `\n- Noms propres à recopier TELS QUELS, sans traduire ni réécrire : ${vocabulary.join(', ')}.`
    : '';
  return `Tu traduis en direct des surtitres de spectacle, du ${langName(source)} vers le ${langName(target)}.

Règles :
- Traduis UNIQUEMENT le nouveau segment. Ne répète pas le contexte.
- C'est un fragment, pas une phrase complète. N'ajoute pas de ponctuation
  finale et ne complète pas la phrase par ce que tu supposes venir après.
- Garde le registre et le ton (oral, familier si le source l'est).${lex}
- Réponds uniquement par la traduction, sans guillemets ni commentaire.`;
};

function userPrompt(text, context, source, target) {
  const S = source.toUpperCase(), T = target.toUpperCase();
  const lines = [];
  if (context.length > 0) {
    lines.push('Contexte des segments précédents :');
    for (const c of context) lines.push(`${S}: ${c.source} | ${T}: ${c.target}`);
    lines.push('', 'Segment à traduire (suite directe du précédent) :');
  } else {
    lines.push('Segment à traduire :');
  }
  lines.push(`${S}: ${text}`);
  return lines.join('\n');
}

// Erreur RÉSEAU (socket, DNS, TLS), par opposition à une réponse HTTP d'erreur.
// undici la présente sous un message opaque : « fetch failed ».
const isNetworkError = (e) => e?.name === 'TypeError' || /fetch failed/i.test(e?.message ?? '');

async function attemptAnthropic(text, context, model, source, target, vocabulary) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      system: systemPrompt(source, target, vocabulary),
      messages: [{ role: 'user', content: userPrompt(text, context, source, target) }],
    }),
    // Garde-fou côté serveur : le client abandonne avant, on ne garde pas la
    // socket ouverte plus longtemps.
    signal: AbortSignal.timeout(5000),
  });

  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/**
 * Un appel, plus UN retry sur erreur réseau uniquement.
 *
 * Pourquoi : quand la file de traduction abandonne un bloc (timeout côté
 * navigateur), la connexion sortante reste dans un état inutilisable et les
 * appels SUIVANTS échouent instantanément — reproduit : un abandon à 3002 ms,
 * puis cinq « fetch failed » d'affilée en ~260 ms chacun. Sans ce retry, un seul
 * bloc lent faisait perdre les cinq suivants, soit cinq TROUS dans les
 * surtitres. La nouvelle tentative ouvre une connexion neuve.
 *
 * On ne retente PAS une erreur HTTP (4xx/5xx d'Anthropic : ça recommencerait),
 * ni si le client est déjà parti (ce serait des tokens brûlés pour rien).
 */
async function translate(text, context, model, source = 'fr', target = 'en',
                         vocabulary = [], isGone = () => false) {
  let j;
  try {
    j = await attemptAnthropic(text, context, model, source, target, vocabulary);
  } catch (e) {
    if (!isNetworkError(e) || isGone()) throw e;
    console.error('traduction : erreur réseau, connexion neuve et 2e essai —', e.message);
    j = await attemptAnthropic(text, context, model, source, target, vocabulary);
  }

  // Claude 4+ peut refuser : on renvoie un vide, le pipeline abandonne le bloc
  // plutôt que de bloquer la file.
  if (j.stop_reason === 'refusal') return { translation: '', refused: true };

  const block = (j.content || []).find((b) => b.type === 'text');
  return {
    translation: String(block?.text ?? '').trim(),
    usage: j.usage,
    model: j.model,
  };
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = ALIASES[url.pathname] || url.pathname;

  if (p === '/api/health') {
    return json(res, 200, {
      app: 'surtitres-live',
      // Le lanceur de bureau s'en sert pour savoir si le serveur qu'il a laissé
      // chaud est plus VIEUX que les fichiers du projet — auquel cas il le
      // relance, sans quoi un clic sur l'icône servirait l'ancienne version.
      startedAt: STARTED,
      gladia: !!GLADIA_KEY,
      anthropic: !!ANTHROPIC_KEY,
      captions: captionPaths(),
    });
  }

  if (p === '/api/key') {
    return json(res, 200, { key: GLADIA_KEY });
  }

  if (p === '/api/captions') {
    if (req.method === 'GET') {
      return json(res, 200, { dir: CAPTION_DIR, files: captionPaths() });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET ou POST attendu' });
    try {
      const body = JSON.parse(await readBody(req));
      const written = [];
      // Liste blanche de langues : le corps vient du navigateur, il ne choisit
      // pas où on écrit.
      for (const lang of CAPTION_LANGS) {
        if (typeof body[lang] !== 'string') continue;
        await captionWrite(lang, body[lang]);
        written.push(lang);
      }
      return json(res, 200, { written, files: captionPaths() });
    } catch (e) {
      console.error('surtitres fichier :', e.message);
      return json(res, 500, { error: String(e.message).slice(0, 300) });
    }
  }

  if (p === '/api/translate') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST attendu' });
    if (!ANTHROPIC_KEY) return json(res, 503, { error: 'ANTHROPIC_API_KEY absente de .env' });
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'texte vide' });
      const context = Array.isArray(body.context) ? body.context.slice(-4) : [];
      const source = safeLang(body.source, 'fr');
      const target = safeLang(body.target, source === 'fr' ? 'en' : 'fr');
      const vocabulary = safeVocabulary(body.vocabulary);
      const out = await translate(text, context, body.model || 'claude-haiku-4-5',
                                  source, target, vocabulary,
                                  () => req.destroyed || res.writableEnded);
      return json(res, 200, { ...out, source, target });
    } catch (e) {
      // Un échec de traduction n'est pas une erreur serveur fatale : la régie
      // le verra dans son journal et le bloc sera abandonné.
      console.error('traduction :', e.message);
      return json(res, 502, { error: String(e.message).slice(0, 300) });
    }
  }

  if (!isServed(p)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 ' + p);
  }

  const file = resolve(join(ROOT, p));
  if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',   // on veut voir ses modifs au rechargement
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + p);
  }
});

// Le port retenu est écrit ici pour que le lanceur de bureau sache où ouvrir.
const PORT_FILE = join(process.env.XDG_RUNTIME_DIR || '/tmp', 'captive-transcription.port');
const MAX_TRIES = 10;

function listen(port, tries = 0) {
  // Les deux écouteurs vont par paire et se retirent mutuellement : un listen()
  // raté ne doit PAS laisser son callback de succès abonné, sinon le listen
  // suivant qui réussit les déclenche tous et annonce des ports erronés.
  const onError = (e) => {
    server.off('listening', onOk);
    if (e.code === 'EADDRINUSE' && tries < MAX_TRIES - 1) {
      console.log(`  port ${port} occupé, essai sur ${port + 1}…`);
      return listen(port + 1, tries + 1);
    }
    console.error('\n!! Serveur :', e.code === 'EADDRINUSE'
      ? `aucun port libre entre ${PORT} et ${PORT + MAX_TRIES - 1}. Changez PORT dans .env.`
      : e.message, '\n');
    process.exit(1);
  };

  const onOk = async () => {
    server.off('error', onError);
    try { await writeFile(PORT_FILE, String(port)); } catch {}
    console.log(`\n  Régie      :  http://localhost:${port}/operator`);
    console.log(`  Affichage  :  http://localhost:${port}/display`);
    console.log(`  Surtitres  :  ${CAPTION_DIR}/surtitres-{fr,en}.txt  (mode fichier OBS)`);
    console.log(`  Gladia : ${GLADIA_KEY ? GLADIA_KEY.slice(0, 12) + '…' : 'ABSENTE'}`);
    console.log(`  Anthropic : ${ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0, 14) + '…' : 'ABSENTE'}\n`);
  };

  server.once('error', onError);
  server.once('listening', onOk);
  server.listen(port, '127.0.0.1');
}

const cleanup = () => { try { unlinkSync(PORT_FILE); } catch {} captionBlank(); };
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}

captionInit();
listen(PORT);
