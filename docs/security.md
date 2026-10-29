# Sécurité et confidentialité

## Modèle de menace

ASSISTANT lit des contenus **non fiables** (mails, documents, transcriptions, pages) et agit au nom de l'utilisateur. Les risques principaux : injection de prompt, fuite de données vers l'IA ou un plugin, vol de clés, actions non voulues.

## Mesures

**Chiffrement et secrets**
- Base SQLCipher par profil ; la clé aléatoire (32 octets) est dans le trousseau du système.
- Clés API : trousseau uniquement (`api-key:<profil>:<fournisseur>`), jamais dans les réglages, journaux ou exports. L'interface ne peut pas les relire.
- Jetons Google : dans la base chiffrée (jamais exposés à l'interface).
- Verrouillage optionnel par mot de passe (Argon2) : tant que l'application est verrouillée, **la base n'est pas ouverte** et le moteur ne tourne pas.

**Données envoyées à l'IA**
- Minimum nécessaire : objet/expéditeur/début du corps (4 000 caractères) pour le tri ; extraits pertinents pour le chat ; 12 000 caractères pour le résumé d'un document.
- Masquage avant envoi (option activée par défaut) : IBAN (contrôle de validité), numéros de carte (Luhn), mots de passe annoncés, clés API connues.
- Les données récupérées sont placées dans un message *utilisateur* (donc masqué par le routeur), jamais dans le message système.
- L'agent d'analyse est **désactivé par défaut** (consentement explicite). L'apprentissage du style ne se déclenche que sur clic, avec un accord préalable.

**Injection de prompt**
- Tout contenu externe est encadré par des balises « données » ; les balises de fermeture sont neutralisées ; les consignes système rappellent de ne jamais obéir au contenu.
- La sortie du modèle est **validée strictement** (schéma, dates plausibles, bornes) et chaque suggestion doit citer un **extrait exact retrouvé** dans la source ; sinon la confiance est divisée par deux et la suggestion ne peut pas être appliquée seule.
- Le modèle n'a aucun outil d'action directe : il produit des *propositions*. Les outils du chat et des plugins créent des suggestions « À valider ».
- Des tests simulent un modèle qui *obéit* à un mail/une capture piégé(e) : rien ne s'exécute seul.

**Actions et traçabilité**
- Quatre niveaux d'autonomie ; envoi de mail, suppression et paiement exigent toujours une validation (et ne sont pas implémentés sans validation).
- Journal d'audit de toutes les actions de l'IA, des plugins et de l'utilisateur ; actions d'ajout/modification annulables.

**Plugins**
- Permissions déclarées, acceptées exactement par l'utilisateur ; élargissement = nouvel accord.
- Processus Node séparé avec `--permission` (pas de fichiers hors du dossier du plugin, pas de processus enfants/workers/modules natifs), sans variables d'environnement, 128 Mo, 60 s. `fetch` et modules réseau retirés ; réseau uniquement via un courtier HTTPS (hôte déclaré, pas d'adresse privée, pas de redirection vers un autre hôte).
- Empreinte des fichiers vérifiée à chaque exécution.
- **Limite** : ce n'est pas une isolation au niveau de l'OS. Ne pas installer de plugin dont l'auteur n'est pas de confiance.

**OAuth Google**
- PKCE (S256), `state` vérifié, redirection sur `127.0.0.1`, URL d'autorisation limitée à `accounts.google.com`, droits en lecture seule demandés fonctionnalité par fonctionnalité.

**Interface**
- Contenu externe (mails, réponses du modèle) rendu en texte brut ; CSP restrictive.
- Aucun `eval`, aucun HTML injecté.

## Limites connues

- Les installateurs ne sont pas signés (Gatekeeper/SmartScreen avertissent). Les mises à jour automatiques sont, elles, signées par une clé minisign propre au projet.
- Déverrouillage biométrique non disponible.
- L'audio système d'une visioconférence n'est pas capté directement (micro ou périphérique de bouclage).
- Un fournisseur IA reçoit les extraits qui lui sont destinés : choisissez-le en conséquence (politique de rétention, région).

## Signaler une vulnérabilité

Merci de contacter le mainteneur **en privé** (pas d'issue publique) avec une description et, si possible, un cas de reproduction.
