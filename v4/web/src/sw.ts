/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute, PrecacheFallbackPlugin, type PrecacheEntry } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> };

// Older builds may still have open tabs. Activate the new worker without waiting
// for those tabs to close. Do not reload a tab or interrupt an open form.
void self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();

// Match even / and /index.html BEFORE Workbox's precache route. An online
// navigation must use the deployed HTML. The single shell in precache is
// used only when the network fails; no per-route or API responses enter cache.
registerRoute(
  ({ request, url, sameOrigin }) => request.mode === 'navigate' && sameOrigin &&
    url.pathname !== '/api' && !url.pathname.startsWith('/api/'),
  new NetworkOnly({ plugins: [new PrecacheFallbackPlugin({ fallbackURL: '/index.html' })] }),
);
precacheAndRoute(self.__WB_MANIFEST);
