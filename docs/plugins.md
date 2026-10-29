# Plugins

Un plugin est un dossier contenant un `manifest.json` et un module JavaScript (ES module). Il s'exécute dans un
processus isolé, avec uniquement les permissions que l'utilisateur a acceptées.

## Structure

```
mon-plugin/
  manifest.json
  index.mjs        ← fichier d'entrée (champ "entry")
```

### manifest.json

```json
{
  "id": "mon-plugin",
  "name": "Mon plugin",
  "version": "1.0.0",
  "description": "Ce que fait le plugin.",
  "permissions": ["documents:read", "propose"],
  "triggers": [{ "event": "document.indexed" }],
  "tools": [
    { "name": "mon_outil", "description": "Ce que fait l'outil", "parameters": { "type": "object", "properties": { "q": { "type": "string" } }, "required": ["q"] } }
  ],
  "entry": "index.mjs"
}
```

- `id` : minuscules, chiffres et tirets. `version` : `x.y.z`.
- `triggers` : événements auxquels le plugin s'abonne — `document.indexed`, `mail.analyzed`, `agent.cycle`.
- `tools` : outils proposés au chat. Ils apparaissent sous le nom `plugin:<id>:<outil>` dans les préréglages
  (onglet « Préréglages » → outils autorisés). Les noms d'outils ne contiennent pas `__`.

### index.mjs

```js
export default {
  on: {
    "document.indexed": async (ctx, event) => {
      const doc = await ctx.documents.get(event.id);
      await ctx.proposals.create({ kind: "task", title: `Relire ${doc.name}`, reason: "Nouveau document" });
    },
  },
  tools: {
    mon_outil: async (ctx, args) => `Résultat pour ${args.q}`,
  },
};
```

Un plugin est un module **autonome** : il ne peut pas importer de paquets externes ni lire d'autres fichiers que
les siens. Les auteurs TypeScript compilent vers un seul fichier `.mjs` et peuvent utiliser les types de
`@assistant/plugins-sdk` (`PluginContext`, `definePlugin`).

## Permissions

| Permission | Donne accès à |
|---|---|
| `ai` | `ctx.ai.complete()` — utilise le modèle configuré (consomme du budget ; masquage des données sensibles appliqué) |
| `documents:read` | `ctx.documents.list/get` |
| `mail:read` | `ctx.mail.search/get` |
| `calendar:read` | `ctx.calendar.list` |
| `memory:read` / `memory:write` | `ctx.memory.neighbors` / `ctx.memory.link` |
| `propose` | `ctx.proposals.create` — crée une suggestion dans « À valider » |
| `net:<hôte>` | `ctx.net.fetch` vers cet hôte, en HTTPS uniquement |

Toujours disponibles : `ctx.storage` (100 Ko par valeur, 200 clés) et `ctx.log`.

Principes :

- **Moindre privilège** : sans permission accordée, l'appel d'API est refusé côté application.
- **Jamais d'action directe** : un plugin ne peut pas créer d'événement, de tâche ou de mail ; il *propose*, l'utilisateur valide.
- **Consentement explicite** : à l'activation, l'utilisateur voit la liste et doit accepter exactement ces permissions. Une mise à jour qui élargit les permissions désactive le plugin jusqu'à un nouvel accord.
- **Réseau courtier** : `net.fetch` refuse les adresses privées (réseau local, métadonnées cloud), les ports non standard et les redirections vers un autre hôte.
- **Audit** : les appels d'IA, de réseau, d'écriture et les suggestions sont journalisés avec l'acteur `plugin:<id>`.
- **Intégrité** : l'empreinte des fichiers est calculée à l'installation ; un plugin modifié ensuite est désactivé.

## Bac à sable

Chaque exécution lance un processus Node séparé (`--permission`) : pas d'accès aux fichiers hors de son dossier, pas de
processus enfants, pas de workers ni de modules natifs, aucune variable d'environnement, mémoire limitée à 128 Mo et
délai maximal de 60 s. `fetch`, `WebSocket` et les modules réseau (`net`, `http`, `dns`…) sont retirés ; tout accès
réseau passe par `ctx.net.fetch`.

> **Limite à connaître** : c'est un bac à sable applicatif, pas une isolation au niveau du système d'exploitation. Il
> protège contre les erreurs et les plugins mal intentionnés *simples*, pas contre du code hostile déterminé. N'installez
> que des plugins dont vous faites confiance à l'auteur.

## Installer un plugin

Page **Plugins** → « Installer depuis un dossier » (ou plugins officiels livrés dans `/plugins`). Le plugin est
installé *désactivé* ; l'activer demande d'accepter ses permissions.

## Exemples

- `plugins/example-hello` : le plus petit plugin possible (aucune permission).
- `plugins/graphify` : extrait des relations entre entités et enrichit la mémoire en graphe.
