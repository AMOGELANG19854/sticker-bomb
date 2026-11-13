const cacheName = 'sticker-bomb-shell-v22';
const shell = ['/', '/style.css', '/app.js', '/route.js', '/vendor/qr.js', '/vendor/pdf.js',
  '/vendor/map.js', '/vendor/map.css', '/wall.jpg', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install',event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate',event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('sticker-bomb-shell-') && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch',event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || !shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request,{cache:'reload'}).catch(() => caches.match(url.pathname)));
});
