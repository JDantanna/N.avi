// Modo offline. O app é só arquivos estáticos: o service worker guarda todos eles no aparelho na instalação e
// responde dali, então abre sem internet. Cada versão publicada tem o seu cache (o nome leva o número do commit,
// que o workflow de publicação grava no lugar de __VERSAO__); o cache de versões antigas é apagado ao ativar.
//
// As tarefas NÃO passam por aqui: ficam no localStorage da página.

const VERSAO = "__VERSAO__";
const CACHE = `navi-web-${VERSAO}`;

const ARQUIVOS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "js/ajustes.js",
  "js/armazem.js",
  "config/nuvem.json",
  "js/calendario.js",
  "js/conexao.js",
  "js/datas.js",
  "js/detalhe.js",
  "js/dom.js",
  "js/drive.js",
  "js/folha.js",
  "js/google.js",
  "js/linhas.js",
  "js/mesclagem.js",
  "js/modelo.js",
  "js/rapido.js",
  "js/recorrencia.js",
  "js/sincronia.js",
  "js/tarefas.js",
  "js/versao.js",
  "icons/favicon-32.png",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload`: busca de verdade na rede, sem o cache de HTTP do Safari, para o app guardado ser coerente.
      await cache.addAll(ARQUIVOS.map((a) => new Request(a, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    (async () => {
      for (const nome of await caches.keys()) {
        if (nome.startsWith("navi-web-") && nome !== CACHE) await caches.delete(nome);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (evento) => {
  const pedido = evento.request;
  if (pedido.method !== "GET" || new URL(pedido.url).origin !== self.location.origin) return;
  evento.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Navegação (abrir o app): sempre a casca guardada, mesmo com um endereço diferente.
      const guardado = await cache.match(pedido, { ignoreSearch: true });
      if (guardado) return guardado;
      if (pedido.mode === "navigate") {
        const casca = await cache.match("index.html");
        if (casca) return casca;
      }
      try {
        return await fetch(pedido);
      } catch {
        return new Response("Sem conexão e este arquivo ainda não está guardado.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })(),
  );
});
