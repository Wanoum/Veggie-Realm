// Fonction serverless Vercel : /api/import-recipe?url=...
// Récupère une page de recette et en extrait les données structurées (schema.org/Recipe)
// que la plupart des sites de recettes intègrent (JSON-LD).

import dns from 'node:dns/promises';
import net from 'node:net';

const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 3 Mo, largement suffisant pour une page de recette
const MAX_REDIRECTS = 5;

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

// ---- Import depuis un post/réel Instagram : pas de schema.org/Recipe sur ces
// pages, seulement une légende en texte libre. On la retrouve dans la balise
// og:description (Instagram y place historiquement un texte du type
// `"<compteur> - username on Instagram: "<légende>""`), puis on lui applique
// la même analyse heuristique que pour un document PDF/Word importé (mêmes
// fonctions, dupliquées ici plutôt que partagées entre fonctions serverless
// — voir api/import-recipe-file.js) : résultat volontairement simple et
// toujours modifiable ensuite, pas de garantie de reconnaissance parfaite.
// Instagram peut aussi tout bonnement refuser de servir la légende à une
// requête serveur (mur de connexion, blocage anti-scraping) : dans ce cas on
// renvoie une erreur explicite plutôt qu'un résultat vide silencieux.

function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function extractMetaContent(html, propName) {
  const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([\\s\\S]*?)["']`, 'i');
  const m1 = html.match(re1);
  if (m1) return decodeHtmlEntities(m1[1]);
  // Ordre des attributs inversé (content avant property/name) sur certaines pages.
  const re2 = new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeHtmlEntities(m2[1]) : null;
}

function isInstagramHost(hostname) {
  return /(^|\.)instagram\.com$/i.test(hostname);
}

function extractInstagramCaption(html) {
  const desc = extractMetaContent(html, 'og:description') || extractMetaContent(html, 'description');
  if (!desc) return null;
  const wrapped = desc.match(/on Instagram:\s*"([\s\S]*)"\s*$/);
  return wrapped ? wrapped[1] : desc;
}

// ---- Analyse heuristique du texte libre (légende Instagram) — reprend la
// logique utilisée pour l'import de document (voir import-recipe-file.js),
// avec en plus le retrait des hashtags et des puces en emoji, fréquents dans
// les légendes de réseaux sociaux mais absents des documents classiques.

function capNormalizeAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function capNormalizeText(s) {
  return (s || '').replace(/ /g, ' ').replace(/#\S+/g, '').trim();
}

function capNormalizeHeading(s) {
  // Les légendes encadrent souvent un titre de section d'emojis décoratifs
  // ("🧾 RECETTE :", "INGREDIENTS 👇") : on les retire des deux côtés avant
  // de comparer aux mots-clés connus.
  const h = capNormalizeAccents(capNormalizeText(s).toLowerCase())
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z\s]+$/g, '')
    .replace(/[:.\s]+$/, '');
  return h.replace(/^(les|la|le|l')\s+/, '');
}

const CAP_ING_HEADINGS = ['ingredients', 'ingredient'];
const CAP_STEP_HEADINGS = ['preparation', 'etapes', 'etape', 'instructions', 'progression', 'methode', 'recette', 'realisation'];

function capIsHeading(line, keywords) {
  const h = capNormalizeHeading(line);
  if (!h) return false;
  if (keywords.includes(h)) return true;
  const words = h.split(/\s+/);
  return words.length <= 4 && keywords.some(k => h.startsWith(k));
}

// Puce en tête de ligne : marqueurs classiques (-, *, •...) ou un ou
// plusieurs emojis décoratifs (✅, 👉, 🔸...), très courants dans les
// légendes Instagram à la place d'une vraie liste à puces.
function capStripListMarker(line) {
  let t = line;
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^\s*[-*•◦‣▪▸►○●]\s*/, '')
      .replace(/^\s*\[[ xX]?\]\s*/, '')
      .replace(/^\s*[☐☑☒✓✔]\s*/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      // Numérotation en emoji "keycap" (1️⃣ 2️⃣ 3️⃣...), courante en légende.
      .replace(/^\s*\d️?⃣\s*/, '')
      .replace(/^[\p{Extended_Pictographic}️\s]+/u, '');
  } while (t !== prev);
  return t.trim();
}

const CAP_KNOWN_UNITS = [
  'g', 'kg', 'ml', 'l', 'cl', 't',
  'sachet', 'sachets', 'piece', 'pieces',
  'tasse', 'tasses', 'pincee', 'pincees',
  'cas', 'cac', 'gousse', 'gousses',
  'tranche', 'tranches', 'feuille', 'feuilles',
  'verre', 'verres', 'botte', 'bottes',
  'paquet', 'paquets'
];

const CAP_FRACTION_VALUES = {
  '½': 0.5, '¼': 0.25, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
};
const CAP_FRACTION_CHARS = Object.keys(CAP_FRACTION_VALUES).join('');
const CAP_LEADING_QUANTITY_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?|[${CAP_FRACTION_CHARS}])\\s*(.*)$`);

function capStartsWithQuantity(s) {
  return new RegExp(`^[\\d${CAP_FRACTION_CHARS}]`).test(s);
}

function capCleanIngredientName(name) {
  return name.replace(/^(de |d')/i, '').replace(/[.\s]+$/, '').trim();
}

function parseIngredientLineHeuristic(line) {
  const t = capStripListMarker(capNormalizeText(line));
  if (!t) return null;
  const match = t.match(CAP_LEADING_QUANTITY_RE);
  if (!match) return { quantity: null, unit: null, name: capCleanIngredientName(t) };

  const quantity = CAP_FRACTION_VALUES[match[1]] != null ? CAP_FRACTION_VALUES[match[1]] : parseFloat(match[1].replace(',', '.'));
  const rest = match[2].trim();
  if (!rest) return { quantity: isNaN(quantity) ? null : quantity, unit: null, name: '' };

  const words = rest.split(/\s+/);
  const firstNorm = capNormalizeAccents(words[0].toLowerCase());
  if (CAP_KNOWN_UNITS.includes(firstNorm)) {
    const name = words.slice(1).join(' ');
    return { quantity: isNaN(quantity) ? null : quantity, unit: words[0], name: capCleanIngredientName(name) };
  }
  return { quantity: isNaN(quantity) ? null : quantity, unit: null, name: capCleanIngredientName(rest) };
}

function capWordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const CAP_SERVINGS_RE = /(\d+)\s*(personnes?|parts?|pi[eè]ces?|convives?)/i;

function extractRecipeFromCaption(rawText) {
  const lines = rawText.split(/\r?\n/).map(capNormalizeText).filter(Boolean);
  if (lines.length === 0) return { title: '', servings: null, ingredients: [], steps: [] };

  // La légende commence souvent par une phrase d'accroche ou une ligne
  // d'emojis plutôt que par le nom du plat : on prend la première ligne qui
  // contient au moins une lettre.
  const titleIdx = lines.findIndex(l => /\p{L}/u.test(l));
  const title = titleIdx === -1 ? lines[0] : lines[titleIdx];
  const rest = lines.filter((_, i) => i !== titleIdx);

  let servings = null;
  let mode = 'body';
  const ingredients = [];
  const steps = [];
  const unclassified = [];

  for (const line of rest) {
    const servingsMatch = line.match(CAP_SERVINGS_RE);
    if (servingsMatch && capWordCount(line) <= 6) {
      servings = parseInt(servingsMatch[1], 10);
      continue;
    }

    if (capIsHeading(line, CAP_ING_HEADINGS)) { mode = 'ingredients'; continue; }
    if (capIsHeading(line, CAP_STEP_HEADINGS)) { mode = 'steps'; continue; }

    if (mode === 'ingredients') {
      const stripped = capStripListMarker(line);
      if (capStartsWithQuantity(stripped)) {
        stripped.split(/\s*[;+]\s*/).forEach(part => {
          const ing = parseIngredientLineHeuristic(part);
          if (ing && ing.name) ingredients.push(ing);
        });
      } else if (capWordCount(line) > 8 && /[.!?]$/.test(stripped)) {
        mode = 'steps';
        steps.push(stripped);
      }
      continue;
    }

    if (mode === 'steps') {
      const stripped = capStripListMarker(line);
      if (stripped) steps.push(stripped);
      continue;
    }

    unclassified.push(line);
  }

  // Aucune section reconnue (pas d'en-tête "Ingrédients"/"Étapes" dans la
  // légende, fréquent sur les réseaux sociaux) : dernier repli sur
  // l'ensemble du texte, ligne par ligne.
  if (ingredients.length === 0 && steps.length === 0 && unclassified.length > 0) {
    unclassified.forEach(line => {
      const stripped = capStripListMarker(line);
      if (!stripped) return;
      if (capStartsWithQuantity(stripped) && capWordCount(line) <= 10) {
        const ing = parseIngredientLineHeuristic(stripped);
        if (ing && ing.name) ingredients.push(ing);
      } else {
        steps.push(stripped);
      }
    });
  }

  return { title, servings, ingredients, steps };
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
async function fetchHtmlSafely(startUrl) {
  let current = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw httpError(400, 'Seules les URLs http/https sont autorisées.');
    }
    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
    } finally {
      clearTimeout(timeout);
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
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
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

    if (isInstagramHost(targetUrl.hostname)) {
      const caption = extractInstagramCaption(html);
      if (!caption || !caption.trim()) {
        return res.status(422).json({ error: "Impossible de lire la légende de ce post. Instagram refuse parfois de la servir à une requête automatisée (mur de connexion) — colle plutôt le texte de la légende directement dans les ingrédients/étapes." });
      }
      const { title, servings, ingredients, steps } = extractRecipeFromCaption(caption);
      const photo = extractMetaContent(html, 'og:image');
      return res.status(200).json({
        title,
        photo_url: photo,
        servings,
        cook_time_minutes: null,
        oven_temp_celsius: null,
        ingredients,
        steps,
        source_url: targetUrl.toString()
      });
    }

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
