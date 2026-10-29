# ASSISTANT

Assistant personnel IA de bureau (macOS 12+ et Windows 10/11). Il se connecte à vos mails, votre calendrier et vos documents ; une IA tourne en arrière-plan pour lire, trier, résumer, consigner et proposer des actions.

- **Aucune IA locale.** Toute l'intelligence passe par les API que *vous* connectez avec votre propre clé (Anthropic Claude, OpenAI GPT, tout endpoint compatible OpenAI). Embeddings, OCR et transcription passent aussi par API.
- **Vos données restent chez vous.** Base SQLite chiffrée (SQLCipher) + index vectoriel (sqlite-vec) sur votre machine ; clés API et clé de chiffrement dans le trousseau du système. Aucun serveur à nous : seuls sortent les appels à vos fournisseurs IA, à Google, et la recherche de mises à jour.
- **Vous gardez la main.** Quatre niveaux d'autonomie (observer, proposer, agir avec validation, agir seul), boîte « À valider », journal d'actions annulables, jamais d'envoi de mail ni de suppression sans votre validation.

## Fonctionnalités

| | |
|---|---|
| **Mails** | Gmail (OAuth2 PKCE), lecture seule, synchro incrémentale, tri/résumé/extraction par IA, brouillons de réponse dans votre style |
| **Calendrier** | Google Calendar, vues jour/semaine/mois/agenda, événements locaux, ajouts de l'IA marqués « ajouté par l'IA » avec source et confiance |
| **Documents** | PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, images (OCR par modèle vision), dossiers surveillés, recherche hybride (mots-clés + sémantique) |
| **Agent** | Boucle d'arrière-plan : synchro → analyse → classement → actions, file d'attente, reprise sur limite de débit, résumé du jour et de la semaine |
| **Chat** | Streaming, sources citées, préréglages éditables, `/resume` `/traduis` `/agenda` `/cherche` `/tache`, mentions `@`, outils qui *proposent* |
| **Mémoire** | Graphe de connaissances (personnes, organisations, mails, documents, événements, tâches…), édition manuelle, « oubli ciblé » |
| **Plugins** | Manifeste + permissions explicites, exécution isolée, SDK documenté ([docs/plugins.md](docs/plugins.md)), plugin officiel Graphify |
| **Échéances** | Factures, abonnements, contrats, garanties… : alertes 30/7/1 jours, total mensuel/annuel, doublons, hausses de prix |
| **Réunions** | Enregistrement (consentement), import audio/vidéo, transcription par API avec interlocuteurs, compte-rendu, actions → tâches, rendez-vous → agenda, suppression de l'audio |
| **Capture rapide** | Raccourci global → fenêtre flottante : texte, image, fichier, presse-papiers, note vocale, « dis-moi quoi en faire » |
| **Profils** | Pro / Perso / Association… totalement isolés (base, comptes, clés, mémoire, style, plafonds), changement rapide, vue combinée en lecture seule |
| **Confidentialité** | Masquage IBAN/cartes/mots de passe avant envoi, verrouillage par mot de passe, export RGPD, effacement total, journal d'audit |

## Installation

Téléchargez l'installateur de votre système depuis la page **Releases** du dépôt :

- **macOS** : `.dmg` (Apple Silicon ou Intel).
- **Windows** : `.exe` (recommandé) ou `.msi`.

> ⚠️ **Les installateurs ne sont pas signés** (pas de certificat Apple/Microsoft pour l'instant). Le système affichera donc un avertissement :
>
> - **macOS** : glissez l'application dans *Applications*, puis *clic droit › Ouvrir* la première fois. Si macOS refuse : `xattr -dr com.apple.quarantine /Applications/ASSISTANT.app`.
> - **Windows** : SmartScreen › *Informations complémentaires* › *Exécuter quand même*.
>
> Les **mises à jour automatiques** sont, elles, vérifiées par une signature cryptographique propre au projet.

## Premiers pas

1. **Settings › IA** : ajoutez un fournisseur (Anthropic, OpenAI ou compatible), collez votre clé (elle va dans le trousseau), cliquez *Tester la connexion*, puis choisissez un modèle par tâche (un modèle économique pour le tri, un plus puissant pour le chat…). Fixez vos plafonds de coût.
2. **Settings › Comptes** : créez un *ID client OAuth « application de bureau »* dans la console Google Cloud (pas à pas dans l'écran), puis connectez Gmail et/ou Google Agenda.
3. **Documents** : glissez des fichiers, ou ajoutez un dossier surveillé (Settings › Dossiers).
4. **Settings › Agent** : activez l'analyse automatique. Gardez *Proposer* au début pour voir ce que l'IA suggère avant de lui laisser plus d'autonomie.

Anthropic ne propose ni embeddings ni transcription : configurez ces deux tâches avec OpenAI (ou un fournisseur compatible).

## Développement

Prérequis : **Node ≥ 22** (24 recommandé), **pnpm** (version du champ `packageManager`), **Rust stable**, et sur macOS les outils Xcode en ligne de commande.

```bash
pnpm install
pnpm test            # tests unitaires et d'intégration du cœur (Vitest)
pnpm typecheck       # TypeScript (cœur + interface)
pnpm dev             # lance l'application (Tauri) avec rechargement à chaud
```

Empaqueter en local :

```bash
pnpm build:app       # moteur autonome + application (.app / .dmg ou installateurs Windows)
pnpm smoke:engine    # vérifie le moteur empaqueté (formats, base chiffrée, plugins)
```

Organisation du dépôt :

```
apps/desktop      Interface React + coque Tauri (Rust : trousseau, tray, raccourcis, profils, verrou)
apps/sidecar      Point d'entrée du moteur Node (JSON-RPC sur stdio)
packages/core     Agent, scheduler, mémoire, réunions, capture, échéances, plugins, RPC
packages/ai       Couche « AI Provider » (Anthropic, OpenAI, compatible), routeur, coûts, masquage
packages/db       SQLite chiffrée, migrations, sqlite-vec
packages/connectors  OAuth2, Gmail, Google Calendar
packages/schemas  Schémas de réglages (zod), migrations de réglages
packages/plugins-sdk  Manifeste, types et permissions des plugins
plugins/          Plugins officiels (graphify, exemple)
docs/             Architecture, sécurité, plugins, release
scripts/          Empaquetage du moteur, test de fumée, version
```

Voir [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md) et [CONTRIBUTING.md](CONTRIBUTING.md).

## Publier une version

[docs/release.md](docs/release.md) : changement de version, tag, CI GitHub Actions, clé de signature des mises à jour, passage futur à des installateurs signés.

## Licence

Tous droits réservés (voir [LICENSE](LICENSE)) — à ajuster selon vos intentions.
