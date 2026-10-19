# Étape 0 : rapport

19 octobre 2026. Brief : section 7. Script : `scripts/spike.ts`.

## Résumé

| # | Validation | État | Résultat |
|---|---|---|---|
| 1 | Transcription Chatwoot | **Pas encore exécutée** | Il manque la boîte API « Boîte vocale », le jeton du service et l'accès réseau à Chatwoot (voir « Ce qui bloque »). Le script est prêt. |
| 2 | Formes des réponses Chatwoot | **En partie** | Formes connues d'après le connecteur Chatwoot de LBC, déjà en production. Le client accepte toutes les formes; le script les journalisera au premier vrai essai. |
| 3 | Boîte courriel | **Pas encore exécutée** | Même blocage que le 1. La boîte existe : « Service » #83590 (service@lesbellescombines.com). |
| 4 | Recherche Shopify par téléphone | **Faite** (lecture seule) | `defaultPhoneNumber` n'est rempli que pour **43 %** des clients récents, mais la recherche `phone:` cherche aussi dans les adresses : **environ 90 %** des clients récents sont trouvables. On peut continuer. |

## 4. Recherche Shopify par téléphone (faite)

Faite avec le connecteur Shopify déjà branché à Claude (lecture seule, boutique « Belles Combines »),
pas encore avec l'app du Dev Dashboard (elle n'existe pas encore). Aucune donnée de client n'est
reproduite ici.

**Schéma.** Confirmé : le type `Customer` n'a plus `email` ni `phone`; `defaultEmailAddress`,
`defaultPhoneNumber`, `numberOfOrders` et `lastOrder` existent. Les deux requêtes du brief
(`CustomerByPhone`, `OrderStatusByName`) passent telles quelles.

**Échantillon.** 150 clients ayant commandé depuis le 19 avril 2026 (114 737 clients au total) :

| Mesure | Résultat |
|---|---|
| `defaultPhoneNumber` rempli | 64 / 150 (43 %) |
| Un numéro quelque part (fiche ou adresse) | environ 137 / 150 (≈ 90 %) |
| Aucun numéro nulle part | une dizaine (la moitié aux États-Unis ou en Europe) |
| Seul numéro mal saisi (« +514… » sans le 1) | 2 / 150 |

**Comportement de `customers(query: "phone:…")`, vérifié sur de vrais clients :**

- trouve le client quand le numéro est sur sa fiche (`defaultPhoneNumber`) **ou seulement dans une de ses
  adresses**, même écrite « (514) 608-8670 » ou « 5145702863 »;
- accepte `+15145551234`, `5145551234` et `15145551234`; les numéros internationaux (+33, +41)
  fonctionnent;
- correspondance exacte : un chiffre de différence, un autre indicatif régional ou les 7 derniers chiffres
  seulement ne donnent rien (aucun faux positif vu);
- `'+1 450 558 3540'` avec des espaces ne trouve rien : il faut bien envoyer le E.164 normalisé (c'est
  ce que fait le service);
- un numéro enregistré « +5144670001 » (sans le 1) n'est pas trouvé avec `+15144670001`.

**Autres constats :**

- `numberOfOrders` arrive en chaîne (`"5"`) : le client le convertit.
- Sans prénom ni nom, `displayName` contient le courriel ou le téléphone : le client ne s'en sert pas
  comme nom.
- Phase 2 (optionnelle) : la plupart des commandes expédiées récentes n'ont **aucun** suivi
  (`trackingInfo` vide), et certaines sont `FULFILLED` avec une expédition au statut `LABEL_PRINTED` ou
  `LABEL_PURCHASED` (étiquette imprimée, pas encore partie). La phrase « a été expédiée le 12 octobre
  avec Postes Canada » serait alors inexacte. À revoir si la phase 2 est retenue.

## État de Chatwoot (lecture seule)

Lu avec l'outil `check_connection` du connecteur Chatwoot de LBC (compte 139187).

| Prérequis du brief (section 14) | État |
|---|---|
| Boîte API « Boîte vocale » | **absente** (seule boîte API : « Octave app » #87526, à ne pas utiliser) |
| Étiquettes `boite-vocale` et `anglais` | **absentes** |
| Boîte courriel | « Service » #83590, service@lesbellescombines.com |
| Transcription audio activée, crédits Captain | non vérifiable avec le connecteur; `npm run spike -- check` l'affichera |
| Jeton API du service | à créer |

## Hypothèses du brief à corriger ou à trancher

1. **`POST /conversations/{id}/labels` remplace la liste des étiquettes, il n'ajoute pas.** Le
   connecteur Chatwoot de LBC le gère déjà ainsi (lecture des étiquettes, puis envoi de l'union). Avec la
   réutilisation d'une conversation ouverte (24 h), envoyer seulement `["boite-vocale"]` effacerait les
   étiquettes mises par l'équipe. Le client du service fait donc lecture + union. *À confirmer au premier
   vrai essai.*
2. **Plusieurs clients Shopify peuvent avoir le même numéro** (famille, doublons). Avec `first: 1`, on
   prendrait le premier sans le savoir, et on écrirait son courriel sur le contact Chatwoot. Proposition :
   demander `first: 2`; s'il y en a deux, ne rien écrire sur le contact et les lister dans la note
   privée. **Décision à prendre.**
3. **Numéros mal saisis dans Shopify** (« +514… » sans le 1, environ 1 % des clients récents).
   Proposition : si la recherche ne donne rien pour un numéro nord-américain, un 2e essai sans le 1.
   Coût : une requête de plus pour les appelants inconnus. **Décision à prendre** (on peut s'en passer).
4. `defaultPhoneNumber` peu rempli (43 %) : **pas un problème**, puisque la recherche couvre les
   adresses (voir plus haut).

## Ce qui bloque les validations 1 à 3

1. **Prérequis Chatwoot** : la boîte API « Boîte vocale » (sans URL de webhook), les étiquettes
   `boite-vocale` et `anglais`, la transcription audio activée avec des crédits Captain, et un jeton API
   (idéalement d'un utilisateur dédié).
2. **Réseau de cette session cloud** : `app.chatwoot.com`, `lesbellescombines.myshopify.com`,
   `api.twilio.com`, `api.openai.com` et `hooks.slack.com` sont refusés par la politique réseau de
   l'environnement. Le script peut tourner sur un poste local, ou ici une fois ces domaines autorisés
   (paramètres de l'environnement cloud → Network access → Allowed domains) et les variables ajoutées à
   l'environnement; une nouvelle session les prend en compte.
3. **Message de test** : `test/fixtures/message-qc.mp3` est pour l'instant une **voix de synthèse
   française** (moteur Pico, hors ligne, 30 s, qualité téléphone). Elle suffit pour savoir si Chatwoot
   transcrit et en combien de temps, pas pour juger la qualité sur un vrai appelant québécois. Il faut un
   vrai message d'environ 30 s, dit au téléphone, avec un courriel dicté et un numéro de commande (le
   texte de `test/fixtures/message-qc.txt` ou un texte semblable, à mettre à jour).

## Lancer les validations

```bash
cp .env.example .env      # remplir CHATWOOT_*, SHOPIFY_*, SPIKE_TEST_EMAIL
npm ci

npm run spike -- check                             # lecture seule
npm run spike -- transcription --yes               # validations 1 et 2 (environ 3 min)
npm run spike -- email --yes                       # validation 3 : vérifier qu'aucun courriel n'arrive
npm run spike -- email --reply <conversation> --yes  # puis : la réponse d'agent doit arriver par courriel
npm run spike -- shopify --sample 200              # validation 4 avec l'app du Dev Dashboard
```

Chaque exécution garde les réponses brutes de Chatwoot dans `spike-output/` (ignoré par git, secrets
masqués) et affiche la forme de chaque réponse. Le test de transcription relit les messages toutes les
5 s et signale tout nouveau texte (dans le message, dans sa pièce jointe ou dans un nouveau message),
avec le délai, le taux d'erreur par mot contre `message-qc.txt`, et si le courriel dicté et le numéro
de commande ont été reconnus.

Le script a été vérifié contre un faux Chatwoot local (formes de réponse du connecteur LBC) : ce test
valide le script, pas Chatwoot. Aucun résultat Chatwoot réel n'est encore disponible.
