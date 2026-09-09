/* Service Worker для поддержки установки PWA */
self.addEventListener('install', (e) => {
  console.log('[Service Worker] Установлен');
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  console.log('[Service Worker] Активирован');
  return self.clients.claim();
});

/* Пустой обработчик, чтобы браузер считал приложение готовым к офлайну */
self.addEventListener('fetch', (e) => {
  // Мы используем Firebase, поэтому фоновое кэширование нам тут не нужно
});
