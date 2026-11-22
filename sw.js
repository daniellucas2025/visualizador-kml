const APP_CACHE = 'kml-app-shell-v2';
const TILE_CACHE = 'kml-map-tiles-v2';
const MAX_TILES = 30000; // Capacidade para até 30.000 quadrantes de mapa (~600MB a 1.2GB de mapas offline)

const APP_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => {
      return cache.addAll(APP_ASSETS).catch((err) => {
        console.warn('Alguns assets iniciais falharam no pré-cache:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== APP_CACHE && k !== TILE_CACHE) {
            return caches.delete(k);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

function isMapTileRequest(urlStr) {
  return (
    urlStr.includes('mt0.google.com/vt') ||
    urlStr.includes('mt1.google.com/vt') ||
    urlStr.includes('mt2.google.com/vt') ||
    urlStr.includes('mt3.google.com/vt') ||
    urlStr.includes('tile.openstreetmap.org') ||
    urlStr.includes('tile.opentopomap.org')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const urlStr = req.url;

  // Estratégia Cache-First para Quadrantes do Mapa (Tiles) com atualização inteligente
  if (isMapTileRequest(urlStr)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cachedResp = await cache.match(req, { ignoreVary: true });
        if (cachedResp) {
          return cachedResp;
        }
        try {
          const netResp = await fetch(req);
          if (netResp && (netResp.status === 200 || netResp.type === 'opaque')) {
            cache.put(req, netResp.clone());
          }
          return netResp;
        } catch (err) {
          // Sem internet e tile não estava em cache
          return new Response('', { status: 408, statusText: 'Offline Tile Miss' });
        }
      })
    );
    return;
  }

  // Estratégia Network-First com Fallback imediato para Cache nos arquivos do App
  event.respondWith(
    fetch(req)
      .then((netResp) => {
        if (netResp && netResp.status === 200) {
          const clone = netResp.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(req, clone));
        }
        return netResp;
      })
      .catch(() => {
        return caches.match(req).then((cached) => cached || caches.match('./index.html'));
      })
  );
});
