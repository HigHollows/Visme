# Architecture

```
┌──────────────────────────── Tauri 2 (Rust) ────────────────────────────┐
│  Interface React/TS (webviews : principale + capture rapide)           │
│        │ invoke("rpc", …)         ▲ événements « sidecar-event »       │
│        ▼                          │                                    │
│  Coque Rust : trousseau (clés), profils, verrou, tray, raccourci       │
│  global, badge, mises à jour, démarrage/arrêt du moteur                │
└───────────────┬────────────────────────────────────────────────────────┘
                │ JSON-RPC 2.0, une ligne JSON par message, sur stdio
┌───────────────▼────────────────────────────────────────────────────────┐
│  Moteur (sidecar Node) — UN processus par profil                       │
│  core : RPC · agent · mémoire · réunions · capture · échéances ·       │
│         style · plugins · documents · recherche · chat                 │
│  ai : AIProvider (Anthropic, OpenAI, compatible) + AIRouter            │
│  connectors : OAuth2 PKCE, Gmail, Google Calendar                      │
│  db : SQLite chiffrée (SQLCipher) + FTS5 + sqlite-vec                  │
└───────────────┬───────────────────────────────┬────────────────────────┘
                │ HTTPS                         │ HTTPS
        API IA (vos clés)               Google (mails, agenda) · GitHub (MAJ)
```

## Principes

- **L'interface ne parle jamais aux API ni à la base** : tout passe par la commande Tauri `rpc`, relayée au moteur. La sécurité, l'audit et le masquage sont donc centralisés.
- **Un profil = un moteur = une base chiffrée.** Changer de profil arrête le moteur et en lance un autre avec la clé de l'autre base : aucun état n'est partagé. La vue combinée ouvre les autres profils dans des moteurs temporaires *en lecture seule* (aucune clé API, aucun agent).
- **Le moteur n'a pas de secret persistant.** La clé de chiffrement de la base et les clés API sont lues dans le trousseau par la coque Rust et transmises au moteur au démarrage (en mémoire seulement).
- **Tout appel IA passe par `AIRouter`** : route par tâche (`triage`, `extraction`, `summary`, `chat`, `draft`, `embedding`, `ocr`, `stt`) avec secours, masquage des données sensibles, plafonds journalier/mensuel, journal d'usage.

## Paquets

| Paquet | Rôle |
|---|---|
| `packages/ai` | Interface `AIProvider` (chat en streaming, outils, vision, embeddings, transcription), adaptateurs, routeur, coûts, masquage (IBAN, cartes Luhn, mots de passe, clés) |
| `packages/db` | Ouverture chiffrée, migrations versionnées (`user_version`), journal d'audit avec données d'annulation, sqlite-vec |
| `packages/connectors` | OAuth2 PKCE + redirection loopback, client Gmail (synchro complète/incrémentale), client Google Calendar |
| `packages/core` | Tout le métier (voir ci-dessous) et le serveur JSON-RPC |
| `packages/schemas` | Réglages (zod) versionnés, migrés, exportés sans secret |
| `packages/plugins-sdk` | Manifeste, permissions, types de l'API des plugins |

### Dans `packages/core`

- `app.ts` : enregistre toutes les méthodes RPC ; les services sont créés à la demande.
- `agent/` : boucle d'arrière-plan (`agent.ts`), analyse des mails (`analyze.ts` : prompt, **validation stricte**, `decide()` selon l'autonomie), échéances (`obligations.ts`).
- `proposals.ts` + `undo.ts` : boîte « À valider », exécution des propositions, apprentissage des refus, annulation.
- `memory.ts` + `retrieval.ts` + `search.ts` : graphe dérivé et éditable, recherche hybride (BM25 + vecteurs fusionnés par RRF), contexte du chat.
- `documents/` : extraction (PDF, Office, texte, images), découpage, indexation, résumé/étiquettes/entités.
- `meetings/`, `capture.ts`, `deadlines.ts`, `style.ts`, `watch.ts`, `admin.ts`.
- `plugins/` : gestionnaire (installation, consentement, API hôte filtrée) et `runner.mjs` (bac à sable).

## Flux de l'agent

```
synchro Gmail/Calendar ─▶ mails non analysés ─▶ [IA « tri »] ─▶ validateAnalysis()
                                                              │ catégorie, résumé
                                                              ▼
                       événements / tâches / échéances ─▶ decide(autonomie, confiance, preuve)
                                          │                     │
                                   skip / propose / auto        ▼
                               À valider ◀──────────── création annulable (journal)
```

## Persistance

SQLite : `kv` (réglages, états), `audit_log`, `nodes/edges`, `chunks` (+ FTS5, `chunk_vec`), `accounts`, `mails` (+ FTS5), `events`, `tasks`, `proposals`, `agent_runs`, `deadlines`, `meetings`, `presets`, `style_profiles`, `drafts`, `plugins`, `usage_log`… Les migrations sont dans `packages/db/src/migrations.ts` (append-only).

## Empaquetage

`scripts/build-sidecar.mjs` produit : un bundle ESM unique du moteur (esbuild), les modules natifs pour la plateforme (SQLCipher, sqlite-vec), le binaire Node (nommé selon la cible Rust, convention « sidecar » de Tauri) et les plugins officiels. En développement, la coque lance `node --import tsx` sur les sources.
