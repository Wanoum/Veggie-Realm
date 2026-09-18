// Ce service worker n'intercepte volontairement aucune requête réseau : il
// ne met jamais rien en cache (aucun cache.put() n'est appelé nulle part),
// donc son ancien fetch handler n'apportait aucun vrai support hors-ligne —
// juste un risque, déjà constaté, de perturber le contournement de cache
// (cache: 'no-store') mis en place côté client pour l'API Supabase.
// Sa seule utilité ici est de satisfaire l'enregistrement du service worker
// pour l'installation en PWA.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
