/**
 * ⚡ UKKOSTUTKA — Service Worker
 * Vastaanottaa push-notifikaatiot taustalla
 * Miia & Caelan 🖤
 */

self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    
    const title = data.title || '⚡ Ukkostutka';
    const options = {
        body: data.body || 'Salamoita havaittu!',
        icon: '/icon.png',
        badge: '/icon.png',
        tag: 'lightning-alert',       // Korvaa vanhan notifikaation eikä pinoa
        renotify: true,               // Soi/värisee silti vaikka tag sama
        requireInteraction: false,
        data: { url: data.url || '/' }
    };
    
    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    
    event.waitUntil(
        clients.openWindow(event.notification.data.url || '/')
    );
});
