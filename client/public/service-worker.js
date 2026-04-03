const CACHE_NAME = 'pressure-salt-cache-v7'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
  '/pwa/icon-512-maskable.png',
  '/pwa/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  )
  self.clients.claim()
})

async function networkFirst(request, fallbackKey = request) {
  try {
    const networkResponse = await fetch(request)

    if (networkResponse && networkResponse.status === 200) {
      const responseClone = networkResponse.clone()
      caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
    }

    return networkResponse
  } catch {
    return caches.match(fallbackKey)
  }
}

async function cacheFirst(request) {
  const cachedResponse = await caches.match(request)

  if (cachedResponse) {
    return cachedResponse
  }

  const networkResponse = await fetch(request)

  if (networkResponse && networkResponse.status === 200) {
    const responseClone = networkResponse.clone()
    caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone))
  }

  return networkResponse
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return
  }

  const requestUrl = new URL(event.request.url)

  if (requestUrl.origin !== self.location.origin) {
    return
  }

  if (requestUrl.pathname.startsWith('/api')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, '/'))
    return
  }

  const isAppCodeRequest =
    requestUrl.pathname.endsWith('.js') ||
    requestUrl.pathname.endsWith('.css') ||
    requestUrl.pathname.endsWith('.html') ||
    requestUrl.pathname.endsWith('.webmanifest') ||
    requestUrl.pathname === '/'

  if (isAppCodeRequest) {
    event.respondWith(networkFirst(event.request, event.request))
    return
  }

  event.respondWith(cacheFirst(event.request))
})
