// Servidor local para ver o app web durante o desenvolvimento: `node web/tools/servir.mjs [porta]`.
// Só entrega os arquivos de web/ e nunca guarda nada em cache, para a tela refletir a última edição.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const PORTA = Number(process.argv[2] ?? 8123);
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const alvo = normalize(join(RAIZ, caminho.endsWith("/") ? `${caminho}index.html` : caminho));
  // Nada fora de web/.
  if (!alvo.startsWith(RAIZ)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const dados = await readFile(alvo);
    res.writeHead(200, { "content-type": TIPOS[extname(alvo)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(dados);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não achei este arquivo.");
  }
}).listen(PORTA, "127.0.0.1", () => console.log(`N.avi web em http://127.0.0.1:${PORTA}/`));
