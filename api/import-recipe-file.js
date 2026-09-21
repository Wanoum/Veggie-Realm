// Fonction serverless Vercel : POST /api/import-recipe-file
// Reçoit un fichier PDF ou Word (.docx) envoyé tel quel dans le corps de la
// requête (pas de multipart, juste les octets bruts), en extrait le texte,
// puis applique une analyse heuristique (titres de section connus, puces
// numérotées, etc.) pour reconnaître titre / portions / ingrédients / étapes
// — le même esprit que le collage d'une liste d'ingrédients côté client :
// résultat volontairement simple et toujours modifiable ensuite plutôt que
// de bloquer l'import sur un document mal reconnu.

// Import direct du sous-module pour éviter le "mode debug" de pdf-parse
// (son index.js essaie de lire un PDF de test si require.main === module,
// ce qui peut casser l'exécution en environnement serverless).
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

export const config = {
  api: { bodyParser: false }
};
// L'extraction PDF/Word peut dépasser la durée par défaut sur les plans qui
// autorisent plus de temps ; sans effet (plafonné) sur les plans qui n'en
// donnent pas plus.
export const maxDuration = 45;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 Mo

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Anon key publique, déjà embarquée dans index.html (client-side) : ce n'est
// pas un secret, elle sert uniquement à valider le token de session envoyé
// par l'appelant auprès de l'API Auth de Supabase.
const SUPABASE_URL = 'https://bhsftmcluaqztkfnwobx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoc2Z0bWNsdWFxenRrZm53b2J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTE1ODgsImV4cCI6MjEwNDc4NzU4OH0.ovrCW7IRhkH8tfMYyExNp6zKt60EJMpJLcehlastIAI';

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

async function readRequestBody(req) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_FILE_BYTES) throw httpError(413, 'Fichier trop volumineux (10 Mo max).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- Analyse heuristique du texte extrait ----

function normalizeAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeText(s) {
  return (s || '').replace(/ /g, ' ').trim();
}

function normalizeHeading(s) {
  return normalizeAccents(normalizeText(s).toLowerCase()).replace(/[:.\s]+$/, '');
}

const ING_HEADINGS = ['ingredients', 'ingredient'];
const STEP_HEADINGS = ['preparation', 'etapes', 'etape', 'instructions', 'progression', 'methode', 'recette', 'realisation'];
const SKIP_HEADINGS = ['materiel', 'materiels', 'ustensiles', 'ustensile'];

function isHeading(line, keywords) {
  const h = normalizeHeading(line);
  if (!h) return false;
  if (keywords.includes(h)) return true;
  const words = h.split(/\s+/);
  return words.length <= 4 && keywords.some(k => h.startsWith(k));
}

function stripListMarker(line) {
  let t = line;
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^\s*[-*•◦‣▪▸►○●]\s*/, '')
      .replace(/^\s*\[[ xX]?\]\s*/, '')
      .replace(/^\s*[☐☑☒✓✔]\s*/, '')
      .replace(/^\s*\d+[.)]\s+/, '');
  } while (t !== prev);
  return t.trim();
}

const KNOWN_UNITS = [
  'g', 'kg', 'ml', 'l', 'cl',
  'sachet', 'sachets', 'piece', 'pieces',
  'tasse', 'tasses', 'pincee', 'pincees',
  'cas', 'cac', 'gousse', 'gousses',
  'tranche', 'tranches', 'feuille', 'feuilles',
  'verre', 'verres', 'botte', 'bottes',
  'paquet', 'paquets'
];

function cleanIngredientName(name) {
  return name.replace(/^(de |d')/i, '').replace(/[.\s]+$/, '').trim();
}

function parseIngredientLine(line) {
  const t = stripListMarker(normalizeText(line));
  if (!t) return null;
  const match = t.match(/^([\d]+(?:[.,][\d]+)?)\s*(.*)$/);
  if (!match) return { quantity: null, unit: null, name: cleanIngredientName(t) };

  const quantity = parseFloat(match[1].replace(',', '.'));
  const rest = match[2].trim();
  if (!rest) return { quantity: isNaN(quantity) ? null : quantity, unit: null, name: '' };

  const words = rest.split(/\s+/);
  const firstNorm = normalizeAccents(words[0].toLowerCase());
  if (KNOWN_UNITS.includes(firstNorm)) {
    const name = words.slice(1).join(' ');
    return { quantity: isNaN(quantity) ? null : quantity, unit: words[0], name: cleanIngredientName(name) };
  }
  return { quantity: isNaN(quantity) ? null : quantity, unit: null, name: cleanIngredientName(rest) };
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const SERVINGS_RE = /(\d+)\s*(personnes?|parts?|pi[eè]ces?|convives?)/i;

// Repère titre / portions / ingrédients / étapes à partir du texte brut
// (une ligne par paragraphe). Sans en-tête reconnue pour les étapes (courant
// dans les documents "faits maison"), bascule automatiquement dès qu'une
// ligne longue et sans quantité en tête apparaît après le début des
// ingrédients — signe qu'on est passé à la préparation en prose.
function extractRecipeFromText(rawText) {
  const lines = rawText.split(/\r?\n/).map(normalizeText).filter(Boolean);
  if (lines.length === 0) return { title: '', servings: null, ingredients: [], steps: [] };

  const title = lines[0];
  let servings = null;
  let mode = 'body';
  const ingredients = [];
  const steps = [];
  const unclassified = [];

  for (const line of lines.slice(1)) {
    const servingsMatch = line.match(SERVINGS_RE);
    if (servingsMatch && wordCount(line) <= 6) {
      servings = parseInt(servingsMatch[1], 10);
      continue;
    }

    if (isHeading(line, ING_HEADINGS)) { mode = 'ingredients'; continue; }
    if (isHeading(line, STEP_HEADINGS)) { mode = 'steps'; continue; }
    if (isHeading(line, SKIP_HEADINGS)) { mode = 'skip'; continue; }

    if (mode === 'skip') continue;

    if (mode === 'ingredients') {
      const stripped = stripListMarker(line);
      if (/^\d/.test(stripped)) {
        stripped.split(/\s*[;+]\s*/).forEach(part => {
          const ing = parseIngredientLine(part);
          if (ing && ing.name) ingredients.push(ing);
        });
      } else if (wordCount(line) <= 8) {
        // sous-titre de section ("Pour la pâte", "Matériel"...) : ignoré
        continue;
      } else {
        // ligne longue sans quantité : on est passé à la préparation
        mode = 'steps';
        steps.push(stripped);
      }
      continue;
    }

    if (mode === 'steps') {
      steps.push(stripListMarker(line));
      continue;
    }

    unclassified.push(line);
  }

  // Aucune section reconnue du tout : dernier repli sur l'ensemble du texte.
  if (ingredients.length === 0 && steps.length === 0 && unclassified.length > 0) {
    unclassified.forEach(line => {
      const stripped = stripListMarker(line);
      if (/^\d/.test(stripped) && wordCount(line) <= 10) {
        const ing = parseIngredientLine(stripped);
        if (ing && ing.name) ingredients.push(ing);
      } else {
        steps.push(stripped);
      }
    });
  }

  return { title, servings, ingredients, steps };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  try {
    await assertAuthenticated(req);
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }

  let buffer;
  try {
    buffer = await readRequestBody(req);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  const contentType = (req.headers['content-type'] || '').toLowerCase();
  let text;
  try {
    if (contentType.includes('pdf')) {
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (contentType.includes('word') || contentType.includes('officedocument') || contentType.includes('msword')) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: 'Format non supporté. Utilise un PDF ou un fichier Word (.docx).' });
    }
  } catch (err) {
    return res.status(422).json({ error: "Impossible de lire ce fichier : " + err.message });
  }

  if (!text || !text.trim()) {
    return res.status(422).json({ error: 'Aucun texte trouvé dans ce document.' });
  }

  const { title, servings, ingredients, steps } = extractRecipeFromText(text);

  return res.status(200).json({
    title,
    photo_url: null,
    servings,
    cook_time_minutes: null,
    oven_temp_celsius: null,
    ingredients,
    steps,
    source_url: null
  });
}
