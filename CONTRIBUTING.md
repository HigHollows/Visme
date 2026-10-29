# Contribuer

Merci de votre intérêt ! Ce guide décrit comment travailler sur ASSISTANT.

## Mise en place

```bash
pnpm install
pnpm test && pnpm typecheck     # doit être vert avant toute modification
pnpm dev                        # lance l'application
```

Il faut Node ≥ 22, pnpm, Rust stable (et Xcode CLT sur macOS / les Build Tools C++ sur Windows).

## Principes à respecter

1. **Aucune IA locale.** Toute intelligence passe par la couche `packages/ai` (interface `AIProvider`). N'appelez jamais une API de modèle ailleurs.
2. **Tout appel sortant passe par le routeur** (`AIRouter`) : masquage des données sensibles, plafonds de coût, journal d'audit, secours. Les données issues de mails/documents/transcriptions vont dans un message *utilisateur* (donc masqué), jamais dans le message système.
3. **Le contenu externe est une donnée, jamais une instruction.** Encadrez-le par des balises (`<mail>`, `<document>`, `<transcription>`…), neutralisez les balises de fermeture, et **validez strictement** la sortie du modèle (schéma, dates, extrait cité retrouvé dans la source). L'IA n'appelle pas d'outil sensible directement : elle crée des *propositions*.
4. **Aucune action sensible sans validation** (envoi de mail, suppression, paiement). Les actions de l'IA passent par `decide()` (niveau d'autonomie) et sont annulables (journal d'audit avec données d'annulation).
5. **Les secrets ne vont jamais dans la base de réglages, les journaux ni les exports.** Clés API et clé de chiffrement : trousseau du système uniquement.
6. **Étanchéité des profils** : un profil = un sidecar = une base. Ne mettez jamais d'état global partagé entre profils.
7. **Texte brut pour tout contenu externe** dans l'interface (jamais de HTML injecté depuis un mail ou une réponse de modèle).

## Écrire du code

- TypeScript strict. Messages utilisateur en français, commentaires qui expliquent le *pourquoi*.
- **Tests obligatoires** pour tout comportement du cœur : `packages/*/test/*.test.ts` (Vitest). Les fournisseurs externes (IA, Google) sont simulés par un `fetch` injecté — pas de réseau dans les tests. Pour la sécurité, testez aussi les cas hostiles (injection, preuve inventée, chemin piégé, jeton falsifié).
- Nouvelle table : ajoutez une migration à la fin de `packages/db/src/migrations.ts` (jamais de modification d'une migration existante) et mettez à jour le test de version dans `packages/db/test/db.test.ts`.
- Nouvelle méthode RPC : enregistrez-la dans `packages/core/src/app.ts`, validez ses entrées, et testez-la via `createApp()`.
- Nouveau réglage : ajoutez-le au schéma (`packages/schemas`) *avec une valeur par défaut*, pour que les anciens réglages restent valides.
- Interface : accessible au clavier, libellés `aria`, thème clair **et** sombre (`dark:`), français.
- Rust (`apps/desktop/src-tauri`) : gardez la coque fine — trousseau, fenêtres, raccourcis, cycle de vie du moteur. La logique métier vit dans TypeScript, testable.

## Plugins

Voir [docs/plugins.md](docs/plugins.md). Un plugin ne doit jamais demander plus de permissions que nécessaire.

## Pull requests

- Une PR = un sujet. Décrivez le *pourquoi*, les risques (sécurité, données), et ce que vous avez testé.
- La CI (`.github/workflows/ci.yml`) doit passer : types, tests, test de fumée du moteur empaqueté, compilation de la coque.
- Signalez toute faille de sécurité en privé (voir [docs/security.md](docs/security.md)), pas dans une issue publique.
