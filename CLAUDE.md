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
