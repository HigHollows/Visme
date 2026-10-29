# Publier une version

## 1. Prérequis uniques

### Clé de signature des mises à jour

Les mises à jour automatiques sont vérifiées par une signature (minisign) — **indépendante** des certificats Apple/Microsoft. La clé publique est dans `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). La clé privée est celle générée avec :

```bash
pnpm --filter @assistant/desktop tauri signer generate -w ~/.tauri/assistant-updater.key
```

1. **Sauvegardez** `~/.tauri/assistant-updater.key` dans un gestionnaire de mots de passe. Si vous la perdez, les installations existantes ne pourront plus se mettre à jour (il faudra réinstaller à la main).
2. Dans le dépôt GitHub : *Settings › Secrets and variables › Actions*, créez :
   - `TAURI_SIGNING_PRIVATE_KEY` : le **contenu** du fichier de clé privée ;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : son mot de passe (vide si la clé n'en a pas).
3. Ne commitez jamais la clé privée. Pour changer de clé, regénérez-la, mettez à jour `pubkey` et publiez une version avec l'ancienne clé *qui embarque la nouvelle pubkey* avant de basculer.

### Point d'accès des mises à jour

`tauri.conf.json` contient `https://github.com/OWNER/REPO/…/latest.json`. La CI remplace `OWNER/REPO` par le dépôt courant avant chaque build (voir `release.yml`). Pour un build local qui doit tester les mises à jour, remplacez-le à la main.

## 2. Publier

```bash
node scripts/bump-version.mjs 1.2.3        # tauri.conf.json, Cargo.toml, apps/desktop/package.json
git commit -am "Version 1.2.3"
git tag v1.2.3 && git push --follow-tags
```

Le workflow **Release** (`.github/workflows/release.yml`) :
1. vérifie que le tag correspond à la version ;
2. prépare le moteur (bundle + Node embarqué + modules natifs) sur chaque plateforme et lance le test de fumée du moteur empaqueté ;
3. construit avec `tauri-action` : `.dmg` (Apple Silicon et Intel), `.exe` (NSIS) et `.msi` (Windows), les archives de mise à jour signées et `latest.json` ;
4. crée un **brouillon** de release. Testez les installateurs, puis cliquez *Publish* : c'est à ce moment que `latest/download/latest.json` devient disponible et que les applications installées proposent la mise à jour.

## 3. Signature de code (à faire plus tard)

Aujourd'hui les installateurs ne sont **pas signés** : Gatekeeper (macOS) et SmartScreen (Windows) avertissent. Le build est prêt pour la signature ; il suffit d'ajouter des secrets et quelques variables à `release.yml` :

**macOS** (Apple Developer, 99 $/an) : certificat « Developer ID Application » exporté en `.p12`.
- Secrets : `APPLE_CERTIFICATE` (base64 du .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (mot de passe d'application), `APPLE_TEAM_ID` — `tauri-action` signe et notarise automatiquement.
- Remplacez `"signingIdentity": "-"` (signature ad hoc) dans `tauri.conf.json` ou laissez la variable d'environnement l'emporter. Les droits nécessaires au moteur Node (JIT, bibliothèques natives, micro) sont déjà dans `entitlements.plist`.

**Windows** : un certificat de signature de code (EV conseillé pour supprimer l'alerte SmartScreen) ou *Azure Trusted Signing*. Renseignez `bundle.windows.signCommand` ou `certificateThumbprint` dans `tauri.conf.json` et les secrets correspondants.

## 4. Dépannage

- *« La version du tag ne correspond pas »* : relancez `bump-version.mjs` puis retaguez.
- *Le moteur n'est pas trouvé au lancement* : `externalBin` attend `binaries/node-<triplet>` — lancez `node scripts/build-sidecar.mjs` avant `tauri build`.
- *Mise à jour refusée* : la clé privée utilisée pour signer ne correspond pas à `pubkey`.
