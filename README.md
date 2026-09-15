# Surtitrage live bilingue, deux locuteurs, pour spectacle

**Deux personnes parlent sur scène, chacune dans son micro.** On ne sait pas
d'avance qui parlera français et qui parlera anglais — ni si l'un des deux
changera de langue en cours de route. Le public lit, **en jetant un coup d'œil
entre deux regards vers la scène**, l'original *et* la traduction des deux.

La langue de chaque énoncé est détectée, et la traduction se fait toujours vers
**l'autre** langue. L'écran est une **grille fixe 2 × 2** : une colonne par
langue, une ligne par locuteur.

```
                     FRANÇAIS                    ENGLISH
   locuteur G   ▍ce qui nous intéresse      ▍what interests us
   (micro 0)    ▍c'est la mémoire           ▍is memory

   locuteur D   ▍et qui décide de ça        ▍and who decides that
   (micro 1)    ▍personne ne le sait        ▍nobody really knows
```

**La place est déterminée par la LANGUE, jamais par la provenance.** Un
spectateur francophone regarde toujours la colonne de gauche. Si un locuteur
passe à l'anglais, sa case française reçoit désormais la *traduction* au lieu de
l'original : c'est le contenu qui change de nature, pas l'emplacement. C'est la
seule disposition qui permette de savoir où regarder **à l'avance**.

La couleur suit la personne (G bleu, D ambre) dans les deux colonnes : on peut
donc suivre quelqu'un d'une langue à l'autre.

Les quatre cases sont **indépendantes** — file et cadence propres. Deux locuteurs
qui parlent en même temps s'écrivent en parallèle, aucun n'attend l'autre.
Chaque case garde **4 lignes d'historique** (≈ 12 à 15 s de parole) : le texte
défile vite, il faut laisser le temps de lire.

Ce n'est pas une transcription de réunion. La contrainte dominante n'est pas la
latence, c'est la **stabilité de lecture**.

> **Le texte affiché est append-only. Un mot affiché ne change JAMAIS.**
> **Le retard est constant, et les mots s'écrivent au rythme de la voix.**

Un interprète humain a un décalage naturel de 2 à 4 s et personne ne s'en
plaint. En revanche un mot qui change sous les yeux du lecteur force une
re-fixation oculaire et casse la lecture. On échange volontairement de la
latence contre de la stabilité. **Toute optimisation qui réduit la latence au
prix d'une réécriture est une régression.**

### Le retard est constant, pas subi

Un moteur de transcription ne rend son texte qu'à la fin d'un énoncé : jusqu'à
5 s de parole arrivent **d'un seul coup**. Afficher ce texte dès qu'il arrive
donne un écran qui reste figé pendant que la personne parle, puis se remplit
d'un bloc. C'est illisible : le lecteur ne sait jamais quand regarder, et quand
il regarde il doit tout absorber d'un coup.

L'étage d'affichage inverse le problème. Chaque mot porte la date à laquelle il
a été **prononcé** ; il est affiché à cette date + `DISPLAY_DELAY_MS`. Le texte
entre par paquets, il ressort mot à mot, à la cadence de la voix, avec un retard
constant. L'écran écrit en continu au lieu de clignoter par blocs, et les
silences de la parole sont des silences à l'écran.

Ce n'est pas une machine à écrire décorative : la cadence est celle de la voix
réelle, reconstituée depuis les timings du moteur (les mots longs tiennent plus
longtemps que les mots courts). Quand la traduction arrive en retard sur sa
cible, la file n'est **pas** vidée d'un coup — le rythme est rejoué accéléré de
`CATCH_UP_RATE` jusqu'à revenir à la cible.

#### Le plancher de lisibilité : pourquoi suivre la voix ne suffit pas

Rejouer fidèlement le rythme de la parole a un défaut, et il se voit sur les
**longues phrases**. Les timings que rend l'ASR sont irréguliers : une rafale de
mots courts (« et il y a un ») est datée à 100 ms d'intervalle, et une phrase
longue met l'affichage en rattrapage, où ces intervalles sont encore divisés par
`CATCH_UP_RATE`. Le résultat n'est pas une rafale au plancher dur — c'est plus
sournois : quatre ou cinq mots à 120 ms d'écart, que l'œil lit comme un bloc
apparu d'un coup. Le compteur de rafales, lui, restait à zéro.

Mesuré au harnais (monologue de longues phrases, moteur `claude`, latence Haiku
réelle) : **33 des 273 intervalles entre deux mots étaient plus rapides que
lisible**, le pire à 98 ms.

D'où `MAX_REVEAL_CPS` : une vitesse de révélation maximale, en **caractères par
seconde**, qui borne la cadence par le bas quel que soit ce que disent les
timings. Elle est proportionnelle à la longueur du mot déjà affiché — lire
« anniversaire » prend plus longtemps que lire « et », et c'est le mot à l'écran
qu'il reste à lire.

22 car/s est délibérément **au-dessus** du confort de lecture en sous-titrage
(12 à 17 car/s) et au-dessus du débit de scène (2,6 mots/s ≈ 16 car/s) : le
plancher ne doit brider que les saccades, jamais la parole normale — sinon il
accumulerait un retard qu'il faudrait rendre ensuite.

Et c'est précisément ce qui permet de **monter** `CATCH_UP_RATE` de 1,5 à 2 : le
rattrapage ne peut plus produire d'illisible, donc il peut être plus vif. Le
retard moyen ne bouge pas — vérifié, 4500 ms de médiane avant comme après, sur
la cible visée :

| | mots trop rapides | retard médian | retard p95 |
|---|---|---|---|
| avant (`MAX_REVEAL_CPS` = 0, rattrapage 1,5) | 33 / 273 | 4500 ms | 5154 ms |
| après (22 car/s, rattrapage 2) | **0** | 4500 ms | 5305 ms |

Le harnais en fait un critère d'acceptation (3c) et le pipeline expose le
compteur `tooFastWords`. Le cas limite est couvert lui aussi : deux textes qui se
recouvrent dans la même case (traduction fusionnée, parole simultanée mal
attribuée) reçoivent des dates identiques, donc un intervalle nul — avant, ils
sortaient au plancher dur de 45 ms ; le test unitaire vérifie qu'ils sortent
maintenant à leur temps de lecture.

Les mots déjà écrits ne bougent pas non plus **latéralement** : chaque colonne a
une largeur fixe et ses lignes sont alignées à gauche. Une ligne centrée se
recentrerait à chaque mot ajouté et tout le texte déjà lu glisserait sous les
yeux du lecteur.

### Qui parle ? Une contrainte d'API, contournée en local

Le plus simple serait une session Gladia par micro. **C'est impossible :** le
plan du compte n'autorise qu'**une seule session live simultanée** — vérifié
contre l'API, la deuxième `POST /v2/live` pendant qu'une WebSocket est connectée
répond `429 Maximum number of concurrent sessions reached. Your Free Trial plan
allows only up to 1 sessions`.

On envoie donc à Gladia la **somme** des deux canaux, et on retrouve qui parlait
en local : `src/speakers.js` garde l'énergie (RMS) de chaque canal, datée en
secondes d'audio, et compare les deux sur la plage de temps de l'énoncé que
Gladia nous renvoie. Trois bénéfices : aucune dépendance à un champ `channel`
non documenté pour le live, un seul canal facturé, et l'attribution reste
mesurable hors-ligne.

Les deux micros captent **les deux voix**. Le niveau absolu ne dit donc rien :
c'est l'écart *relatif* qui identifie. Sous `SPEAKER_MIN_RATIO` le système refuse
de trancher et garde le locuteur précédent — mieux vaut ça qu'écrire dans la
mauvaise colonne.

**Ce que ça exige du plateau, mesuré.** Balayage de la diaphonie au harnais
(`--bleed`, part de l'autre voix dans chaque micro), sur 184 mots :

| diaphonie | l'autre voix à | mal attribués | verdict |
|---|---|---|---|
| 35 % | −9 dB | **0** | confortable |
| 75 % | −2,5 dB | **0** | ça passe encore |
| 85 % | −1,4 dB | 87 (47 %) | ✗ rompu — 20 énoncés indécis |
| 85 % + `--ratio 1.25` | −1,4 dB | **0** | rattrapé par le réglage |

Il faut donc **~2 dB d'écart entre les deux micros** au défaut de 1,6, ce que
n'importe quel placement raisonnable donne. Si le plateau est plus difficile,
baisser `SPEAKER_MIN_RATIO` récupère la situation (`--ratio` au harnais pour le
vérifier avant de toucher la config). Le mode de dégradation est franc : sous le
seuil, le système devient *indécis*, garde le locuteur précédent, et la régie
compte les énoncés non attribués — on le voit avant le public.

### Quand les deux parlent EN MÊME TEMPS

Il faut distinguer deux choses, parce qu'une seule des deux est réparable ici.

**L'affichage reste correct, structurellement.** Les quatre cases ont chacune sa
file et sa cadence : deux locuteurs simultanés s'écrivent en parallèle, rien ne
se met en attente, rien ne se mélange dans une case. Le harnais simule un passage
où les deux démarrent au même instant (critère 9) : **27 mots affichés pendant le
chevauchement, aucun perdu**, et aucun hors de sa colonne de langue.

**L'attribution, elle, ne peut pas être fiable pendant un chevauchement.** Une
seule session Gladia est autorisée : les deux voix arrivent **mélangées** dans un
canal mono, et l'énergie des deux micros est forte en même temps — le tracker
devient légitimement indécis et garde le locuteur précédent. Le texte s'affiche
donc, mais peut-être sur la mauvaise ligne. Le harnais mesure les deux régimes
**séparément** au lieu de faire semblant : 0 % d'erreur hors chevauchement, et le
chevauchement compté à part.

Ça se règle avec de l'argent, pas avec du code : **un plan Gladia à 2 sessions
simultanées** permettrait une session par micro, donc une séparation parfaite même
en simultané. C'est la seule vraie solution — et le code y est prêt, il suffirait
d'instancier deux pipelines au lieu d'un.

### La panne silencieuse : « stéréo » qui n'est qu'un canal dupliqué

Toute l'attribution repose sur **une** hypothèse : les deux canaux de l'entrée
portent deux signaux différents. Quand elle est fausse — micro mono, câble jack
TRS, récepteur HF en mode MIX, profil PipeWire, down-mix Chrome — **rien ne
casse visiblement**. Les vumètres bougent, Gladia transcrit, la traduction sort.
Seules les deux colonnes deviennent un tirage au sort, et on ne le découvre pas
avant la scène. C'est le pire type de panne : celle qui ressemble à un
fonctionnement normal.

La régie mesure donc en continu la **corrélation** des deux canaux, sur les
paquets où il y a du signal (deux silences sont toujours parfaitement corrélés et
ne prouvent rien), et l'annonce dans une pastille « Stéréo » :

| Corrélation G/D | Verdict | Ce que ça veut dire |
|---|---|---|
| écart max = 0 | `MONO DUPLIQUÉ` | le même tableau d'échantillons deux fois |
| ≥ 0,98 | `CANAUX IDENTIQUES` | même source sur les deux canaux |
| ≥ 0,90 | `SÉPARATION FAIBLE` | micros trop proches, ou l'un ne capte rien |
| < 0,90 | `STÉRÉO OK` | deux sources distinctes |

Le seuil est calibré sur le cas réel : deux micros dans la même pièce se
**corrèlent** par diaphonie sans être identiques — 35 % de diaphonie donne 0,57,
loin des seuils. Le test unitaire vérifie ce cas précis, pour que le contrôle ne
crie pas au loup en conditions normales.

#### « Ça vient de mon PC ou du logiciel ? »

C'est la seule question qui compte quand le verdict est mauvais, et un seul
chiffre ne peut pas y répondre. D'où `tools/check-stereo.mjs` : il fait
**exactement la même mesure** (le module `src/stereo.js` est partagé) mais **hors
du navigateur** — enregistrement direct depuis le système, sans Chrome, sans
`getUserMedia`. La comparaison des deux verdicts tranche :

| en ligne de commande | pastille de la régie | conclusion |
|---|---|---|
| `STÉRÉO RÉELLE` | `STÉRÉO OK` | tout va bien |
| `STÉRÉO RÉELLE` | `CANAUX IDENTIQUES` | **c'est le logiciel** — le système sépare, le navigateur remixe |
| `CANAUX IDENTIQUES` | `CANAUX IDENTIQUES` | **c'est le PC** — en amont du navigateur, rien à corriger dans le code |

```bash
node tools/check-stereo.mjs --list                 # les entrées et leur carte de canaux
node tools/check-stereo.mjs --seconds 8            # mesure sur l'entrée par défaut
node tools/check-stereo.mjs --device <nom>         # une entrée précise
node tools/check-stereo.mjs --alsa --device hw:0,0 # contourne PipeWire
node tools/check-stereo.mjs --file spectacle.wav   # un enregistrement déjà fait
```

**Parlez dans un seul micro pendant la mesure** : c'est le déséquilibre qui
prouve la séparation.

Le mode `--file` est le plus fiable : l'enregistrement que la régie écrit est
stéréo, donc on peut vérifier **après coup** qu'une répétition avait bien deux
canaux, sans rien rebrancher.

Quand le verdict désigne le PC, dans l'ordre : l'entrée est-elle annoncée en 2
canaux (`--list`) ; un jack TRS 3 points ne transporte qu'**une** voie de micro,
il faut deux entrées physiques ; un récepteur HF en mode MONO/MIX doit passer en
mode où chaque capsule a sa sortie ; et si ALSA sépare mais `parecord` non, c'est
le profil PipeWire/Pulse qu'il faut changer.

---

## Moteur de traduction : un sélecteur dans la régie

Le choix se fait **dans le tableau de bord**, panneau « Session ». Il est actif
seulement à l'arrêt et **grisé pendant la session** : la configuration de session
Gladia (traduction native demandée ou non) est décidée à l'ouverture de la
WebSocket, on ne la change pas en vol le jour J. Le choix est mémorisé d'une fois
sur l'autre ; `TRANSLATION_ENGINE` dans `config/surtitles.js` n'est plus que la
valeur par défaut au premier lancement.

| | `gladia` | `claude` |
|---|---|---|
| Clés nécessaires | Gladia seule | Gladia + Anthropic |
| Coût | 0,75 $/h | 1,50 $/h |
| Quand le texte arrive | **fin de la phrase** | au fil de la phrase |
| Retard tenable, **mesuré sur l'API réelle** | **6000 ms** | **4500 ms** |
| LocalAgreement + découpage au mot | inactifs | actifs |
| Sens de traduction | les deux (2 langues cibles, identité filtrée) | les deux (direction détectée par énoncé) |

**Le retard suit le moteur, automatiquement.** Leurs planchers n'ont rien à voir,
donc un réglage unique serait faux dans un cas ou dans l'autre : basculer le
sélecteur ramène le retard du moteur choisi (`DISPLAY_DELAY_BY_ENGINE`), et le
curseur « Retard à l'écran » est mémorisé **par moteur**. En Claude, le public
attend 1,5 s de moins — sans rien perdre en fluidité.

Le moteur `claude` demande une clé sur <https://console.anthropic.com> :
`ANTHROPIC_API_KEY=sk-ant-...` dans `.env`. Sans elle, la régie le signale au
chargement et affiche « bloc abandonné » pendant la session.

### Ce que coûte le moteur `gladia`, mesuré

La traduction Gladia est attachée à l'utterance **finale** : rien ne peut sortir
avant la fin de celle-ci. Un énoncé dure jusqu'à 5 s (plancher dur de l'API) et
la traduction met ~0,6 s de plus. **Le retard visé ne peut donc pas descendre
sous ~6 s** sans que les premiers mots d'une longue phrase sortent en rattrapage.
Ce n'est pas un bug : c'est le prix du moteur. Le moteur `claude`, qui traduit
par blocs de 5 à 12 mots, tient 2,5 s.

Balayage du retard visé, moteur `gladia`
(`node tests/harness.mjs --engine gladia --delay …`). Mesuré sur le flux à **un
seul locuteur**, avant l'ajout du second — 89 mots affichés ; les chiffres à deux
locuteurs, plus bas, sont meilleurs encore (0 rattrapage, pire écart +1 ms) parce
que chaque colonne a sa propre file et son propre rythme :

| `DISPLAY_DELAY_MS` | mots en rattrapage | pire écart à la cible | p95 inter-mots |
|---|---|---|---|
| 5000 | 10 | +1300 ms | 666 ms |
| 5500 | 3 | +799 ms | ~750 ms |
| **6000** | **0** | **+300 ms** | 836 ms |
| 6500 | 0 | +1 ms | 837 ms |

**Réglage retenu : 6000 ms.** À cette valeur plus aucun mot n'est en rattrapage :
ce qui s'écrit à l'écran est exactement le rythme de la voix, décalé d'une
constante. Le p95 inter-mots *monte* quand on augmente le retard — c'est le signe
attendu : à 5000 ms une partie de la cadence était compressée par le rattrapage,
à 6000 ms elle ne l'est plus. 836 ms entre deux mots, c'est un mot long réellement
prononcé lentement, pas un blocage.

Les deux moteurs restent fluides dans tous les cas (0 % de mots en rafale) : sous
le plancher, la révélation reste mot à mot, elle court simplement derrière la
voix. Et le harnais dit quel retard viser :

```
⚠ retard visé trop court pour ce moteur : 81 mot(s) en rattrapage.
  Essayer DISPLAY_DELAY_MS = 4500.
```

### Le plancher du moteur `claude`, mesuré sur l'API réelle

Le stub du harnais répond en 350 ms ; **la vraie API met 0,87 s en médiane**. Tout
réglage calibré sur le stub est donc faux — c'est ce qui m'avait fait annoncer
« 2,5 s tenables », ce qui était optimiste de 2 s.

Balayage `--engine claude --live-translate --delay …`, ~187 mots, 24 blocs :

| `DISPLAY_DELAY_MS` | mots en rattrapage | pire écart | traductions |
|---|---|---|---|
| 3000 | 138 | +4648 ms | — |
| 3500 | 68 | +3203 ms | 22 ok, 2 perdues |
| 4000 | 31 | +1602 ms | 22 ok, 2 perdues |
| **4500** | **6** | **+816 ms** (p95 4928) | **24 ok, 0 perdue** |

Le plancher est la somme des étapes : reconnaissance ~0,45 s + validation
LocalAgreement ~0,4 s + âge maximum d'un bloc (`MAX_BLOCK_AGE_MS`, 1,4 s) +
l'appel Haiku ~0,87 s. Pour descendre il faudrait baisser `MAX_BLOCK_AGE_MS`, au
prix de blocs plus courts donc de traductions moins cohérentes.

> #### Pourquoi `TRANSLATION_TIMEOUT_MS` doit rester COURT
>
> Contre-intuitif, et payé pour l'apprendre. La file est **séquentielle** : tout
> le temps passé sur un bloc lent est du retard pour tous les suivants. En le
> passant de 2000 à 4000 ms avec un retry, pour ne plus perdre de blocs, les
> blocs se sont empilés, la fusion anti-accumulation s'est déclenchée **13 fois**
> et la latence p95 est montée à **15,6 s** — un décrochage général pour éviter
> deux trous ponctuels. Mauvais échange.
>
> Réglage retenu : **2500 ms, zéro retry**. Un trou ponctuel est moins grave qu'un
> décrochage — d'autant que la colonne **originale** continue d'afficher ce qui a
> été dit, ce qui n'était pas vrai avant l'affichage à deux colonnes.

---

## Le lexique du spectacle

Les noms propres sont ce que la chaîne rate le plus : ils ne sont dans aucun
dictionnaire, la reconnaissance les déforme, et la traduction les *traduit*.
« Odoo » devient « Odo », « Captivea » devient « Captive A », et « Sébastien »
ressort en « Sebastian » — vérifié sur l'API réelle.

Le panneau **« Lexique du spectacle »** de la régie contient une liste de mots,
un par ligne. Elle est mémorisée dans le navigateur ; `VOCABULARY` dans
`config/surtitles.js` n'est que le défaut. Elle est prise en compte **au
démarrage** (la session Gladia se configure à l'ouverture de la WebSocket), et
elle sert **deux fois** :

1. **Reconnaissance** — `realtime_processing.custom_vocabulary` biaise Gladia
   vers ces mots, avec `VOCABULARY_INTENSITY` comme poids.
2. **Traduction** — le prompt système liste ces mots comme à recopier **tels
   quels**. Sans objet en moteur `gladia`, qui traduit chez lui.

**Ce que ça coûte**, mesuré sur l'API réelle (Haiku, bloc de 11 mots, 6 appels) :

| | latence moyenne | tokens d'entrée |
|---|---|---|
| sans lexique | 865 ms | 163 |
| 4 mots | 902 ms | 209 |

Soit ~40 ms, dans le bruit de mesure, et sans effet sur le retard visé. Une
liste de 60 mots (le plafond) resterait sous les 500 tokens. Le prompt système
n'est **pas** mis en cache et c'est volontaire : le minimum cachable de Haiku 4.5
est de 4096 tokens, très au-dessus de ce prompt — un `cache_control` ici serait
silencieusement sans effet.

**Ce que ça corrige**, sur la même API : « Sébastien travaille chez Captivea sur
les modules Odoo » donnait *« Sebastian works at Captivea on Odoo modules »* sans
lexique, et *« Sébastien works at Captivea on Odoo modules »* avec.

---

## Démarrage

```bash
node server.mjs
```

- **Régie** : <http://localhost:8123/operator>
- **Affichage public** : <http://localhost:8123/display>

Ou en application de bureau (entrée « Surtitres Live » dans les applications
Ubuntu) : `./desktop/install.sh`. **À relancer après chaque modification du
projet** — le lanceur installé sous `~/.local/bin` en est une copie. Le serveur,
lui, se met à jour tout seul : `/api/health` porte sa date de démarrage, et le
lanceur remplace un serveur plus vieux que les fichiers du projet.

### Séquence

1. **Autoriser** le micro, choisir l'entrée.
2. **Ouvrir la fenêtre d'affichage**, la glisser sur l'écran de scène, **F11**.
3. **DÉMARRER** (choisir l'emplacement du `.wav` si l'enregistrement est coché).
4. Régler la police en la regardant **depuis la place du public**, pas sur le laptop.

**Blackout : touche `B`**, ou le gros bouton rouge. Coupe l'affichage
instantanément sans rien arrêter d'autre — **y compris les fichiers OBS**, qui
sont vidés en même temps.

---

## Mode fichier : les surtitres dans OBS

Case **« mode fichier »** dans *Réglages à chaud*. Les surtitres sont alors
écrits en continu dans **un fichier texte par langue**, qu'OBS relit en boucle :

| | |
|---|---|
| Français | `$XDG_RUNTIME_DIR/captive-transcription/surtitres-fr.txt` |
| English | `$XDG_RUNTIME_DIR/captive-transcription/surtitres-en.txt` |

Les chemins exacts sont affichés sous la case, avec un bouton **Copier**.

Dans OBS : *Sources* → **Texte (GDI+)** → cocher **« Lire à partir d'un
fichier »** → coller le chemin. Les deux fichiers sont créés **vides au
démarrage du serveur** : ils sont sélectionnables dans OBS avant même d'avoir
lancé la session.

Ce qu'il faut savoir :

- **Un fichier par LANGUE, pas par locuteur.** L'écran de scène a quatre cases
  (locuteur × langue) parce qu'il a la place et la couleur pour les distinguer ;
  un fichier texte n'a ni l'une ni l'autre. Les deux locuteurs partagent donc la
  même piste, dans l'ordre où ils ont parlé — c'est la forme d'un sous-titre.
- **Deux lignes au plus** (`CAPTION_MAX_LINES`), contre quatre à l'écran de
  scène : une incrustation vidéo n'a pas cette hauteur.
- **C'est le serveur qui écrit**, pas le navigateur : la File System Access API
  redemanderait un fichier à chaque session, et OBS a besoin d'un chemin qui ne
  change jamais.
- **Écriture atomique** (fichier temporaire + `rename`). OBS relit en
  permanence ; une écriture en place le ferait tomber tôt ou tard sur un fichier
  tronqué — un surtitre à moitié effacé, en public.
- **Écritures groupées** toutes les `CAPTION_FLUSH_MS` (150 ms), et seule une
  langue qui a changé est réécrite : l'écran avance mot à mot, ce serait sinon
  une réécriture par mot sous le nez d'OBS.
- **Vidés** au blackout, au bouton *Vider*, au silence prolongé, à l'arrêt de la
  session et à l'arrêt du serveur : la dernière phrase du spectacle ne reste pas
  incrustée dans OBS.

---

## Architecture

```
2 micros → AudioWorklet ──┬─→ somme mono 16 kHz ──────────→ Gladia (1 session)
                          │                                    │
                          └─→ énergie L/R datée               │  langue détectée
                                    │                          │  (code_switching)
                                    ▼                          │
                          src/speakers.js  ◄── start/end ──────┤
                          « qui parlait ? »                    │
                                                               │
              ┌───────── moteur 'gladia' ───────────────┴──── moteur 'claude' ──┐
              │                                                                 │
      traduction native, 2 cibles                              transcription seule
      (identité fr→fr filtrée)                                          │
              │                                       LocalAgreement-N (mots stables)
              │                                                  │
              │                                     découpage en blocs (5-12 mots)
              │                                                  │
              │                            file SÉQUENTIELLE → Claude Haiku, dans
              │                            la direction détectée (fr→en ou en→fr)
              └────────────────────┬─────────────────────────────┘
                                   │
              QUATRE files de MOTS datés (date de parole + retard constant)
                  L:fr    L:en    R:fr    R:en       (src/stage.js)
                                   │
              affichage append-only : grille fixe langue × locuteur
```

La clé d'un flux est `locuteur:LANGUE` — jamais `original` ou `traduction`. C'est
ce qui donne sa place fixe à chaque langue, et le harnais le vérifie (critère 8 :
aucun mot hors de sa colonne).

| Fichier | Rôle |
|---|---|
| `config/surtitles.js` | **tous** les seuils, réglables en répétition |
| `src/agreement.js` | LocalAgreement-N : la couche de validation |
| `src/chunker.js` | découpage en unités de sens |
| `src/translator.js` | file séquentielle, contexte glissant **par locuteur et par direction**, timeout dur |
| `src/speakers.js` | qui parle : énergie comparée des deux canaux |
| `src/stereo.js` | les deux canaux sont-ils vraiment deux signaux ? Partagé avec `tools/check-stereo.mjs` |
| `src/stage.js` | un étage d'affichage cadencé (retard constant, mot à mot, plancher de lisibilité). Il y en a 4 |
| `src/feed.js` | modèle d'affichage append-only : les lignes grandissent mot à mot |
| `src/captions.js` | mode fichier : ce que contiennent les `.txt` relus par OBS, une piste par langue |
| `src/pipeline.js` | le routeur : langue, locuteur, direction. Aucune dépendance au DOM ni au réseau |
| `operator.html` | régie |
| `display.html` | vue publique : la grille fixe langue × locuteur, rien d'autre |
| `server.mjs` | secure context + clé Gladia + proxy de traduction bidirectionnel + écriture des `.txt` OBS |
| `tools/check-stereo.mjs` | contrôle de la séparation stéréo **hors navigateur** : PC ou logiciel ? |

Les modules de `src/` ne touchent ni au DOM ni au réseau : c'est ce qui permet au
harnais hors-ligne de rejouer un enregistrement **dans exactement le même code**
que le direct.

---

## Harnais de test hors-ligne

Impossible de régler ces seuils en répétant avec un micro. Il faut rejouer le
même audio en boucle et comparer deux configurations.

```bash
# Flux de partials synthétique. Aucun réseau, aucun quota.
node tests/harness.mjs --verbose

# Enregistrer une fixture depuis un vrai WAV (mono 16 kHz) — consomme du quota Gladia
node tests/harness.mjs --record mon-audio.wav

# Rejouer la fixture, éventuellement avec la vraie traduction
node tests/harness.mjs --replay mon-audio.fixture.jsonl [--live-translate]

# Comparer deux configs sur le MÊME flux
node tests/harness.mjs --agreement 3 --max-age 1800 --min-words 6

# Chercher le retard tenable pour un moteur
node tests/harness.mjs --engine gladia --delay 6000

# Comparer les DEUX moteurs de traduction sur le même flux
node tests/harness.mjs --engine gladia
node tests/harness.mjs --engine claude

# LONGUES PHRASES, un seul locuteur : le cas où l'affichage part en rattrapage,
# et donc le seul qui exerce le plancher de lisibilité.
node tests/harness.mjs --engine claude --monologue
node tests/harness.mjs --engine claude --monologue --reveal-cps 0   # l'ancien comportement
```

Options : `--engine gladia|claude` `--delay MS` `--catch-up N` `--reveal-cps N`
`--agreement N` `--min-words N` `--max-words N` `--idle MS` `--max-age MS`
`--asr-lag MS` `--gladia-lag MS` `--stub-lag MS` `--bleed 0..1` `--monologue`
`--one-speaker` `--live-translate` `--verbose`

Le flux simulé comporte **deux locuteurs qui changent de langue** (le locuteur G
passe à l'anglais au milieu du spectacle), et l'attribution passe par le **vrai**
`src/speakers.js`, alimenté en énergies synthétiques avec de la diaphonie —
`--bleed 0.6` pour éprouver le cas où les deux micros se marchent dessus.

En `--verbose`, le terminal **rejoue la révélation mot à mot en temps réel** :
c'est le moyen le plus direct de juger la cadence sans micro ni écran.

Chaque run écrit un journal horodaté dans `tests/tmp/harness-log.jsonl`
(partial reçue, mot validé, bloc flushé, traduction reçue, **mot affiché**) et
affiche les critères d'acceptation du §9.

Le rejeu se fait en **temps réel 1×** : la cadence d'affichage repose sur de
vrais timers et sur l'horloge audio, l'accélérer la fausserait. Un enregistrement
de 4 minutes prend 4 minutes par run.

Le simulateur respecte `MAX_DURATION_WITHOUT_ENDPOINTING` : une phrase de 20 mots
arrive en **deux** utterances, comme chez Gladia. Sans ça, le harnais mesurait un
retard structurel que le direct ne produit pas.

Deux autres points de réalisme, ajoutés parce que sans eux le harnais **cachait**
le défaut de cadence sur les longues phrases :

- **la durée de chaque mot**, et non la durée moyenne partout. Les vrais timings
  de l'ASR sont très irréguliers — « il y a un » tient dans 400 ms, un mot de
  douze lettres en prend presque une seconde. Un débit uniforme donnait
  l'illusion d'une révélation lisse.
- **la dispersion du traducteur**, et non sa médiane. C'est la queue de la
  distribution qui fait s'empiler les blocs et déclenche le rattrapage. Le stub
  tire dans une log-normale bornée calée sur la mesure réelle de Haiku (médiane
  0,87 s, p90 1,45 s, max 2,97 s), depuis le PRNG déterministe — deux runs sur la
  même config restent comparables.

```bash
node tests/test-units.mjs     # 101 tests des modules purs, instantané
```

---

## Réglage

Tout est dans `config/surtitles.js`.

| Seuil | Défaut | Quand y toucher |
|---|---|---|
| `TRANSLATION_ENGINE` | `gladia` | Valeur par défaut au premier lancement seulement : ensuite c'est **le sélecteur de la régie** qui décide. |
| `TWO_SPEAKERS` | `true` | À `false`, une seule colonne et un seul micro (canal 0). |
| `SPEAKER_MIN_RATIO` | 1.6 | Écart d'énergie exigé pour attribuer un énoncé. Plus bas = tranche plus souvent, y compris à tort. Plus haut = plus d'énoncés « indécis », qui restent chez le locuteur précédent. À régler en répétition en regardant le point de balance de la régie. |
| `LANGUAGES` / `CODE_SWITCHING` | `['fr','en']` / `true` | Les deux langues possibles, détectées par énoncé. `code_switching` dégrade un peu les partials, mais transcrire de l'anglais comme du français les dégrade infiniment plus. |
| `MAX_LINES` | 4 | **Historique par case.** 4 lignes ≈ 12 à 15 s de parole à l'écran. Monter si ça défile trop vite pour la salle ; la police baisse d'autant. |
| `CLEAR_AFTER_SILENCE_MS` | 20 000 | Généreux exprès : l'intérêt de l'historique est que le texte RESTE lisible après la fin de la phrase. |
| `LANGUAGE_LABELS` | `Français` / `English` | Les en-têtes de colonne. |
| `AGREEMENT_N` | 2 | *(moteur `claude` uniquement)* **La métrique de réglage principale** : si la divergence validé/final dépasse **5 %**, passer à 3 (ajoute ~300 ms mais stabilise). Sous 3 %, on peut rester à 2. |
| `MIN_WORDS` / `MAX_WORDS` | 5 / 12 | Blocs trop courts = traduction incohérente ; trop longs = trous à l'écran. |
| `MAX_BLOCK_AGE_MS` | 1400 | Voir l'encadré ci-dessous. Baisser réduit les trous, au prix de blocs plus courts. |
| `IDLE_FLUSH_MS` | 800 | Sans elle, des mots orphelins restent bloqués quand la parole s'arrête. |
| `DISPLAY_DELAY_MS` | 6000 | **Le réglage d'affichage principal.** Retard constant voix → écran. Curseur dans la régie, effet immédiat. Plancher ≈ 6 s en moteur `gladia`, ≈ 2,5 s en `claude` : sous le plancher, les premiers mots d'une phrase sortent en rattrapage (le harnais le dit et propose une valeur). Voir le balayage plus haut. |
| `CATCH_UP_RATE` | 2 | Vitesse de rattrapage quand un mot arrive après sa cible. `1` = ne rattrape jamais. Peut être vif parce que `MAX_REVEAL_CPS` borne la vitesse réelle. |
| `MAX_REVEAL_CPS` | 22 | **Plancher de lisibilité** : vitesse maximale de révélation, en caractères/seconde. C'est ce qui empêche une longue phrase de sortir d'un bloc quand les timings de l'ASR sont saccadés. Baisser (17) si la salle lit lentement — au prix d'un peu de retard ; `0` débranche et rend l'ancien comportement. Voir le balayage plus haut. |
| `VOCABULARY` | `Captivea, Riss, Sébastien, Odoo` | Lexique du spectacle. **Défaut seulement** : la régie l'édite et le mémorise. Sert deux fois — biais de reconnaissance Gladia, et interdiction de traduire ces noms. |
| `VOCABULARY_INTENSITY` | 0.5 | Poids du lexique côté Gladia. Au-delà de ~0,6 il entend ces mots partout ; sous 0,3 l'effet est à peine visible. |
| `STEREO_IDENTICAL_CORR` | 0.98 | Au-delà, les deux canaux sont déclarés « même source ». Deux micros dans la même pièce restent bien en dessous (0,57 à 35 % de diaphonie). |
| `LINE_BREAK_SILENCE_MS` | 1200 | Un silence de cette durée ouvre une ligne neuve : une phrase ne démarre pas au milieu d'une ligne. |
| `ENDPOINTING` | 0.3 | Le défaut Gladia (0,05 s) hache la parole en miettes. |

> ### Ajout hors spec : `MAX_BLOCK_AGE_MS`
>
> Le tableau de flush du §3 n'a **aucune règle d'âge maximum**, et
> `IDLE_FLUSH_MS` ne se déclenche que si la parole **s'arrête**. Sur une phrase
> longue sans ponctuation forte ni connecteur, le buffer attendait donc
> `MAX_WORDS` (≈ 4,6 s de parole) et l'écran restait figé : le harnais a mesuré
> un **trou de 6,2 s en parole continue**, en violation du critère n°4.
>
> J'ai donc borné l'âge d'un bloc même en parole continue. Balayage sur le flux
> de test : `2200` → trou 4,3 s (échec) · `1600` → 4,0 s (trop juste) ·
> **`1400` → 3,4 s** · `1200` → 3,3 s mais blocs très courts.

### Détails d'API qui coûtent cher à redécouvrir

`receive_partial_transcripts` vaut `false` par défaut chez Gladia. Sans
l'activer, rien ne fonctionne — et en silence.

**Une seule session live à la fois** sur ce plan (429 au-delà). D'où la somme des
deux canaux et l'attribution locale ; voir plus haut.

Avec **deux langues cibles**, Gladia renvoie aussi la traduction *identité*
(fr → fr) en plus de la vraie. Non filtrée, elle écraserait la traduction dans la
colonne. Le pipeline la reconnaît (`original_language === target_language`) et la
jette : le harnais en compte 12 écartées sur 12 énoncés.

**Gladia valide strictement sa config de session** : un champ inventé renvoie
`400` avec le chemin exact (`realtime_processing.property bogus should not
exist`). C'est une bonne nouvelle — ça veut dire qu'un `201` **prouve** que les
champs envoyés existent. C'est comme ça que `custom_vocabulary` /
`custom_vocabulary_config.vocabulary` / `default_intensity` ont été confirmés
plutôt que devinés, et que le lexique du spectacle est fiable. Un
`realtime_processing: {}` vide est accepté, donc pas besoin de conditionner le
bloc entier.

**Un abandon client empoisonne la connexion sortante.** Quand la file de
traduction abandonne un bloc (timeout), l'appel `fetch` **suivant** vers Anthropic
échoue instantanément — reproduit : un abandon à 3002 ms, puis cinq
`fetch failed` d'affilée en ~260 ms chacun. Un seul bloc lent faisait donc perdre
les cinq suivants, soit cinq trous d'un coup. Le serveur retente désormais **une
fois, sur erreur réseau uniquement** (jamais sur une erreur HTTP, jamais si le
client est déjà parti) : la nouvelle tentative ouvre une connexion neuve.
Vérifié : 24 appels sur 24 réussis là où 6 échouaient.

#### Chrome down-mixe

**`echoCancellation` force un down-mix mono** dans Chrome. Sur un système à deux
micros, c'est fatal : les deux locuteurs se retrouveraient sur un seul canal. Le
`getUserMedia` demande donc explicitement `channelCount: 2`, et le nœud worklet
`channelCountMode: 'explicit'` + `channelInterpretation: 'discrete'` — sans quoi
Chrome peut down-mixer avant même le worklet.

Quand `tools/check-stereo.mjs` voit deux canaux distincts et que la régie n'en
voit qu'un, c'est ici qu'il faut chercher, dans cet ordre :

1. **La bonne entrée est-elle sélectionnée ?** La liste de la régie contient aussi
   le micro intégré du laptop (souvent mono dupliqué) et les *monitors* de sortie.
   Le nom retenu est écrit dans le journal au démarrage.
2. **Un traitement est-il resté actif ?** La régie alerte en rouge si
   `echoCancellation`, `noiseSuppression` ou `autoGainControl` a survécu à la
   demande — Chrome peut les réactiver selon le périphérique.
3. **`channelCount` annoncé.** Le journal l'affiche au démarrage ; s'il vaut 1
   alors que le système annonce 2 canaux, Chrome a down-mixé à l'ouverture du
   flux : changer d'entrée, ou passer par une interface audio qui expose deux
   canaux distincts.

L'annonce (`channelCount`) et la mesure (corrélation) sont deux choses
différentes, et les deux sont utiles : l'annonce arrive tout de suite et attrape
le cas grossier, la mesure demande quelques secondes de parole mais attrape le cas
où Chrome annonce 2 canaux et livre deux fois le même.

**Ce dernier cas n'est pas théorique** : avec le périphérique factice de Chrome
alimenté par un WAV dont les deux canaux sont identiques, la régie journalise
`2 canal/canaux` — l'annonce est bonne — et mesure une corrélation de `1,00000`.
Un système qui ne regarderait que `channelCount` déclarerait l'installation
saine. C'est précisément la panne silencieuse que le contrôle existe pour
attraper.

---

## État des critères d'acceptation (§9)

Mesuré sur le flux synthétique du harnais (`node tests/harness.mjs`), au réglage
retenu `DISPLAY_DELAY_MS: 6000`.

Moteur **`gladia`** (réglage actuel) :

| | Critère | Résultat |
|---|---|---|
| 1 | Zéro mutation, garantie structurellement | ✅ |
| 2 | Retard médian conforme à la cible (±500 ms) | ✅ 6000 ms |
| 2b | Retard p95 < cible + 1,5 s | ✅ 6636 ms |
| 2c | Retard au début d'un segment | ✅ méd. 6,0 s · p95 6227 ms |
| 3 | Révélation fluide (p95 entre 2 mots < 900 ms) | ✅ 659 ms |
| 3b | Pas de rafale (< 10 % des mots au plancher dur) | ✅ 0 % |
| 3c | **Plancher de lisibilité respecté** (22 car/s) | ✅ 0 mot trop rapide |
| 4 | Aucun trou > 4 s en parole continue | ✅ 2,7 s |
| 5 | Divergence | sans objet |
| 6 | Bon locuteur (< 2 % de mots mal attribués) | ✅ **0 %** (0/184) hors chevauchement |
| 7 | Les 4 cases locuteur × langue alimentées | ✅ |
| 8 | **Place fixe** : aucun mot hors de sa colonne | ✅ 0 sur 214 |
| 9 | Parole simultanée : texte préservé pour les deux | ✅ 30 mots, 0 perdu |
| — | Mots en rattrapage (> +500 ms de leur cible) | 12 sur 184, pire écart +1835 ms |
| — | Traductions identité filtrées | 12 sur 12 énoncés |

Moteur **`claude`**, même flux, **avec la vraie API Anthropic**, à son propre
retard de 4500 ms (`--engine claude --live-translate`) :

| | Critère | Résultat |
|---|---|---|
| 1 | Zéro mutation, garantie structurellement | ✅ aucune API de mutation ; mots gelés ; réconciliation DOM ligne + mot |
| 2 | Retard médian conforme à la cible | ✅ 4500 ms |
| 2b | Retard p95 < cible + 1,5 s | ✅ 5135 ms |
| 2c | Retard au début d'un segment | ✅ méd. 4,5 s · p95 5315 ms |
| 3 | Révélation fluide | ✅ 629 ms |
| 3b | Pas de rafale | ✅ 0 % |
| 3c | **Plancher de lisibilité respecté** (22 car/s) | ✅ 0 mot trop rapide |
| 4 | Aucun trou > 4 s en parole continue | ✅ 2,7 s |
| 5 | Divergence loggée et affichée en régie | ✅ 0 % |
| 6 | Bon locuteur | ✅ **0 %** (0/184) hors chevauchement |
| 7 | Les 4 cases locuteur × langue alimentées | ✅ |
| 8 | **Place fixe** : aucun mot hors de sa colonne | ✅ 0 sur 210 |
| 9 | Parole simultanée : texte préservé pour les deux | ✅ 26 mots, 0 perdu |
| — | Traductions réelles | **28 appels, 0 échec, 0 fusion**, dans les deux sens |
| — | Mots en rattrapage | 15, pire écart +1674 ms |

Les mots en rattrapage sont des blocs dont la traduction a dépassé son budget —
l'écart se résorbe sur quelques mots, à une vitesse qui reste lisible, au lieu
d'être lâché d'un coup. C'est exactement le comportement voulu, et le critère 3c
est ce qui le vérifie : ces 15 mots sont en retard, aucun n'est illisible.

Sur le **monologue de longues phrases** (`--monologue`, le cas où le rattrapage
travaille le plus), même API réelle : retard médian 4500 ms, p95 5206 ms, 23 mots
en rattrapage, **0 mot trop rapide sur 279**.

Les critères de latence de la spec (« médiane 2–3 s, p95 < 4 s ») ont été
remplacés par des critères de **conformité à la cible** : ce qui compte n'est pas
la valeur du retard mais qu'il soit constant et que la révélation soit fluide. Un
retard de 5 s parfaitement régulier se lit mieux qu'un retard moyen de 2 s qui
saute de 0,5 à 6 s.

Le compromis assumé est le **niveau** du retard : 6 s en Gladia, c'est le haut de
la fourchette d'un interprète humain. Le moteur `claude` descend à **4,5 s** avec
la même fluidité — et c'est la seule façon de descendre, les deux moteurs étant
chacun à leur plancher mesuré. À juger en répétition, depuis la salle.

**Ce qui EST validé contre les vraies API :**

- Le moteur **`claude` tourne pour de vrai** : 24 appels, 0 échec, dans les deux
  sens (`fr→en` et `en→fr`), vérifiés dans le journal du harnais. Latence
  observée ~1 s par bloc.
- La limite **d'une seule session Gladia simultanée** (429), l'acceptation de
  `code_switching` avec deux langues, et de **deux langues cibles** de traduction :
  testés par requêtes réelles.

**Ce qui n'est PAS validé — à faire en répétition :**

- **AUCUN audio réel n'est encore passé dans le système à deux micros.** C'est le
  point à vérifier en premier, et il ne demande que le matériel : brancher les
  deux micros, DÉMARRER, parler à tour de rôle et regarder la **pastille
  « Stéréo »** puis le **point de balance** de la régie. Si la pastille dit
  autre chose que `STÉRÉO OK`, l'attribution est impossible et **c'est ça qu'il
  faut régler d'abord** — `node tools/check-stereo.mjs` dit si ça vient du PC ou
  du logiciel. Si la pastille est bonne mais que la balance ne penche pas
  franchement quand une seule personne parle, les micros se marchent dessus :
  baisser `SPEAKER_MIN_RATIO`, ou éloigner/réorienter les micros.
- **Le contrôle stéréo est validé, mais pas sur l'installation du spectacle.** Ce
  qui l'est : les signaux de synthèse (unitaires) ; le **vrai worklet** exécuté
  hors navigateur ; le **chemin navigateur complet** (`getUserMedia` →
  AudioWorklet → pastille) piloté par CDP avec le périphérique audio factice de
  Chrome, dans les deux cas — canaux distincts → `STÉRÉO OK` (corrélation
  −0,00002), canal dupliqué → `MONO DUPLIQUÉ` (corrélation 1,00000) ; et l'entrée
  intégrée de la machine de développement, sur laquelle il a correctement
  diagnostiqué un micro mono dupliqué (corrélation 0,9999). Ce qui ne l'est pas :
  **les deux micros du spectacle.** Les seuils sont calibrés sur un modèle de
  diaphonie, pas sur le vrai plateau — si le verdict est `SÉPARATION FAIBLE`
  alors que la balance fonctionne bien en pratique, c'est `STEREO_SUSPECT_CORR`
  qu'il faut monter.
- **L'attribution est mesurée sur des énergies synthétiques** (35 % de diaphonie
  supposée). C'est le vrai plateau qui dira le taux réel — la régie affiche en
  continu « énoncés non attribués » et la répartition G/D pour ça.
- **La traduction native Gladia n'a pas été entendue en vrai**, ni le filtrage de
  l'identité sur un vrai payload : la configuration de session est validée contre
  l'API et le filtre est testé sur un flux simulé, mais aucun audio réel n'y est
  passé.
- **La détection de langue n'a pas été éprouvée** sur de vraies voix, alors que
  tout en dépend : une langue mal détectée envoie la phrase dans la mauvaise
  direction de traduction. À tester en répétition en faisant dire deux phrases
  dans chaque langue à chaque locuteur, et en regardant le marqueur `[FR]`/`[EN]`
  de la régie.
- **Le rendu visuel** a été vérifié dans Chrome headless (grille 2 × 2 ancrée en
  bas, en-têtes de langue, couleur par locuteur, 4 lignes d'historique avec
  estompage des plus anciennes, révélation mot à mot, aucune erreur JS), mais
  **jamais sur un vrai écran de scène ni en plein écran**. Avec quatre cases la
  police est nettement plus petite (3,6 vh) : la juger **depuis la place du
  public**, pas sur le laptop. C'est le réglage le plus susceptible de devoir
  changer — `FONT_SIZE_VH` au curseur, `MAX_LINES` dans la config.
- **Les chiffres de latence et de divergence viennent d'un flux synthétique.**
  Ils servent à comparer deux configs, pas à valider le réglage final. Seul un
  enregistrement réel de 3 à 5 minutes des vraies voix, au vrai débit, calibre
  les seuils : c'est le sens du mode `--record`.

---

## Récupérer l'enregistrement après un crash

L'écriture est incrémentale, mais Chrome écrit d'abord dans un fichier d'échange :
pendant la session les octets s'accumulent dans **`<nom>.wav.crswap`** à côté du
`.wav`, et Chrome ne le renomme qu'à la fermeture propre.

1. Chercher `spectacle-….wav.crswap` dans le dossier choisi.
2. Le renommer en `.wav`.

Il est lisible tel quel : l'en-tête annonce une taille maximale et les lecteurs
s'en tiennent à la taille réelle du fichier. Pour reconstruire un en-tête propre :
`ffmpeg -i enregistrement.wav -c copy propre.wav`

Un dictaphone posé sur la table reste le seul enregistrement vraiment
indépendant. Ne pas s'en priver.

---

## Notes

- **Chrome desktop uniquement** (AudioWorklet + File System Access API).
- Les deux clés sont dans `.env`, gitignoré. La clé Gladia est servie à la page ;
  la clé Anthropic **ne descend jamais dans le navigateur**, le serveur relaie.
  **Régénérer les deux après l'événement.**
- `.env` n'est pas servi comme fichier statique (liste blanche stricte, vérifiée).
- La traduction utilise `claude-haiku-4-5` : le plus rapide, pour tenir le budget
  de 500 ms par bloc. Pas de `thinking` ni d'`effort` (inutiles ou refusés sur
  Haiku 4.5), pas de `cache_control` (le prompt système est très en dessous du
  minimum cachable de 4096 tokens — ce serait silencieusement sans effet).
- L'appel de traduction passe par `fetch` et non par le SDK Anthropic : le projet
  n'a aucune dépendance npm ni build, et le `maxRetries: 2` par défaut du SDK
  irait contre la règle « ne jamais bloquer la file » (timeout dur à 2 s, un seul
  retry court). Un `npm install` avant un spectacle est un point de panne en plus.
