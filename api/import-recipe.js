// Fonction serverless Vercel : /api/import-recipe?url=...
// Récupère une page de recette et en extrait les données structurées (schema.org/Recipe)
// que la plupart des sites de recettes intègrent (JSON-LD).

import dns from 'node:dns/promises';
import net from 'node:net';

// Certains sites peuvent être nettement plus lents à charger qu'un simple
// blog de recettes ; le budget doit rester inférieur à maxDuration pour
// laisser le temps au reste du traitement (DNS, analyse).
const FETCH_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 3 Mo, largement suffisant pour une page de recette
const MAX_REDIRECTS = 5;

export const maxDuration = 45;

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

// Fallback : certains sites utilisent le Microdata (attributs itemprop) plutôt que le JSON-LD.
function findRecipeInMicrodata(html) {
  const scopeMatch = html.match(/itemscope[^>]*itemtype=["'][^"']*schema\.org\/Recipe["'][\s\S]*?(?=<\/body>)/i);
  if (!scopeMatch) return null;
  const block = scopeMatch[0];

  function grabAll(prop) {
    const re = new RegExp(`itemprop=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(block))) results.push(m[1]);
    if (results.length === 0) {
      const re2 = new RegExp(`itemprop=["']${prop}["'][^>]*>([^<]*)<`, 'gi');
      while ((m = re2.exec(block))) results.push(m[1].trim());
    }
    return results;
  }

  const name = grabAll('name')[0] || '';
  const image = grabAll('image')[0] || null;
  const recipeIngredient = grabAll('recipeIngredient');
  const recipeInstructions = grabAll('recipeInstructions');
  const recipeYield = grabAll('recipeYield')[0] || null;
  const cookTime = grabAll('cookTime')[0] || null;

  if (!name && recipeIngredient.length === 0) return null;

  return {
    name,
    image,
    recipeIngredient,
    recipeInstructions,
    recipeYield,
    cookTime
  };
}

// ---- Protection SSRF ----
// Cet endpoint est public (pas d'authentification) et fait une requête HTTP
// depuis le serveur vers une URL fournie par n'importe quel appelant. Sans
// contrôle, il peut servir à sonder ou atteindre des adresses internes/privées
// (localhost, métadonnées cloud, réseau privé de l'hébergeur) ou être détourné
// comme proxy HTTP ouvert. On limite donc les cibles aux adresses IP publiques.

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  const [a, b, c] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "cette machine"
  if (a === 169 && b === 254) return true; // link-local, y compris métadonnées cloud (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239) + réservé (240-255)
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / non spécifiée
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10, link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7, unique local
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);
  return false;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // format non reconnu : on refuse par prudence
}

async function assertPublicHost(hostname) {
  if (hostname.toLowerCase() === 'localhost') {
    throw httpError(400, "Cette adresse n'est pas autorisée.");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw httpError(400, "Cette adresse n'est pas autorisée.");
    return;
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw httpError(400, "Impossible de résoudre l'adresse de ce site.");
  }
  if (addresses.length === 0 || addresses.some(a => isPrivateIp(a.address))) {
    throw httpError(400, "Cette adresse n'est pas autorisée.");
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Suit les redirections manuellement (en revalidant chaque destination) et
// borne la taille de la réponse lue pour éviter l'épuisement mémoire.
//
// Un seul chrono pour toute l'opération (connexion + redirections + lecture
// du corps), pas un par étape : le découpage précédent réarmait un nouveau
// délai à chaque étape et l'annulait dès la réception des en-têtes, avant
// même de lire le corps de la réponse — un site qui répond vite puis traîne
// à envoyer le corps (volontairement ou non, Instagram y compris) pouvait
// ainsi bloquer la lecture indéfiniment, sans jamais déclencher d'erreur.
async function fetchHtmlSafely(startUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = startUrl;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw httpError(400, 'Seules les URLs http/https sont autorisées.');
      }
      await assertPublicHost(current.hostname);

      let response;
      try {
        response = await fetch(current.toString(), {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
          }
        });
      } catch (err) {
        if (err.name === 'AbortError') throw httpError(504, "Le site met trop de temps à répondre.");
        throw httpError(502, "Impossible de contacter ce site.");
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw httpError(502, 'Redirection sans destination.');
        current = new URL(location, current);
        continue;
      }

      if (!response.ok) {
        throw httpError(502, `Le site a répondu avec une erreur (${response.status}).`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
        throw httpError(413, 'La page est trop volumineuse.');
      }

      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_RESPONSE_BYTES) {
            reader.cancel();
            throw httpError(413, 'La page est trop volumineuse.');
          }
          chunks.push(value);
        }
      } catch (err) {
        if (err.name === 'AbortError') throw httpError(504, "Le site met trop de temps à répondre.");
        throw err;
      }
      return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
    }
  } finally {
    clearTimeout(timeout);
  }
  throw httpError(400, 'Trop de redirections.');
}

// Anon key publique, déjà embarquée dans index.html (client-side) : ce n'est
// pas un secret, elle sert uniquement à valider le token de session envoyé
// par l'appelant auprès de l'API Auth de Supabase.
const SUPABASE_URL = 'https://bhsftmcluaqztkfnwobx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoc2Z0bWNsdWFxenRrZm53b2J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTE1ODgsImV4cCI6MjEwNDc4NzU4OH0.ovrCW7IRhkH8tfMYyExNp6zKt60EJMpJLcehlastIAI';

// Cet endpoint fait une requête serveur vers une URL externe ; sans
// authentification, n'importe qui sur internet peut l'appeler comme
// "fetcher" HTTP gratuit hébergé sur ce compte Vercel. On exige donc un
// utilisateur Veggie Realm connecté.
async function assertAuthenticated(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw httpError(401, 'Authentification requise.');

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
    });
  } catch {
    throw httpError(401, 'Authentification invalide.');
  }
  if (!response.ok) throw httpError(401, 'Authentification invalide.');
}

export default async function handler(req, res) {
  try {
    await assertAuthenticated(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

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

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Seules les URLs http/https sont autorisées.' });
  }

  try {
    const html = await fetchHtmlSafely(targetUrl);

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
      recipe = findRecipeInMicrodata(html);
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
    const status = err.status || 500;
    const message = err.status ? err.message : ('Erreur lors de la récupération de la page : ' + err.message);
    return res.status(status).json({ error: message });
  }
}
