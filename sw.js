self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', (event) => {
  // Ne jamais intercepter les appels vers un autre domaine (API Supabase
  // notamment) : refaire la requête ici via fetch(event.request) ne préserve
  // pas fiablement l'option cache: 'no-store' du fetch personnalisé du
  // client, ce qui réintroduisait le cache agressif de Safari iOS sur les
  // réponses de l'API REST et cassait le rafraîchissement des données.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
