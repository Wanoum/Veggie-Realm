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
6. Résumer brièvement au user ce qui a changé et ce qui reste à tester sur son iPhone.

## Backlog / idées pour plus tard

- **Variantes de recettes** (ex : une variante "sans gluten" d'une recette existante). Piste envisagée : lien léger plutôt qu'un vrai système de diff — chaque variante reste une recette normale et complète (même table), avec une référence optionnelle vers la recette d'origine (`variant_of`) + un petit libellé ("Sans gluten"). Avantage : tout le reste de l'app (fiche, cook mode, planning, édition) fonctionne sans modification, on ajoute juste un badge/groupement sur la fiche recette et un raccourci "dupliquer comme variante" dans le wizard. Inconvénient : pas de mise à jour automatique des variantes si la recette d'origine change (pas de contenu réellement partagé).
- **Audit visuel** : parcourir l'app et unifier avec les tokens CSS existants (repérer les valeurs codées en dur restantes).
- **Cook mode** : retravailler le mode cuisine et la reconnaissance des ingrédients par étape (`ingredientChipsForStep`) — ne fonctionne pas toujours correctement.
- **Toast** : redesign du composant toast + ajout d'un bouton "Annuler" sur les actions concernées.
- **Import Instagram (réel/post)** : tenté et retiré (voir historique git, commit "Retire l'import Instagram") — Instagram ne sert pas la légende (og:description) à une requête serveur, mur anti-bot pour les IPs de datacenter. Le copier-coller manuel (titre + collage dans les champs ingrédients/étapes déjà auto-parsés) reste la solution la plus fiable et la moins chère à maintenir. Pistes de contournement identifiées mais pas retenues pour l'instant, chacune avec un coût réel :
  - Proxy résidentiel / service tiers payant (Apify, RapidAPI...) : contournerait le blocage, mais coût récurrent + dépendance fragile + zone grise niveau CGU Instagram.
  - API officielle Meta : ne résout pas le cas d'usage (accès seulement aux comptes ayant autorisé l'app via OAuth, pas à un post random d'un tiers).
  - Extension de partage native iOS ("Partager → Veggie Realm" depuis l'app Instagram, qui fournirait le texte elle-même) : la piste la plus propre, mais impossible en PWA pure — demanderait de passer à une vraie app native (Capacitor ou équivalent), un chantier bien plus lourd qu'une fonctionnalité.
  À reconsidérer seulement si l'app change de nature (budget scraping, ou passage en app native).
- **Liste de courses : "déjà à la maison"** — réfléchir à un moyen de marquer qu'on a déjà tel ou tel ingrédient chez soi, pour qu'il n'apparaisse pas (ou soit exclu) dans la liste de courses générée depuis le planning. Pas encore de piste technique choisie.

### Retours utilisateur (feedback, pas encore traités — design volontairement pas touché, l'utilisateur fait ses propres écrans)

- **Partage/édition pas évidents** (cité 2 fois) — les icônes seules (partage/crayon/poubelle) sur la fiche recette n'ont aucun libellé. Probablement le point le plus gênant à l'usage.
- **Tabs pas évidents qu'on peut cliquer** — à l'ajout de recette et dans le planning (sous-onglets Recettes/Liste de courses, ou tuiles de type de repas — pas confirmé lequel précisément). Seul indice actuel : changement de fond/couleur à la sélection.
- **Recherche : pourquoi cette recette ressort-elle ?** — `matchesSearch()` filtre sur titre + ingrédients mais n'indique jamais lequel a matché. Idée : afficher le nom de l'ingrédient matché sous le titre dans les résultats, quand ce n'est pas le titre qui a matché.
- **Rayon mal catégorisé, pouvoir déplacer** — au-delà des bugs de catégorisation déjà corrigés, il y aura toujours des cas mal classés. Idée : mémoriser un override manuel par nom d'ingrédient normalisé (localStorage, comme le tri des courses), prioritaire sur `categorizeIngredient()`, quand l'utilisateur déplace un article vers un autre rayon.
- **Planning perçu comme "une histoire de date"** alors qu'il n'y a aucune notion de date actuellement (juste un nombre de repas par type) — à trancher : simplifier la présentation pour que Planning soit perçu comme un simple constructeur de liste de courses (sans toucher à la logique), ou au contraire ajouter une vraie notion de date/calendrier. Deux chantiers très différents, pas encore choisi.
- **Recherche dans le planning** — ajouter un champ de recherche similaire à celui de l'accueil, sur l'écran Planning.
- **Variante à lire depuis la recette** — lien avec l'idée "Variantes de recettes" ci-dessus, mais formulation à clarifier avec l'utilisateur (afficher une variante existante directement sur la fiche recette ?).
- **Export de la liste de courses vers Rappels (iOS)** — aucune API web ne permet à une PWA iOS d'écrire directement dans l'app Reminders. Le plus réalisable : partager la liste formatée via la feuille de partage native (Reminders peut créer un seul rappel avec le texte), pas un import article par article. À confirmer que ça convient avant d'investir dessus.
- **Importer une liste de courses** — cas d'usage pas clair (texte collé ? photo ? export d'une autre app ?), besoin d'un exemple concret avant de concevoir quoi que ce soit.
- **"Liste de courses bug"** — signalé sans détail ; besoin d'un exemple précis (écran, action, résultat inattendu) avant de pouvoir agir.
