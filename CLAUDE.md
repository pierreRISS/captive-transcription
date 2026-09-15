# Surtitres Live — consignes de travail

## À faire APRÈS CHAQUE modification du projet

Réinstaller l'application de bureau, sans qu'on ait à le demander :

```bash
./desktop/install.sh
```

Pourquoi : Pierre lance le logiciel depuis le sélecteur d'applications Ubuntu
(« Surtitres Live »), pas depuis un terminal. Le lanceur installé sous
`~/.local/bin` est une COPIE de `desktop/captive-transcription-app.sh` — une
modification du script dans le dépôt ne change rien tant que `install.sh` n'a
pas été relancé, et le jour du spectacle il lancerait l'ancienne version.

Le serveur, lui, se relance tout seul : `/api/health` porte `startedAt`, et le
lanceur remplace un serveur plus vieux que les fichiers du projet. Ne pas
casser ce contrôle.

## Vérifications avant de rendre la main

```bash
node tests/test-units.mjs     # modules purs — doit finir à 0 échec
node --check server.mjs
```

## Rappels de style

- Tout est en français : code, commentaires, interface, journal.
- Les commentaires disent POURQUOI (et ce qui casse sinon), pas ce que fait la
  ligne d'en dessous.
- La logique va dans un module de `src/` avec ses tests dans
  `tests/test-units.mjs` ; `operator.html` ne garde que le câblage (DOM,
  réseau, état de session).
- Aucune dépendance npm. Node seul, navigateur seul.
