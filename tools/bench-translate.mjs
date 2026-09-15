// ---------------------------------------------------------------------------
//  Banc de mesure des modèles de traduction, sur l'API RÉELLE.
//
//  La médiane annoncée par un fournisseur ne sert à rien ici : ce qui fait un
//  trou dans les surtitres, c'est la QUEUE de distribution — le p95 et le max,
//  comparés à TRANSLATION_TIMEOUT_MS. Un modèle à 0,6 s de médiane qui part à
//  4 s une fois sur vingt est pire qu'un modèle à 0,9 s toujours stable.
//
//  Les appels sont SÉQUENTIELS et utilisent les VRAIS prompts
//  (src/translator.js), avec le vrai contexte glissant : c'est la seule mesure
//  qui vaille, un banc parallèle mesurerait une file qui n'existe pas.
//
//    node tools/bench-translate.mjs
//    node tools/bench-translate.mjs --models claude-haiku-4-5,claude-sonnet-5
//    node tools/bench-translate.mjs --runs 2        # 2 passes, pour le p95
//
//  Coût : quelques dixièmes de centime par modèle (24 blocs très courts).
//  Il consomme la clé ANTHROPIC_API_KEY de .env.
// ---------------------------------------------------------------------------
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CONFIG } = await import(join(ROOT, 'config/surtitles.js'));
const { buildSystemPrompt, buildUserPrompt } = await import(join(ROOT, 'src/translator.js'));

// --- .env ------------------------------------------------------------------
const env = {};
for (const line of (await readFile(join(ROOT, '.env'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('ANTHROPIC_API_KEY absente de .env'); process.exit(1); }

// --- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(opt('--runs', 1));

// Tarifs publics, $ par million de tokens. À revérifier avant de décider sur le
// coût : ils changent, la latence beaucoup moins.
const PRICES = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
};

// Le thinking est le piège de ce comparatif : sur Sonnet 5 et Opus 5 il est
// ADAPTATIF PAR DÉFAUT — ne rien passer ferait réfléchir le modèle avant de
// traduire trois mots, et mesurerait une latence qui n'a rien à voir avec
// l'usage réel. On le coupe explicitement.
const THINKING_OFF = new Set(['claude-sonnet-5', 'claude-opus-5']);

const MODELS = String(opt('--models', 'claude-haiku-4-5,claude-sonnet-5,claude-opus-5'))
  .split(',').map((m) => m.trim()).filter(Boolean);

// --- le matériau ------------------------------------------------------------
//
//  Des fragments, pas des phrases : c'est ce que produit le découpage en blocs
//  de 5 à 12 mots. Un banc sur des phrases complètes mesurerait un problème
//  plus facile que le vrai.
const BLOCKS = [
  'Bonsoir à toutes et à tous, merci', 'd\'être venus si nombreux ce soir',
  'On va vous parler de ce qu\'on', 'fait chez Captivea depuis deux ans',
  'et surtout de ce qu\'on a raté', 'parce que c\'est plus intéressant',
  'Sébastien, tu veux commencer ?', 'Oui alors moi je suis arrivé',
  'sur le projet Odoo en janvier', 'et la première chose que j\'ai vue',
  'c\'est qu\'il n\'y avait pas de doc', 'enfin si, il y en avait une',
  'mais personne ne l\'avait lue', 'donc autant dire qu\'elle n\'existait pas',
  'Et là on s\'est posé la question', 'est-ce qu\'on reprend tout à zéro',
  'ou est-ce qu\'on fait avec', 'On a choisi de faire avec',
  'et franchement c\'était une erreur', 'Six mois plus tard on recommençait',
  'mais cette fois on savait pourquoi', 'C\'est ça qui a tout changé',
  'Voilà, c\'est tout ce qu\'on voulait dire', 'Merci beaucoup, bonne soirée',
];

const VOCAB = CONFIG.VOCABULARY ?? [];

// --- un appel ---------------------------------------------------------------
async function callOnce(model, text, context) {
  const body = {
    model,
    max_tokens: 300,
    system: buildSystemPrompt('fr', 'en', VOCAB),
    messages: [{ role: 'user', content: buildUserPrompt(text, context, 'fr', 'en') }],
  };
  if (THINKING_OFF.has(model)) body.thinking = { type: 'disabled' };

  const t0 = performance.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const block = (j.content || []).find((b) => b.type === 'text');
  return {
    ms,
    text: String(block?.text ?? '').trim(),
    refused: j.stop_reason === 'refusal',
    usage: j.usage ?? {},
  };
}

const pct = (xs, p) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// --- une passe complète -----------------------------------------------------
async function bench(model) {
  const lat = [], samples = [];
  // La POSITION du pire appel est décisive : le tout premier paie le DNS et la
  // poignée TLS, ce qui est une propriété de la connexion, pas du modèle — et
  // en spectacle ça n'arrive qu'une fois, avant le lever de rideau.
  let worstAt = -1;
  let inTok = 0, outTok = 0, failed = 0, refused = 0, overBudget = 0;
  const context = [];

  for (let run = 0; run < RUNS; run++) {
    context.length = 0;
    for (const text of BLOCKS) {
      try {
        const r = await callOnce(model, text, context.slice());
        if (lat.length === 0 || r.ms > Math.max(...lat)) worstAt = lat.length + 1;
        lat.push(r.ms);
        inTok += r.usage.input_tokens ?? 0;
        outTok += r.usage.output_tokens ?? 0;
        if (r.refused) refused++;
        // Le seul seuil qui compte : au-delà, la régie jette le bloc.
        if (r.ms > CONFIG.TRANSLATION_TIMEOUT_MS) overBudget++;
        if (r.text) {
          context.push({ source: text, target: r.text });
          while (context.length > CONFIG.CONTEXT_BLOCKS) context.shift();
        }
        if (run === 0 && samples.length < 3) samples.push(`${text}  ⇢  ${r.text}`);
      } catch (e) {
        failed++;
        process.stdout.write(`\n    !! ${e.message}\n`);
      }
    }
  }

  const n = lat.length || 1;
  const price = PRICES[model];
  // Coût d'une heure de spectacle : ~15 blocs/minute (mesuré : 24 blocs pour
  // 187 mots, débit oral ≈ 120 mots/minute).
  const perCall = price ? (inTok / n / 1e6) * price.in + (outTok / n / 1e6) * price.out : null;
  return {
    model,
    calls: lat.length,
    median: pct(lat, 50), p90: pct(lat, 90), p95: pct(lat, 95),
    max: lat.length ? Math.max(...lat) : null,
    worstAt,
    inTok: Math.round(inTok / n), outTok: Math.round(outTok / n),
    failed, refused, overBudget,
    costHour: perCall === null ? null : perCall * 15 * 60,
    samples,
  };
}

// --- sortie -----------------------------------------------------------------
const ms = (x) => (x == null ? '—' : Math.round(x) + ' ms');
const results = [];
for (const m of MODELS) {
  process.stdout.write(`\n  ${m}  `);
  const r = await bench(m);
  results.push(r);
  process.stdout.write(`${r.calls} appels, médiane ${ms(r.median)}\n`);
  for (const s of r.samples) console.log(`      ${s}`);
}

console.log(`\n\n  Budget de la régie : TRANSLATION_TIMEOUT_MS = ${CONFIG.TRANSLATION_TIMEOUT_MS} ms`
  + `  ·  contexte : ${CONFIG.CONTEXT_BLOCKS} blocs  ·  ${RUNS} passe(s) de ${BLOCKS.length} blocs\n`);
console.log('| modèle | médiane | p90 | p95 | max (appel n°) | > budget | tokens in/out | $/h de spectacle |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.model} | ${ms(r.median)} | ${ms(r.p90)} | ${ms(r.p95)} | ${ms(r.max)} (n°${r.worstAt}) `
    + `| ${r.overBudget}/${r.calls} | ${r.inTok}/${r.outTok} `
    + `| ${r.costHour == null ? '—' : '$' + r.costHour.toFixed(2)} |`);
}
console.log('\n  « > budget » = blocs qui auraient été ABANDONNÉS en spectacle. C\'est la');
console.log('  colonne qui décide, pas la médiane.\n');
