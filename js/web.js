// Extras de la versión web (no se usan en la app Android): instalación como
// PWA y anuncios. Los anuncios solo se activan si el build define
// VITE_ADSENSE_CLIENT y VITE_ADSENSE_SLOT (ver .env.example).

import { Capacitor } from '@capacitor/core';

const CACHE = 'hw9zonas-v1';
const ADS_CLIENT = import.meta.env.VITE_ADSENSE_CLIENT;
const ADS_SLOT = import.meta.env.VITE_ADSENSE_SLOT;
const isWeb = !Capacitor.isNativePlatform();
const adsEnabled = isWeb && !!ADS_CLIENT && !!ADS_SLOT;

export function initWeb() {
  if (!isWeb) return;
  if (import.meta.env.PROD && 'serviceWorker' in navigator) registerServiceWorker();
  if (adsEnabled) {
    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADS_CLIENT)}`;
    document.head.append(script);
  }
}

async function registerServiceWorker() {
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    // Lo cargado antes de que el service worker tomara el control no pasó por
    // él: se guarda ahora para que la app funcione sin conexión desde ya.
    const own = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin));
    const cache = await caches.open(CACHE);
    await cache.addAll(['./', ...own]);
  } catch {}
}

// Rellena los huecos de anuncio de la vista visible. Se hace al mostrarla
// porque un anuncio no puede medirse dentro de una vista oculta.
export function fillAds(view) {
  if (!adsEnabled) return;
  for (const slot of view.querySelectorAll('.ad-slot:not([data-filled])')) {
    slot.dataset.filled = '1';
    slot.hidden = false;
    const ad = document.createElement('ins');
    ad.className = 'adsbygoogle';
    ad.style.display = 'block';
    ad.dataset.adClient = ADS_CLIENT;
    ad.dataset.adSlot = ADS_SLOT;
    ad.dataset.adFormat = 'auto';
    ad.dataset.fullWidthResponsive = 'true';
    slot.append(ad);
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }
}
