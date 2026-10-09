// Fonction serverless Vercel : GET /api/card-images
// Liste dynamiquement les visuels d'illustration (src/card-small-*.svg,
// src/card-big-*.svg) utilisés en remplacement de l'icône générique quand une
// recette n'a pas de photo. Lire le dossier au lieu d'une liste codée en dur
// côté client : ajouter ou retirer un fichier dans src/ suffit, sans toucher
// au code.
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  try {
    // process.cwd() = racine du projet sur Vercel (voir le même choix dans
    // export-recipe.js pour Krylon.otf) : plus fiable qu'import.meta.url ici.
    const dir = path.join(process.cwd(), 'src');
    const files = fs.readdirSync(dir);
    const small = files.filter(f => /^card-small-.*\.svg$/i.test(f)).sort();
    const big = files.filter(f => /^card-big-.*\.svg$/i.test(f)).sort();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json({ small, big });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
