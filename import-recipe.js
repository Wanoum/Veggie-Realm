// Fonction serverless Vercel : /api/import-recipe?url=...
// Récupère une page de recette et en extrait les données structurées (schema.org/Recipe)
// que la plupart des sites de recettes intègrent (JSON-LD).

function parseIsoDuration(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const hours = parseInt(m[1] || '0', 10);
  const minutes = parseInt(m[2] || '0', 10);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

function extractText(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x.text === 'string') return x.text;
  return '';
}

function parseIngredientLine(line) {
  const trimmed = line.trim();
  // Essaie de repérer une quantité au début (ex: "200 g farine", "1 oignon jaune")
  const match = trimmed.match(/^([\d]+[.,]?[\d]*)\s*([a-zA-Zàâäéèêëîïôöùûüçœ.]*)\s+(.*)$/);
  if (match) {
    const quantity = parseFloat(match[1].replace(',', '.'));
    const unit = match[2] || null;
    const name = match[3].trim();
    if (name) return { quantity: isNaN(quantity) ? null : quantity, unit, name };
  }
  return { quantity: null, unit: null, name: trimmed };
}

function findRecipeInJsonLd(data) {
  const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
  for (const item of items) {
    if (!item || !item['@type']) continue;
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    if (types.includes('Recipe')) return item;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Paramètre url manquant.' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL invalide.' });
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VeggieRealmImporter/1.0)' }
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Le site a répondu avec une erreur (${response.status}).` });
    }
    const html = await response.text();

    const scriptMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

    let recipe = null;
    for (const m of scriptMatches) {
      try {
        const data = JSON.parse(m[1].trim());
        const found = findRecipeInJsonLd(data);
        if (found) { recipe = found; break; }
      } catch {
        // JSON invalide sur ce bloc, on continue avec les suivants
      }
    }

    if (!recipe) {
      return res.status(404).json({ error: "Impossible de trouver une recette structurée sur cette page. Cette fonctionnalité fonctionne avec la plupart des sites de recettes connus, mais pas tous." });
    }

    let instructions = recipe.recipeInstructions || [];
    if (typeof instructions === 'string') {
      instructions = instructions.split(/\r?\n+/);
    }
    const steps = (Array.isArray(instructions) ? instructions : [instructions])
      .flatMap(ins => {
        if (ins && ins.itemListElement) return ins.itemListElement.map(extractText);
        return [extractText(ins)];
      })
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const rawIngredients = recipe.recipeIngredient || recipe.ingredients || [];
    const ingredients = rawIngredients.map(parseIngredientLine).filter(ing => ing.name);

    let image = recipe.image || null;
    if (Array.isArray(image)) image = image[0];
    if (image && typeof image === 'object') image = image.url || null;

    let servings = null;
    if (recipe.recipeYield) {
      const yieldStr = Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield;
      const yieldMatch = String(yieldStr).match(/\d+/);
      if (yieldMatch) servings = parseInt(yieldMatch[0], 10);
    }

    return res.status(200).json({
      title: recipe.name || '',
      photo_url: image,
      servings,
      cook_time_minutes: parseIsoDuration(recipe.cookTime),
      oven_temp_celsius: null,
      ingredients,
      steps,
      source_url: targetUrl.toString()
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lors de la récupération de la page : ' + err.message });
  }
}
