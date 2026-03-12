// PROGPROD MES — Service Worker v1.1
// Resiliente ao Firebase Hosting (modo privado, Safari, restrições de storage)
const CACHE = 'progprod-v1';

// Arquivos estáticos do app shell para cache offline
const STATIC = [
  '/index.html',
  '/css/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Domínios que NUNCA devem ser interceptados (sempre vai à rede)
const BYPASS = [
  'firebase',
  'firestore',
  'googleapis',
  'gstatic',
  'cdnjs',
  'identitytoolkit',
  'securetoken',
];

self.addEventListener('install', e => {
  // waitUntil com try/catch — se o storage falhar, o SW ainda instala
  e.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        // addAll pode falhar — usa add individual para não travar tudo
        await Promise.allSettled(STATIC.map(url => cache.add(url).catch(() => {})));
      } catch (err) {
        // Storage indisponível (modo privado, etc) — continua sem cache
        console.info('[SW] Cache indisponível, rodando sem offline support:', err.message);
      }
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
      } catch (err) {
        // Ignora erros de storage na ativação
      }
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Deixa passar tudo que não é GET
  if (e.request.method !== 'GET') return;

  // Deixa passar Firebase, googleapis, CDNs
  if (BYPASS.some(d => url.includes(d))) return;

  // Só intercepta URLs do próprio domínio
  if (!url.startsWith(self.location.origin)) return;

  e.respondWith(
    (async () => {
      try {
        // Tenta cache primeiro
        const cached = await caches.match(e.request);
        if (cached) return cached;

        // Vai à rede
        const response = await fetch(e.request);

        // Cacheia em background se for resposta válida
        if (response && response.status === 200) {
          try {
            const cache = await caches.open(CACHE);
            cache.put(e.request, response.clone());
          } catch (_) { /* storage cheio ou indisponível */ }
        }

        return response;
      } catch (err) {
        // Offline e não tem cache — retorna página principal se disponível
        const fallback = await caches.match('/index.html');
        return fallback || new Response('Offline', { status: 503 });
      }
    })()
  );
});
