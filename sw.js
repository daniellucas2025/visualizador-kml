const APP_CACHE = 'kml-app-shell-v3';
const TILE_CACHE = 'kml-map-tiles-v3';
const IDB_NAME = 'kml_offline_cache_db';
const IDB_STORE = 'tile_meta';
const IDB_CONFIG = 'cache_config';

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

// ---- IndexedDB Helpers for Tile Timestamps & TTL Config ----
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const store = db.createObjectStore(IDB_STORE, { keyPath: 'url' });
        store.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(IDB_CONFIG)) {
        db.createObjectStore(IDB_CONFIG, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recordTileTimestamp(url) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ url, ts: Date.now() });
  } catch (e) {}
}

async function getTileTimestamp(url) {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(url);
      req.onsuccess = () => resolve(req.result ? req.result.ts : null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function deleteTileMeta(url) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(url);
  } catch (e) {}
}

async function getConfiguredTTLMs() {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_CONFIG, 'readonly');
      const req = tx.objectStore(IDB_CONFIG).get('ttl_ms');
      req.onsuccess = () => {
        // Default: 30 days in ms (0 = never expire)
        const val = req.result ? req.result.value : 30 * 24 * 60 * 60 * 1000;
        resolve(val);
      };
      req.onerror = () => resolve(30 * 24 * 60 * 60 * 1000);
    });
  } catch (e) {
    return 30 * 24 * 60 * 60 * 1000;
  }
}

async function pruneExpiredTiles() {
  try {
    const ttlMs = await getConfiguredTTLMs();
    if (!ttlMs || ttlMs <= 0) return { removed: 0 }; // 0 = Nunca apagar automaticamente

    const cutoff = Date.now() - ttlMs;
    const db = await openCacheDB();
    const cache = await caches.open(TILE_CACHE);

    const expiredUrls = await new Promise((resolve) => {
      const list = [];
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const idx = store.index('ts');
      const range = IDBKeyRange.upperBound(cutoff);
      const cursorReq = idx.openCursor(range);

      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          list.push(cursor.value.url);
          cursor.continue();
        } else {
          resolve(list);
        }
      };
      cursorReq.onerror = () => resolve(list);
    });

    for (const url of expiredUrls) {
      await cache.delete(url, { ignoreVary: true });
      await deleteTileMeta(url);
    }
    return { removed: expiredUrls.length };
  } catch (e) {
    return { removed: 0 };
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => {
      return cache.addAll(APP_ASSETS).catch(() => {});
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
    ).then(() => pruneExpiredTiles())
     .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'PRUNE_EXPIRED') {
    pruneExpiredTiles().then((res) => {
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage(res);
      }
    });
  }
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

async function compressTileIfPossible(resp) {
  if (!resp || resp.type === 'opaque' || typeof OffscreenCanvas === 'undefined') {
    return resp;
  }
  try {
    const blob = await resp.clone().blob();
    if (blob.size < 6000) return resp;
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const webpBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.74 });
    if (webpBlob && webpBlob.size < blob.size) {
      return new Response(webpBlob, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'image/webp', 'X-KML-Compressed': '1' }
      });
    }
  } catch (e) {}
  return resp;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const urlStr = req.url;

  if (isMapTileRequest(urlStr)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cachedResp = await cache.match(req, { ignoreVary: true });
        const ttlMs = await getConfiguredTTLMs();

        if (cachedResp) {
          // Se estiver sem internet (offline), sempre entrega o cache mesmo se já venceu o tempo!
          if (!navigator.onLine || !ttlMs || ttlMs <= 0) {
            return cachedResp;
          }
          // Se estiver online, verifica se o tile já passou do tempo configurado para expirar
          const savedTs = await getTileTimestamp(urlStr);
          const isExpired = savedTs && (Date.now() - savedTs > ttlMs);
          if (!isExpired) {
            return cachedResp;
          }
          // Se expirou e está online, tenta baixar uma versão nova abaixo
        }

        try {
          const netResp = await fetch(req);
          if (netResp && (netResp.status === 200 || netResp.type === 'opaque')) {
            const respToReturn = netResp.clone();
            // Comprime em background para WebP reduzindo ~45% do tamanho em disco sem travar a renderização
            compressTileIfPossible(netResp).then((optimized) => {
              cache.put(req, optimized);
              recordTileTimestamp(urlStr);
            });
            return respToReturn;
          }
          return netResp;
        } catch (err) {
          // Se falhou a rede mas tínhamos um cache antigo, retorna ele para não deixar o usuário na mão
          if (cachedResp) return cachedResp;
          return new Response('', { status: 408, statusText: 'Offline Tile Miss' });
        }
      })
    );
    return;
  }

  // App shell requests
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
