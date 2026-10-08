# Veggie Realm

App de recettes/planning de repas en français (PWA), Supabase + Vercel (déploiement auto sur push `main`). Pas d'environnement de dev local : tout se teste en direct sur iPhone (PWA installée via Safari). Toujours committer et pousser directement sur `main`.

- `index.html` : tout le HTML + JS de l'app (pas de build).
- `tokens.css` : primitives (couleurs, tailles, styles de texte, reset de base).
- `components.css` : composants réutilisables.
- `pages.css` : styles propres à un écran donné.
- `api/*.js` : fonctions serverless Vercel.

Toujours utiliser les tokens CSS existants plutôt que des valeurs codées en dur (couleurs, corner-radius, espacements).

## Checklist de fin de thème / fonctionnalité

(Reconstituée à partir de ce qu'on a fait dans cette session — à corriger si j'ai oublié quelque chose.)

1. Vérifier la syntaxe JS : `node -e` qui charge chaque `<script>` de `index.html` via `new Function(...)`.
2. Vérifier l'équilibre des accolades des 3 fichiers CSS (`tokens.css`, `components.css`, `pages.css`).
3. `git add` des fichiers modifiés (jamais `-A`/`.` sans vérifier).
4. Commit avec un message en français décrivant le *pourquoi*, terminé par le footer d'attribution.
5. `git push -u origin main`.
6. Résumer brièvement au user ce qui a changé et ce qui reste à tester sur son iPhone — rappeler de vérifier la "Version du ..." dans Compte (= `document.lastModified`, automatique) si un comportement ne semble pas avoir changé, pour écarter un souci de cache PWA avant de creuser plus loin.

## Bug en pause (mis de côté par l'utilisateur)

- **Bottom sheet pas calé en bas** (PWA installée sur iPhone uniquement — pas reproductible en Safari onglet ni en émulation desktop) : un bandeau de fond de page (cream, `--surface-high`/`--light-50` ou `--light-150`) reste visible sous le panneau d'un bottom sheet (`planOccurrenceSheet`, `courseQtySheet`, `shareMenuModal`), comme si le panneau n'atteignait pas le vrai bas de l'écran. **8 pistes essayées, aucune n'a changé le résultat** (confirmé identique à chaque fois par capture d'écran) :
  1. Retrait de `backdrop-filter` (suspecté avec `position:fixed`).
  2. `min-height:-webkit-fill-available`.
  3. Hauteur mesurée en JS (`--app-height` via `visualViewport.height`/`innerHeight`) avec re-mesures différées (rAF, +300ms, `load`, `pageshow`, `resize`).
  4. Repli CSS en `100dvh` au lieu de `100vh`.
  5. Retrait de `document.documentElement.style.overflow = 'hidden'` posé par `lockBackgroundScroll()` (hypothèse : rognait les éléments fixed en-dessous).
  6. Panneau en `position:fixed;bottom:0` directement au lieu d'un alignement flex dans un conteneur englobant.
  7. Décalage négatif `bottom:calc(-1 * env(safe-area-inset-bottom))` sur voile + panneau (hypothèse zone de sécurité/indicateur d'accueil — la mesure de l'espace sur capture correspondait à peu près à cette valeur, mais le correctif n'a rien changé, donc écarté).
  8. Retrait de l'imbrication `position:fixed` dans `position:fixed` (voile + panneau étaient enfants d'un conteneur englobant lui-même `position:fixed;inset:0` — hypothèse d'un bug WebKit de calcul relatif à l'ancêtre plutôt qu'au viewport ; `#bottomNav`, structurellement différent — fixed direct, sans wrapper — n'a lui jamais ce problème).
  
  Piste non explorée pour la prochaine fois : `#bottomNav` reste affiché (`display:flex`) derrière les sheets, qui ont pourtant un z-index supérieur (400 vs 100) — vérifier si un ancêtre crée un contexte d'empilement qui invalide cette comparaison, ou simplement masquer `#bottomNav` à l'ouverture d'un sheet (via `lockBackgroundScroll`/`unlockBackgroundScroll`, déjà appelés par les 3 sheets concernés) pour éliminer la variable au lieu de continuer à deviner sur le positionnement du sheet lui-même.

## Backlog / idées pour plus tard

- **Audit visuel** : parcourir l'app et unifier avec les tokens CSS existants (repérer les valeurs codées en dur restantes).
- **Cook mode** : retravailler le mode cuisine et la reconnaissance des ingrédients par étape (`ingredientChipsForStep`) — ne fonctionne pas toujours correctement.
- **Toast** : redesign du composant toast + ajout d'un bouton "Annuler" sur les actions concernées. Devient un prérequis pour "marquer comme cuisiné" (voir plus bas) : le garde-fou contre une erreur de clic, c'est ce bouton Annuler, pas un historique séparé.
- **Import Instagram (réel/post)** : tenté et retiré (voir historique git, commit "Retire l'import Instagram") — Instagram ne sert pas la légende (og:description) à une requête serveur, mur anti-bot pour les IPs de datacenter. Le copier-coller manuel (titre + collage dans les champs ingrédients/étapes déjà auto-parsés) reste la solution la plus fiable et la moins chère à maintenir. Pistes de contournement identifiées mais pas retenues pour l'instant, chacune avec un coût réel :
  - Proxy résidentiel / service tiers payant (Apify, RapidAPI...) : contournerait le blocage, mais coût récurrent + dépendance fragile + zone grise niveau CGU Instagram.
  - API officielle Meta : ne résout pas le cas d'usage (accès seulement aux comptes ayant autorisé l'app via OAuth, pas à un post random d'un tiers).
  - Extension de partage native iOS ("Partager → Veggie Realm" depuis l'app Instagram, qui fournirait le texte elle-même) : la piste la plus propre, mais impossible en PWA pure — demanderait de passer à une vraie app native (Capacitor ou équivalent), un chantier bien plus lourd qu'une fonctionnalité.
  À reconsidérer seulement si l'app change de nature (budget scraping, ou passage en app native).
- **Recherche d'image automatique à l'import** (si aucune photo trouvée sur la page source) — idée soulevée, pas retenue pour l'instant : demande une API de recherche d'images (coût récurrent, dépendance externe fragile), même constat que l'import Instagram. Proposer un choix entre 2-3 images améliorerait l'UX mais ne change rien au coût/complexité. À reconsidérer seulement si le contexte budget/priorités change.
- **"Déjà à la maison" / garde-manger persistant** : explicitement écarté — pas le but de l'app (trop de maintenance, contraire à l'objectif de simplicité). La correction manuelle de quantité dans la liste de courses (texte libre, propre à la session, voir `courseQtySheet`/`COURSES_QTY_OVERRIDE_KEY`) reste la seule façon de dire "j'en ai déjà", sans suivi dans le temps.
- **Recette partagée/enregistrée/planifiée : live ou figée ?** Aujourd'hui, `saved_recipes` et `meal_plan` ne stockent qu'une référence (`recipe_id`), jamais une copie — donc tout reflète toujours la version actuelle de la recette, y compris après enregistrement/planification. Remis à plus tard : si on veut "figer" au moment du save/planning, il faut copier le contenu à cet instant (même problème de duplication qu'on a voulu éviter pour les variantes). Pas tranché.

### Décisions prises cette session, prêtes à implémenter

- **Variantes de recettes** : même fiche recette (même ligne en base), pas de duplicata — un tableau `variants` embarqué (`{label, ingredients, steps}`), un sélecteur "Version" sur la fiche (affiche "Variante" par défaut, pas "Originale"), mémorisé par compte (`default_variant_label`) et appliqué partout où la fiche est affichée. Le sheet de planning devra aussi permettre de choisir la variante par occurrence (pas juste sur la fiche) — plus gros chantier que prévu initialement.
- **Export PDF/Word d'une recette à variantes** : un seul document, pages séparées, originale d'abord puis chaque variante.
- **Recherche dans "Repas prévus"** : doit filtrer les deux listes (Suggestions *et* les recettes déjà planifiées), pas seulement Suggestions. Les recherches de l'accueil et de Repas prévus restent deux champs indépendants (pas de requête partagée entre les deux écrans).
- **Rayon mal catégorisé / fusionner deux ingrédients similaires** ("poivron" vs "poivron rouge") : pas une correction au cas par cas dans un sheet — un vrai **mode édition** sur l'écran Liste (pattern iOS classique : bouton "Modifier", lignes sélectionnables, barre d'actions en bas "Changer de rayon" / "Fusionner"). **Attend la maquette de l'utilisateur.**
- **Libellés des actions de réinitialisation**, pour ne plus avoir trois "Réinitialiser" ambigus au même endroit :
  - "Réinitialiser le planning" (vide tout le planning de la semaine) — reste disponible même quand des recettes sont planifiées, pas seulement quand la liste est vide.
  - "Retirer la recette" (une seule recette, depuis son sheet d'édition).
  - "Réinitialiser les quantités" (écran Liste : remet les cases décochées et annule les corrections manuelles de quantité, sans toucher au planning).
  - Les deux premiers deviennent un bouton icône seul à côté du titre "Courses" (même emplacement, action et texte de confirmation selon l'onglet actif Repas prévus/Liste), qui ouvre un dialogue de confirmation avec texte explicatif plutôt qu'un lien texte dans le contenu.
- **Groupe de rayon entièrement coché** dans la liste de courses : se referme automatiquement (reste à la même place, pas renvoyé en bas), avec le même délai que l'animation existante (800ms) avant de se refermer — pas de fermeture instantanée.
- **"Marquer comme cuisiné"** : une occurrence marquée cuisinée quitte le planning (même effet que la supprimer depuis le sheet) et alimente le compteur "cuisiné +Nx" de l'accueil — une seule action, deux effets. Pas besoin d'un mode séparé "à cuisiner", ni d'un bouton "Réinitialiser" mis en avant quand tout est fait : le planning vide est déjà le signal (état "Aucun repas prévu" existant). Pas d'archive des recettes cuisinées non plus — le filet de sécurité contre une erreur de clic, c'est le toast + bouton "Annuler" (voir item Toast ci-dessus). L'action se pose par occurrence (pas par recette entière, pour les recettes à plusieurs repas) : solution court terme sans nouvelle maquette = la poser dans le sheet d'édition existant, à côté de chaque puce de repas déjà individualisée là-bas.

### En attente d'une maquette de l'utilisateur

- **Mode édition de la liste de courses** (déplacer un ingrédient vers un autre rayon, fusionner deux articles similaires) — voir décision ci-dessus.
- **Case à cocher "cuisiné" par occurrence** sur la carte d'une recette planifiée — chaque repas prévu a maintenant sa propre ligne (fait), reste à ajouter la case à cocher individuelle. Pas bloquant : solution provisoire posée dans le sheet d'édition en attendant.
- **Badge "tous les ingrédients cochés"** sur une recette planifiée — l'utilisateur ne veut pas d'un mode "à cuisiner" séparé (on peut cuisiner sans avoir coché 100% des ingrédients), mais un badge visuel sur la carte quand c'est le cas serait utile.
- **Vue de la liste de courses groupée par recette** (en plus du regroupement par rayon existant) — idée soulevée en lien avec le badge ci-dessus, pas encore de maquette.
- **Partage/édition pas évidents** (cité 2 fois) — les icônes seules (partage/crayon/poubelle) sur la fiche recette n'ont aucun libellé. Doit être réglé par le futur menu kebab unique (remplace les 3 icônes), déjà présent dans la maquette Figma.
- **Export de la liste de courses vers Rappels (iOS)** — aucune API web ne permet à une PWA iOS d'écrire directement dans l'app Reminders. Le plus réalisable : partager la liste formatée via la feuille de partage native (Reminders peut créer un seul rappel avec le texte), pas un import article par article. À confirmer que ça convient avant d'investir dessus.
- **Importer une liste de courses** — cas d'usage pas clair (texte collé ? photo ? export d'une autre app ?), besoin d'un exemple concret avant de concevoir quoi que ce soit.
