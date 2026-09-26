// Fonction serverless Vercel : POST /api/export-recipe
// Reçoit les données d'une recette (déjà en mémoire côté client, qui y a
// forcément accès puisqu'il l'affiche) et renvoie un PDF ou un fichier Word
// généré à la volée. Aucun accès à Supabase ici : c'est une simple mise en
// forme, pas une lecture de données protégées.
//
// Important : pdfkit/docx et le chemin de la police (Krylon.otf) ne sont
// importés/résolus qu'À L'INTÉRIEUR du try/catch du handler (via import()
// dynamique), jamais en haut du fichier. Un import statique qui échoue au
// chargement du module (dépendance manquante, police introuvable...) plante
// toute la fonction avant même que le handler ne s'exécute
// (FUNCTION_INVOCATION_FAILED côté Vercel, sans aucun JSON exploitable) —
// ce qui nous est arrivé en prod alors que tout passait en local, faute de
// pouvoir observer les logs serveur. En dynamique, la même erreur devient
// une simple exception attrapée, avec un vrai message renvoyé au client.

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

function sanitizeFileName(name) {
  // Ne retire que les caractères interdits dans un nom de fichier (et les
  // guillemets, qui casseraient l'en-tête Content-Disposition) : on garde
  // les accents, très fréquents dans les titres de recettes en français.
  return (name || 'recette').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'recette';
}

// RFC 6266 : filename= en repli ASCII pour les clients qui ignorent
// filename*, et filename*=UTF-8'' encodé pour les titres accentués.
function contentDispositionHeader(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function formatQty(ing) {
  return [ing.quantity, ing.unit].filter(v => v != null && v !== '').join(' ');
}

function formatMeta(r) {
  const meta = [];
  if (r.servings) meta.push(r.serving_mode === 'piece' ? `${r.servings} pièce${r.servings > 1 ? 's' : ''}` : `${r.servings} portion${r.servings > 1 ? 's' : ''}`);
  if (r.cook_time_minutes) meta.push(`${r.cook_time_minutes} min`);
  if (r.oven_temp_celsius) meta.push(`${r.oven_temp_celsius}°C`);
  return meta;
}

async function generatePdf(r) {
  const { default: PDFDocument } = await import('pdfkit');
  const { fileURLToPath } = await import('node:url');
  // pdfkit charge ses polices standard (Helvetica, etc.) via un subpath
  // import du package ("#standard-fonts/...") que le traçage de fichiers de
  // Vercel ne suit pas de façon fiable. On embarque à la place la police
  // déjà utilisée par l'app elle-même (Krylon.otf, à la racine du repo).
  const fontPath = fileURLToPath(new URL('../Krylon.otf', import.meta.url));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      // Une seule police embarquée (pas de variante gras/italique) : la
      // hiérarchie visuelle passe par la taille et la couleur plutôt que
      // par le poids de la police.
      doc.registerFont('Krylon', fontPath);
      doc.font('Krylon');

      doc.fontSize(22).text(r.title);
      doc.moveDown(0.5);

      const meta = formatMeta(r);
      if (meta.length) {
        doc.fontSize(11).fillColor('#555').text(meta.join('   •   '));
        doc.fillColor('#000');
      }
      doc.moveDown(1);

      doc.fontSize(14).text('Ingrédients');
      doc.moveDown(0.3);
      doc.fontSize(11);
      (r.ingredients || []).forEach(ing => {
        const qty = formatQty(ing);
        const line = qty ? `${qty} — ${ing.name}` : ing.name;
        doc.text(`•  ${line}${ing.note ? ` (${ing.note})` : ''}`);
      });
      doc.moveDown(1);

      if (r.steps && r.steps.length) {
        doc.fontSize(14).text('Étapes');
        doc.moveDown(0.3);
        doc.fontSize(11);
        r.steps.forEach((s, i) => {
          doc.text(`${i + 1}. ${s}`);
          doc.moveDown(0.2);
        });
      }

      if (r.notes) {
        doc.moveDown(1);
        doc.fontSize(10).fillColor('#555').text(r.notes);
        doc.fillColor('#000');
      }

      if (r.source_url) {
        doc.moveDown(1);
        doc.fontSize(9).fillColor('#888').text(`Source : ${r.source_url}`);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function generateDocx(r) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');

  const children = [new Paragraph({ text: r.title, heading: HeadingLevel.HEADING_1 })];

  const meta = formatMeta(r);
  if (meta.length) children.push(new Paragraph({ text: meta.join('   •   ') }));

  children.push(new Paragraph({ text: 'Ingrédients', heading: HeadingLevel.HEADING_2 }));
  (r.ingredients || []).forEach(ing => {
    const qty = formatQty(ing);
    const line = qty ? `${qty} — ${ing.name}` : ing.name;
    children.push(new Paragraph({ text: `${line}${ing.note ? ` (${ing.note})` : ''}`, bullet: { level: 0 } }));
  });

  if (r.steps && r.steps.length) {
    children.push(new Paragraph({ text: 'Étapes', heading: HeadingLevel.HEADING_2 }));
    r.steps.forEach((s, i) => {
      children.push(new Paragraph({ text: `${i + 1}. ${s}` }));
    });
  }

  if (r.notes) {
    children.push(new Paragraph({ children: [new TextRun({ text: r.notes, italics: true })] }));
  }
  if (r.source_url) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Source : ${r.source_url}`, size: 18, color: '888888' })] }));
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Méthode non autorisée.' });
    }

    try {
      await assertAuthenticated(req);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const { format, recipe } = req.body || {};
    if (format !== 'pdf' && format !== 'docx') {
      return res.status(400).json({ error: 'Format non supporté.' });
    }
    if (!recipe || !recipe.title) {
      return res.status(400).json({ error: 'Recette invalide.' });
    }

    const filename = `${sanitizeFileName(recipe.title)}.${format}`;

    if (format === 'pdf') {
      const buffer = await generatePdf(recipe);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDispositionHeader(filename));
      return res.status(200).send(buffer);
    } else {
      const buffer = await generateDocx(recipe);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', contentDispositionHeader(filename));
      return res.status(200).send(buffer);
    }
  } catch (err) {
    return res.status(500).json({ error: "Erreur lors de la génération du fichier : " + (err && err.stack ? err.stack : String(err)) });
  }
}
