// The service worker.
//
// - It stores every file of the build, so the IDE works offline after the first load.
// - It serves this origin's files from that store, adding the security headers. Python needs those
//   headers, and some hosts cannot send them.
// - It records any request to another origin. There should be none; the self-check page asks for the list.

// The build replaces this placeholder with {id, files, csp}: the build's id, the files to store, and the
// Content-Security-Policy.
const { id, files, csp } = __BUILD_CONFIG__; // eslint-disable-line no-undef

const otherOrigins = new Set();

// On install, store every file of this build, then take over from any older version at once.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(id);
      // Download in batches of six, so that a slow connection is not flooded with requests.
      for (let i = 0; i < files.length; i += 6) {
        await cache.addAll(files.slice(i, i + 6));
      }
      await self.skipWaiting();
    })(),
  );
});

// On activation, delete older builds' files and take control of open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== id) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * Return a copy of a response with the security headers added.
 * @param {Response} response
 * @returns {Response}
 */
function withHeaders(response) {
  if (response.type === 'opaque' || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding'); // The body has already been decoded.
  headers.delete('Content-Length');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', csp);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Serve this origin's files from the store, or else from the network.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) {
    otherOrigins.add(url.origin);
    return;
  }
  // The self-check's network test must reach the server, so it is not served from the store.
  if (url.searchParams.has('probe')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(id);
      const key = url.pathname.endsWith('/') ? new URL('index.html', url).href : url.href;
      const stored = await cache.match(key, { ignoreSearch: true });
      return withHeaders(stored ?? (await fetch(event.request)));
    })(),
  );
});

// Tell the self-check page which other origins were requested.
self.addEventListener('message', (event) => {
  if (event.data === 'status') {
    event.source.postMessage({ foreign: [...otherOrigins] });
  }
});
