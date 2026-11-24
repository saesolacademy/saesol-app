// 홈 화면 앱으로 설치할 수 있게 해 주는 작은 파일이에요. 저장(캐시)은 하지 않아요.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
