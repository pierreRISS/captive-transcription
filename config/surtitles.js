// ---------------------------------------------------------------------------
//  TOUS les seuils du surtitrage. Un seul fichier, réglable en répétition.
//
//  (La spec dit `config/surtitles.ts` — ici c'est `.js` parce que le projet
//  n'a ni build ni dépendance : le navigateur charge ce module tel quel.)
//
//  Principe directeur, non négociable : le texte affiché est APPEND-ONLY.
//  Un mot affiché ne change jamais. On échange de la latence contre de la
//  stabilité — le retard est CONSTANT (DISPLAY_DELAY_MS) et les mots
//  apparaissent un par un, au rythme où ils ont été prononcés.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- Validation (LocalAgreement) ---------------------------------------
  // Un mot est publié quand il apparaît au même endroit dans N partials
  // consécutives. 2 = LocalAgreement-2. Passer à 3 si le taux de divergence
  // validé/final dépasse 5 % (coût : ~300 ms de latence en plus).
  AGREEMENT_N: 2,

  // --- Découpage en blocs -------------------------------------------------
  MIN_WORDS: 5,            // taille mini avant de couper sur un connecteur
  MAX_WORDS: 12,           // taille maxi d'un bloc
  IDLE_FLUSH_MS: 800,      // vide le buffer si plus aucun mot n'arrive

  // AJOUT hors spec §3, imposé par le critère d'acceptation n°4.
  // IDLE_FLUSH_MS ne se déclenche que si la parole S'ARRÊTE. Sur une phrase
  // longue sans ponctuation forte ni connecteur, le buffer attendait MAX_WORDS
  // (≈ 4,6 s de parole) et l'écran restait figé : le harnais mesurait un trou
  // de 6,2 s. On borne donc l'âge d'un bloc, même en parole continue.
  MAX_BLOCK_AGE_MS: 1400,

  // Connecteurs FR : on coupe AVANT, ils ouvrent l'unité de sens suivante.
  CONNECTORS: [
    'et', 'mais', 'donc', 'or', 'car', 'parce', 'puisque', 'quand',
    'lorsque', 'alors', 'si', 'comme', 'qui', 'que', 'dont', 'où',
  ],

  // --- Traduction ---------------------------------------------------------
  //
  //  'gladia' : traduction native de Gladia. Une seule clé API, rien à gérer.
  //             MAIS elle est liée à l'utterance FINALE : le texte n'arrive
  //             qu'en fin de phrase (jusqu'à 5 s de parole d'un coup, borne
  //             dure de l'API). LocalAgreement et le découpage au mot ne
  //             servent alors à rien — on ne peut pas traduire un mot isolé.
  //             L'affichage reste append-only et cadencé.
  //
  //  'claude'  : traduction maison, bloc par bloc, avant la fin de la phrase.
  //             Demande ANTHROPIC_API_KEY. C'est ce que décrit la spec §4, et
  //             la seule façon d'atteindre 2-3 s de latence.
  //
  //  Basculer = changer cette seule ligne.
  TRANSLATION_ENGINE: 'gladia',

  // Moteur 'gladia' : 'base' ou 'enhanced' ('enhanced' = meilleur mais plus lent).
  GLADIA_TRANSLATION_MODEL: 'base',

  // Utilisé uniquement par le moteur 'claude'. Haiku : le plus rapide.
  TRANSLATION_MODEL: 'claude-haiku-4-5',
  // Timeout dur. Mesuré sur l'API réelle (20 appels, bloc de 11 mots) :
  // min 0,65 s · médiane 0,87 s · p90 1,45 s · max 2,97 s.
  //
  // Il est COURT exprès, et c'est contre-intuitif : la file est séquentielle, donc
  // tout le temps passé sur un bloc lent est du retard pour tous les suivants.
  // Essai à 4000 ms avec un retry : les blocs se sont empilés, la fusion s'est
  // déclenchée 13 fois et la latence p95 est montée à 15,6 s. Un trou ponctuel
  // est moins grave qu'un décrochage général — d'autant que la colonne ORIGINALE
  // continue, elle, d'afficher ce qui a été dit.
  TRANSLATION_TIMEOUT_MS: 2500,
  // Zéro retry : réessayer un timeout, c'est bloquer la file deux fois. Les
  // échecs RÉSEAU (connexion empoisonnée) sont déjà repris côté serveur, où le
  // retry est immédiat et n'immobilise pas la file.
  TRANSLATION_RETRIES: 0,
  MAX_PENDING_BLOCKS: 3,          // au-delà, on fusionne pour rattraper
  // Blocs précédents envoyés comme contexte, par locuteur et par direction.
  //
  // 4 et non 2 : un bloc fait 5 à 12 mots, donc 2 blocs ne portaient qu'une
  // dizaine de mots — trop peu pour lever un pronom, un genre ou une reprise
  // (« il » renvoie à quoi ? « the one » à qui ?). Ce sont des tokens d'ENTRÉE,
  // les moins chers et ceux qui pèsent le moins sur la latence : le coût réel
  // d'un appel est le temps de génération, pas la longueur du prompt.
  //
  // Ne pas monter beaucoup plus haut : au-delà, le modèle se met à re-traduire
  // le contexte au lieu du seul nouveau segment, malgré la consigne. Et le
  // serveur tronque à 4 (`context.slice(-4)` dans /api/translate) : au-delà de
  // 4, la valeur ici ne servirait plus à rien sans toucher aussi au serveur.
  CONTEXT_BLOCKS: 4,

  // --- Affichage ------------------------------------------------------------
  //
  //  GRILLE FIXE 2 × 2. Une colonne par LANGUE, une ligne par locuteur :
  //
  //                      FRANÇAIS        ENGLISH
  //      locuteur G       L:fr            L:en
  //      locuteur D       R:fr            R:en
  //
  //  La place est déterminée par la LANGUE, jamais par la provenance. Un
  //  spectateur francophone regarde toujours la même colonne, même si le
  //  locuteur change de langue en cours de route : dans ce cas c'est le contenu
  //  qui change de nature (original au lieu de traduction), pas l'emplacement.
  //  C'est la seule disposition qui permette de savoir où regarder à l'avance.
  //
  //  Les quatre cases sont indépendantes : chacune a sa file et sa cadence. Deux
  //  locuteurs qui parlent EN MÊME TEMPS s'écrivent donc en parallèle, sans que
  //  l'un attende l'autre.
  LANGUAGE_LABELS: { fr: 'Français', en: 'English' },

  //  32 caractères et 4 lignes par case : le texte défile vite, il faut laisser
  //  le temps de lire. Quatre lignes gardent environ 12 à 15 s de parole à
  //  l'écran, au lieu de 5 s avec deux lignes.
  MAX_CHARS_PER_LINE: 32,
  MAX_LINES: 4,

  //  MODE FICHIER (OBS). Les surtitres sont aussi écrits dans un .txt par
  //  langue, qu'une source « Texte (GDI+) » relit en boucle. Deux lignes, pas
  //  quatre : une incrustation vidéo n'a pas la hauteur de l'écran de scène, et
  //  au-delà de deux lignes le texte mange l'image.
  CAPTION_MAX_LINES: 2,
  //  Groupage des écritures. L'écran avance MOT À MOT ; sans ce palier, chaque
  //  mot déclencherait une requête et une réécriture de fichier sous le nez
  //  d'OBS, qui relit en continu. 150 ms reste invisible à l'œil.
  CAPTION_FLUSH_MS: 150,
  // Couleurs de locuteur. Sobres : c'est un repère, pas une décoration. Le même
  // locuteur garde sa couleur dans les DEUX colonnes de langue — c'est ce qui
  // permet de suivre une personne d'une langue à l'autre.
  SPEAKER_COLORS: { L: '#8FD1E6', R: '#E6C88F' },

  // RETARD CONSTANT entre la parole et l'écran, en ms. C'est le cœur de l'étage
  // d'affichage : un mot n'est PAS affiché quand son texte arrive, mais à la
  // date où il a été prononcé + ce retard. Le texte arrive par paquets (une
  // utterance entière), il ressort mot à mot, à la cadence de la voix.
  //
  // Plancher réel en moteur 'gladia' : la traduction n'existe qu'après la fin
  // de l'utterance, donc au mieux MAX_DURATION_WITHOUT_ENDPOINTING (5 s) + le
  // temps de traduction (~0,6 à 1 s). Sous 6000 ms, les premiers mots d'une
  // longue phrase sortent en retard et le rattrapage se voit un peu.
  // En moteur 'claude' (blocs courts), 2500 ms suffisent.
  //
  // Valeur ACTIVE. Elle est écrasée au démarrage par celle du moteur retenu
  // (DISPLAY_DELAY_BY_ENGINE), puis par le curseur de la régie.
  DISPLAY_DELAY_MS: 6000,

  // Le plancher n'est PAS le même selon le moteur, et viser 6 s en moteur
  // 'claude' ferait attendre le public pour rien. Le retard suit donc le moteur.
  //
  //  'gladia' : la traduction n'existe qu'après la fin de l'utterance, donc au
  //             mieux MAX_DURATION_WITHOUT_ENDPOINTING (5 s) + traduction.
  //             Balayage au harnais (mots au-delà de +500 ms de leur cible) :
  //               5000 → 10 mots, pire écart +1300 ms
  //               5500 →  3 mots, pire écart  +799 ms
  //               6000 →  0 mot,  pire écart  +300 ms   ← retenu
  //               6500 →  0 mot,  pire écart    +1 ms
  //
  //  'claude'  : blocs de 5 à 12 mots traduits à la volée. Le plancher est la
  //             somme des étapes : reconnaissance (~0,45 s) + validation
  //             LocalAgreement (~0,4 s) + âge maxi d'un bloc (MAX_BLOCK_AGE_MS,
  //             1,4 s) + l'appel Haiku (médiane 0,87 s RÉELLE — et non les
  //             350 ms du stub). Balayage avec l'API RÉELLE, ~187 mots, mots
  //             affichés au-delà de +500 ms de leur cible :
  //               3000 → 138 mots, pire écart +4648 ms
  //               3500 →  68 mots, +3203 ms
  //               4000 →  31 mots, +1602 ms
  //               4500 →   6 mots,  +816 ms, p95 4928 ms   ← retenu
  //             C'est 1,5 s de mieux que Gladia. Le stub à 350 ms laissait croire
  //             qu'on pouvait descendre à 2,5 s : c'était faux.
  DISPLAY_DELAY_BY_ENGINE: { gladia: 6000, claude: 4500 },

  // Rattrapage. Quand un mot arrive APRÈS sa date cible, on ne vide pas la file
  // d'un coup — ce serait exactement le défaut qu'on corrige. On rejoue le
  // rythme de la parole, accéléré de ce facteur, jusqu'à revenir à la cible.
  // 1 = aucun rattrapage (le retard s'installe) ; 2 = deux fois plus vite.
  //
  // 2 et non 1,5 : c'est MAX_REVEAL_CPS (juste en dessous) qui borne désormais
  // la vitesse réelle, donc accélérer davantage ne produit plus de rafale — ça
  // ne fait que revenir plus tôt à la cible. Le rattrapage est devenu sûr, on
  // peut donc le rendre plus vif, et c'est ce qui évite que le plancher de
  // lisibilité fasse monter le retard moyen.
  CATCH_UP_RATE: 2,

  // PLANCHER DE LISIBILITÉ — vitesse maximale de révélation, en caractères par
  // seconde. C'est le correctif du défaut « sur les longues phrases le texte
  // s'affiche d'un coup ».
  //
  // Pourquoi il fallait autre chose que MIN_WORD_GAP_MS : la cadence suivait les
  // timings de Gladia au mot. Or ces timings sont IRRÉGULIERS — une rafale de
  // mots courts (« il y a un » ) est datée à 60-100 ms d'intervalle, et en
  // rattrapage on divisait encore par CATCH_UP_RATE. Résultat : quatre ou cinq
  // mots lâchés au plancher de 45 ms, ce que l'œil lit comme un bloc apparu d'un
  // coup. Le défaut n'était pas la longueur de la phrase en soi, c'était que la
  // phrase longue met l'affichage en rattrapage et que le rattrapage rejouait la
  // saccade de l'ASR.
  //
  // 22 car/s (espace compris) est délibérément AU-DESSUS du confort de lecture
  // du sous-titrage (12 à 17 car/s) et au-dessus du débit de scène (2,6 mots/s
  // ≈ 16 car/s) : le plancher ne doit brider que les saccades, pas la parole
  // normale — sinon il accumulerait un retard que le rattrapage devrait rendre.
  // Un mot de 5 lettres reçoit donc au moins 273 ms, un mot de 12 au moins 590.
  // Balayage au harnais (moteur claude, monologue de longues phrases, API réelle) :
  //   ∞ (désactivé) → 34 mots au plancher dur, retard médian 4497 ms
  //   28            →  6 mots,                 4498 ms
  //   22            →  0 mot,                  4514 ms   ← retenu
  //   17            →  0 mot,                  4703 ms  (le plancher mord la parole)
  // Mettre 0 ou null revient à l'ancien comportement (MIN_WORD_GAP_MS seul).
  MAX_REVEAL_CPS: 22,

  MIN_WORD_GAP_MS: 45,            // plancher dur, quel que soit MAX_REVEAL_CPS
  MAX_PACE_GAP_MS: 600,           // en rattrapage, un silence n'est pas rejoué au-delà

  // Débit supposé, quand on ne connaît que la fin d'un segment : sert à
  // reconstituer la date de chacun de ses mots.
  EST_WORDS_PER_SECOND: 2.6,

  // Un silence d'au moins ce temps ouvre une nouvelle ligne : une phrase ne
  // commence pas au milieu d'une ligne après une respiration.
  LINE_BREAK_SILENCE_MS: 1200,

  // Les lignes sont alignées à gauche dans une colonne de largeur FIXE : c'est
  // ce qui garantit qu'un mot déjà écrit ne bouge pas non plus latéralement. Une
  // ligne centrée se recentrerait à chaque mot ajouté et tout le texte déjà lu
  // glisserait sous les yeux du lecteur. Ce n'est pas réglable pour cette
  // raison — et avec deux colonnes, centrer n'aurait de toute façon aucun sens.

  FADE_IN_MS: 120,                // apparition d'un mot
  // Effacement après silence. Généreux : avec 4 lignes d'historique, l'intérêt
  // est justement que le texte RESTE lisible après la fin de la phrase. On
  // n'efface qu'après un vrai blanc de scène.
  CLEAR_AFTER_SILENCE_MS: 20_000,
  FONT_SIZE_VH: 3.6,              // 4 cases : plus petit qu'en pleine largeur
  LINE_HEIGHT: 1.3,

  // --- Audio / Gladia -----------------------------------------------------
  AUDIO_DEVICE_ID: '',
  CAPTURE_RATE: 48000,     // capture et enregistrement WAV
  SEND_RATE: 16000,        // envoyé à Gladia (diviseur entier de CAPTURE_RATE)
  CHUNK_MS: 40,
  SOURCE_CHANNEL: 0,       // 0 = gauche, 1 = droite (un seul micro)

  // --- Deux locuteurs, deux canaux -----------------------------------------
  //
  //  Un micro par locuteur, sur les deux canaux d'UNE SEULE entrée stéréo :
  //  canal 0 = gauche = locuteur G, canal 1 = droit = locuteur D.
  //
  //  Pourquoi pas deux sessions Gladia (une par canal), ce qui serait le plus
  //  simple ? Vérifié contre l'API : le plan du compte n'autorise qu'UNE session
  //  live simultanée (429 « Your Free Trial plan allows only up to 1 sessions »).
  //  On envoie donc la SOMME des deux canaux à Gladia, et on attribue chaque
  //  énoncé au bon locuteur en local, en comparant l'énergie des deux canaux sur
  //  la plage de temps de l'énoncé. Aucune dépendance à un champ `channel` non
  //  documenté en live, et un seul canal facturé.
  TWO_SPEAKERS: true,
  SPEAKERS: [
    { id: 'L', channel: 0, label: 'Gauche' },
    { id: 'R', channel: 1, label: 'Droite' },
  ],
  // Attribution : il faut que le canal gagnant domine d'au moins ce facteur,
  // sinon on garde le locuteur précédent (les deux micros captent les deux voix ;
  // c'est l'écart RELATIF qui identifie, pas le niveau absolu).
  SPEAKER_MIN_RATIO: 1.6,
  // Fenêtre d'énergie conservée pour l'attribution (s d'audio). Doit couvrir le
  // pire cas : durée d'un énoncé + retard de reconnaissance + traduction.
  ENERGY_WINDOW_S: 30,

  // --- Contrôle de la séparation stéréo -------------------------------------
  //
  //  Toute l'attribution des locuteurs repose sur UNE hypothèse : les deux
  //  canaux de l'entrée portent deux signaux DIFFÉRENTS. Si la chaîne (carte
  //  son, PipeWire, Chrome) réduit l'entrée en mono et duplique le canal, tout
  //  continue de « marcher » — vumètres, transcription, traduction — mais les
  //  deux colonnes deviennent interchangeables, et rien ne le signale.
  //
  //  On mesure donc en continu la CORRÉLATION entre les deux canaux. Deux voix
  //  distinctes, même avec de la diaphonie, restent sous 0,98. Un canal dupliqué
  //  donne exactement 1. `tools/check-stereo.mjs` fait la même mesure hors du
  //  navigateur : comparer les deux dit si le mono vient du PC ou du logiciel.
  STEREO_CHECK: true,
  // Au-dessus : les canaux sont considérés comme le MÊME signal.
  STEREO_IDENTICAL_CORR: 0.98,
  // Au-dessus mais sous le seuil précédent : suspect (micro unique repiqué sur
  // les deux canaux, ou les deux micros au même endroit).
  STEREO_SUSPECT_CORR: 0.9,
  // On ne juge que sur du signal : sous ce niveau RMS, c'est du silence et la
  // corrélation n'a aucun sens (deux silences sont toujours corrélés).
  STEREO_MIN_RMS: 0.003,
  // Durée de signal à accumuler avant de rendre un verdict, en secondes d'audio.
  STEREO_VERDICT_S: 3,

  // --- Langues --------------------------------------------------------------
  //
  //  On ne sait PAS qui parle quelle langue : chaque locuteur peut passer du
  //  français à l'anglais. Gladia détecte, et on traduit vers l'autre langue.
  //  C'est le seul cas qui justifie code_switching (il dégrade un peu les
  //  partials — mais transcrire dans la mauvaise langue les dégrade bien plus).
  LANGUAGES: ['fr', 'en'],
  CODE_SWITCHING: true,
  // Repli quand Gladia ne renvoie aucune langue.
  SOURCE_LANGUAGE: 'fr',
  TARGET_LANGUAGE: 'en',

  // --- Lexique du spectacle -------------------------------------------------
  //
  //  Les noms propres sont ce que la reconnaissance rate le plus : ils ne sont
  //  dans aucun dictionnaire et la traduction les déforme ou les traduit. La
  //  liste part d'ici et sert DEUX FOIS :
  //
  //   1. Gladia — `realtime_processing.custom_vocabulary`, qui biaise la
  //      reconnaissance vers ces mots (vérifié contre l'API : le champ existe et
  //      la validation est stricte, un nom de champ inventé renvoie 400) ;
  //   2. Claude — les mots sont listés dans le prompt système comme à préserver
  //      TELS QUELS, sinon « Captivea » ressort en « Captive A » et « Odoo » en
  //      « Odo ». Sans effet en moteur 'gladia', qui traduit chez lui.
  //
  //  La régie peut la modifier en répétition ; elle est alors mémorisée dans le
  //  navigateur (localStorage) et cette valeur-ci n'est plus que le défaut.
  //  Prise en compte au DÉMARRAGE : la session Gladia se configure à l'ouverture
  //  de la WebSocket.
  //
  //  Ce que ça coûte, mesuré sur l'API réelle (Haiku, bloc de 11 mots, 6 appels) :
  //     sans lexique : 865 ms de médiane, 163 tokens d'entrée
  //     4 mots       : 902 ms,            209 tokens
  //  soit ~+40 ms, dans le bruit de mesure, et sans effet sur le retard visé.
  //  Ce que ça corrige, sur la même API : « Sébastien travaille chez Captivea »
  //  devenait « Sebastian works at Captivea » sans le lexique, et reste
  //  « Sébastien » avec. Une liste de 60 mots resterait sous les 500 tokens.
  VOCABULARY: ['Captivea', 'Riss', 'Sébastien', 'Odoo'],
  // Poids donné à ces mots par Gladia, de 0 à 1. Au-delà de ~0,6 il commence à
  // les entendre partout ; en dessous de 0,3 l'effet est à peine visible.
  VOCABULARY_INTENSITY: 0.5,
  // Garde-fou : le lexique part dans un prompt et dans une config d'API.
  MAX_VOCABULARY: 60,

  // Le défaut Gladia (0,05 s) hache la parole. 0,3 s donne des unités utiles.
  ENDPOINTING: 0.3,
  // 5 s est le PLANCHER de l'API (vérifié : 3 et 4 renvoient 400). Garantit
  // qu'aucune utterance ne dépasse 5 s même sans silence détecté.
  MAX_DURATION_WITHOUT_ENDPOINTING: 5,

  SILENCE_PEAK_THRESHOLD: 0.004,
  SILENCE_ALERT_MS: 10_000,
  SESSION_MAX_MS: 3 * 60 * 60 * 1000,
  RECONNECT_MAX_SAME_URL: 3,
  RECONNECT_MAX_DELAY_MS: 15_000,
};

export const CHANNEL = 'surtitres';
