// ---------------------------------------------------------------------------
//  File de traduction STRICTEMENT SÉQUENTIELLE.
//
//  Jamais d'appels parallèles : les blocs reviendraient dans le désordre et il
//  faudrait réordonner l'affichage — donc réécrire du texte déjà affiché, ce
//  que le principe append-only interdit.
//
//  Un trou dans les surtitres est moins grave qu'un décrochage de 5 s : en cas
//  de timeout on retente une fois, puis on abandonne le bloc et on logue.
// ---------------------------------------------------------------------------

export const LANG_NAMES = { fr: 'français', en: 'anglais' };
export const langName = (code) => LANG_NAMES[code] || code;

/**
 * Le prompt système. Volontairement court : il part à CHAQUE bloc, sur un modèle
 * choisi pour sa vitesse, et il n'est pas mis en cache (le minimum cachable de
 * Haiku est très au-dessus de cette taille — un `cache_control` ici serait
 * silencieusement inopérant). Chaque ligne ajoutée est de la latence pour tous
 * les blocs du spectacle.
 *
 * `vocabulary` : les noms propres du spectacle. Sans cette consigne, un nom de
 * marque part à la traduction comme un mot ordinaire — « Captivea » ressort en
 * « Captive A », « Odoo » en « Odo ». C'est le seul ajout au prompt qui vaille
 * sa latence, et il n'est présent que si la liste n'est pas vide.
 */
export function buildSystemPrompt(source = 'fr', target = 'en', vocabulary = []) {
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
}

export function buildUserPrompt(current, context, source = 'fr', target = 'en') {
  const S = source.toUpperCase(), T = target.toUpperCase();
  const lines = [];
  if (context.length > 0) {
    lines.push('Contexte des segments précédents :');
    for (const c of context) lines.push(`${S}: ${c.source} | ${T}: ${c.target}`);
    lines.push('');
    lines.push('Segment à traduire (suite directe du précédent) :');
  } else {
    lines.push('Segment à traduire :');
  }
  lines.push(`${S}: ${current}`);
  return lines.join('\n');
}

/**
 * `translate` : (text, context, signal) => Promise<string>. Injecté pour que
 * le harnais de test puisse tourner sans réseau.
 */
export function createTranslator(cfg, { translate, onResult, onError, clock = Date }) {
  const queue = [];
  // Un contexte glissant PAR locuteur et par direction. Mélanger les deux
  // locuteurs donnerait à Claude le fil de l'autre voix comme s'il s'agissait de
  // la même phrase — et un contexte français pour une phrase anglaise.
  const contexts = new Map();
  let running = false;
  const stats = { done: 0, failed: 0, merged: 0, latencies: [] };

  const laneOf = (b) => `${b.speaker ?? '-'}:${b.source ?? '?'}>${b.targetLang ?? '?'}`;
  const contextOf = (b) => {
    const k = laneOf(b);
    if (!contexts.has(k)) contexts.set(k, []);
    return contexts.get(k);
  };

  function pushContext(block, target) {
    const ctx = contextOf(block);
    ctx.push({ source: block.text, target });
    while (ctx.length > cfg.CONTEXT_BLOCKS) ctx.shift();
  }

  // Anti-accumulation : si plus de MAX_PENDING_BLOCKS attendent, on fusionne
  // les blocs pendants en un seul appel pour rattraper le retard.
  //
  // On ne fusionne QUE des blocs du même locuteur et de la même direction :
  // coller deux voix dans un seul appel produirait une phrase qui n'a jamais été
  // dite, attribuée à une seule colonne.
  function coalesce() {
    if (queue.length <= cfg.MAX_PENDING_BLOCKS) return;
    const lane = laneOf(queue[0]);
    const run = [];
    while (queue.length > 0 && laneOf(queue[0]) === lane) run.push(queue.shift());
    if (run.length < 2) { queue.unshift(...run); return; }
    stats.merged += run.length;
    queue.unshift(Object.freeze({
      ...run[0],
      seq: run[0].seq,
      text: run.map((b) => b.text).join(' '),
      startAudio: run[0].startAudio ?? null,
      endAudio: run[run.length - 1].endAudio,
      reason: 'merged',
      mergedFrom: run.length,
    }));
  }

  // Le timeout est imposé ICI, pas délégué à `translate`. Sinon une
  // implémentation qui ignore le budget bloquerait la file pour toujours — et
  // « ne jamais bloquer la file » est une règle, pas un souhait.
  function withTimeout(promise, ms) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  async function attempt(block) {
    const started = clock.now();
    const text = await withTimeout(
      Promise.resolve(translate(block.text, contextOf(block).slice(), cfg.TRANSLATION_TIMEOUT_MS,
                                { source: block.source, target: block.targetLang,
                                  // Lu dans cfg à chaque bloc : la régie peut
                                  // corriger le lexique en répétition sans
                                  // reconstruire la file.
                                  vocabulary: cfg.VOCABULARY ?? [] })),
      cfg.TRANSLATION_TIMEOUT_MS
    );
    stats.latencies.push(clock.now() - started);
    return text;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        coalesce();
        const block = queue.shift();
        let target = null;
        let lastErr = null;

        for (let tryNo = 0; tryNo <= cfg.TRANSLATION_RETRIES; tryNo++) {
          try {
            target = await attempt(block);
            break;
          } catch (e) {
            lastErr = e;
          }
        }

        if (target == null || target === '') {
          // On abandonne ce bloc plutôt que de bloquer la file.
          stats.failed++;
          onError?.(block, lastErr);
          continue;
        }

        stats.done++;
        pushContext(block, target);
        onResult({ ...block, target });
      }
    } finally {
      running = false;
    }
  }

  return {
    submit(block) {
      queue.push(block);
      pump();
    },
    pending() {
      return queue.length + (running ? 1 : 0);
    },
    stats,
    reset() {
      queue.length = 0;
      contexts.clear();
    },
  };
}

/**
 * Traducteur réel : passe par le serveur local, qui détient la clé API.
 * Timeout dur via AbortController — l'appel ne peut pas dépasser le budget.
 */
export function httpTranslate(endpoint = '/api/translate') {
  return async (text, context, timeoutMs,
                { source = 'fr', target = 'en', vocabulary = [] } = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context, source, target, vocabulary }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`traduction ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return String(j.translation ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  };
}
