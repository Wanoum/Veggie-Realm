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
  const h = normalizeAccents(normalizeText(s).toLowerCase()).replace(/[:.\s]+$/, '');
  // Beaucoup de documents "faits maison" écrivent les titres de section avec
  // l'article ("Les ingrédients", "La préparation", "Le matériel") plutôt
  // que le mot seul : on l'ignore pour la reconnaissance.
  return h.replace(/^(les|la|le|l')\s+/, '');
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
  'g', 'kg', 'ml', 'l', 'cl', 't',
  'sachet', 'sachets', 'piece', 'pieces',
  'tasse', 'tasses', 'pincee', 'pincees',
  'cas', 'cac', 'gousse', 'gousses',
  'tranche', 'tranches', 'feuille', 'feuilles',
  'verre', 'verres', 'botte', 'bottes',
  'paquet', 'paquets'
];

// Fractions unicode ("½ T de sucre") : certains documents les utilisent au
// lieu d'écrire "0,5". Converties en valeur décimale à la lecture.
const FRACTION_VALUES = {
  '½': 0.5, '¼': 0.25, '¾': 0.75,
  '⅓': 1 / 3, '⅔': 2 / 3,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875
};
const FRACTION_CHARS = Object.keys(FRACTION_VALUES).join('');
const LEADING_QUANTITY_RE = new RegExp(`^(\\d+(?:[.,]\\d+)?|[${FRACTION_CHARS}])\\s*(.*)$`);

// Une ligne "commence par une quantité" si elle démarre par un chiffre ou
// une fraction unicode — sinon elle a toutes les chances d'être un
// sous-titre ou une phrase de préparation plutôt qu'un ingrédient.
function startsWithQuantity(s) {
  return new RegExp(`^[\\d${FRACTION_CHARS}]`).test(s);
}

function cleanIngredientName(name) {
  return name.replace(/^(de |d')/i, '').replace(/[.\s]+$/, '').trim();
}

function parseIngredientLine(line) {
  const t = stripListMarker(normalizeText(line));
  if (!t) return null;
  const match = t.match(LEADING_QUANTITY_RE);
  if (!match) return { quantity: null, unit: null, name: cleanIngredientName(t) };

  const quantity = FRACTION_VALUES[match[1]] != null ? FRACTION_VALUES[match[1]] : parseFloat(match[1].replace(',', '.'));
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

function looksLikeListMarker(s) {
  return /^\s*[-*•◦‣▪▸►○●]|^\s*\[[ xX]?\]|^\s*[☐☑☒✓✔]/.test(s);
}

// Un PDF renvoie le texte ligne par ligne selon la mise en page visuelle de
// la page : une phrase ou un ingrédient peuvent se retrouver coupés sur
// plusieurs lignes sans rapport avec les vraies frontières de paragraphe
// (contrairement à un .docx, où chaque paragraphe est déjà une ligne). Cette
// passe recolle les lignes qui continuent visiblement la précédente, pour
// que le reste de l'analyse (une ligne = un ingrédient ou une étape)
// fonctionne aussi bien que sur un texte Word.
function dewrapPdfLines(rawText) {
  const rawLines = rawText.split(/\r?\n/);
  const out = [];
  let buffer = '';
  for (const raw of rawLines) {
    const trimmed = normalizeText(raw);
    if (!trimmed) {
      if (buffer) { out.push(buffer); buffer = ''; }
      continue;
    }
    if (!buffer) {
      buffer = trimmed;
      // Le tout premier titre reste toujours une ligne à part entière, même
      // s'il n'est suivi d'aucune ponctuation de fin.
      if (out.length === 0) { out.push(buffer); buffer = ''; }
      continue;
    }
    const isNewEntry = startsWithQuantity(trimmed) || /^\d+\s*:/.test(trimmed) || looksLikeListMarker(trimmed);
    const bufferEndsParagraph = /[.!?:]$/.test(buffer);
    if (isNewEntry || bufferEndsParagraph) {
      out.push(buffer);
      buffer = trimmed;
    } else {
      buffer = buffer + ' ' + trimmed;
    }
  }
  if (buffer) out.push(buffer);
  return out.join('\n');
}

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
      if (/^\d+\s*:/.test(stripped)) {
        // sous-recette numérotée ("1 : Le Fond de Tarte pour...") : ignorée
        continue;
      } else if (startsWithQuantity(stripped)) {
        stripped.split(/\s*[;+]\s*/).forEach(part => {
          const ing = parseIngredientLine(part);
          if (ing && ing.name) ingredients.push(ing);
        });
      } else if (wordCount(line) > 8 && /[.!?]$/.test(stripped)) {
        // phrase complète (ponctuation finale) sans quantité en tête : on est
        // passé à la préparation, même sans en-tête explicite pour l'annoncer
        mode = 'steps';
        steps.push(stripped);
      } else {
        // sous-titre de section ("Pour la pâte", "Matériel"...), ou fragment
        // de phrase coupé par une mise en page en colonnes : ignoré
        continue;
      }
      continue;
    }

    if (mode === 'steps') {
      // Ici on retire juste le préfixe ("1 : Le Fond de Tarte Placez les...")
      // plutôt que d'ignorer toute la ligne comme côté ingrédients : une
      // ligne recollée (PDF) peut faire suivre l'étiquette de sous-recette
      // directement par la vraie étape, sur la même ligne.
      const stripped = stripListMarker(line).replace(/^\d+\s*:\s*/, '');
      if (stripped) steps.push(stripped);
      continue;
    }

    unclassified.push(line);
  }

  // Aucune section reconnue du tout : dernier repli sur l'ensemble du texte.
  if (ingredients.length === 0 && steps.length === 0 && unclassified.length > 0) {
    unclassified.forEach(line => {
      const stripped = stripListMarker(line);
      if (/^\d+\s*:/.test(stripped)) {
        return;
      }
      if (startsWithQuantity(stripped) && wordCount(line) <= 10) {
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
      text = dewrapPdfLines(data.text);
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
