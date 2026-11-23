// Gera os ícones do app web (a fada do N.avi) em PNG, sem nenhuma dependência: `node web/tools/icones.mjs`.
// A fada é a mesma do desktop (src/fairy.rs): um orbe brilhante com quatro asas, sobre o fundo escuro do app.

import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const PASTA = new URL("../icons/", import.meta.url);
const FUNDO = [16, 18, 27];
const BRILHO_FUNDO = [32, 42, 70];
/** Amostras por pixel, em cada eixo (serrilhado suave). */
const SS = 3;

// (ângulo, comprimento, largura) das quatro asas, em fração do tamanho da fada.
const ASAS = [[-2.36, 0.5, 0.2], [-0.78, 0.5, 0.2], [2.2, 0.34, 0.15], [0.94, 0.34, 0.15]];

/** Camadas da fada, de baixo para cima: cada uma devolve `[r, g, b, a]` (a de 0 a 255) ou `null` no ponto. */
function camadas(cx, cy, tamanho) {
  const lista = [];
  for (const [ang, comp, larg] of ASAS) {
    const l = tamanho * comp;
    const w = tamanho * larg;
    const [dx, dy] = [Math.cos(ang), Math.sin(ang)];
    const [ox, oy] = [cx + (dx * l) / 2, cy + (dy * l) / 2];
    const borda = Math.max(1, tamanho * 0.012);
    lista.push((x, y) => {
      const [px, py] = [x - ox, y - oy];
      const ao = px * dx + py * dy;
      const pe = -px * dy + py * dx;
      const fora = (ao / (l / 2 + borda / 2)) ** 2 + (pe / (w / 2 + borda / 2)) ** 2;
      if (fora > 1) return null;
      const dentro = (ao / (l / 2 - borda / 2)) ** 2 + (pe / (w / 2 - borda / 2)) ** 2;
      return dentro <= 1 ? [205, 235, 255, 150] : [235, 248, 255, 200];
    });
  }
  const r = tamanho * 0.2;
  const disco = (ox, oy, raio, cor) => (x, y) => ((x - ox) ** 2 + (y - oy) ** 2 <= raio * raio ? cor : null);
  for (let i = 5; i >= 1; i--) {
    const k = i / 5;
    lista.push(disco(cx, cy, r * (1 + 1.5 * k), [130, 205, 255, (14 + 30 * 0.7) * (1.1 - k)]));
  }
  lista.push(disco(cx, cy, r, [190, 230, 255, 255]));
  lista.push(disco(cx - r * 0.2, cy - r * 0.2, r * 0.55, [255, 255, 255, 255]));
  return lista;
}

/** Desenha um ícone quadrado de `n` pixels; a fada ocupa `escala` do lado. */
function desenhar(n, escala) {
  const buf = Buffer.alloc(n * n * 4);
  const camadasFada = camadas(n / 2, n / 2, n * escala);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let [r, g, b] = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          // Fundo: escuro, com um brilho azul suave no meio.
          const d = Math.min(1, Math.hypot(x - n / 2, y - n / 2) / (n * 0.62));
          const t = (1 - d) ** 2;
          let cor = FUNDO.map((c, i) => c + (BRILHO_FUNDO[i] - c) * t);
          for (const camada of camadasFada) {
            const c = camada(x, y);
            if (!c) continue;
            const a = c[3] / 255;
            cor = cor.map((v, i) => v * (1 - a) + c[i] * a);
          }
          r += cor[0];
          g += cor[1];
          b += cor[2];
        }
      }
      const total = SS * SS;
      const o = (py * n + px) * 4;
      buf[o] = Math.round(r / total);
      buf[o + 1] = Math.round(g / total);
      buf[o + 2] = Math.round(b / total);
      buf[o + 3] = 255;
    }
  }
  return buf;
}

function chunk(tipo, dados) {
  const cabeca = Buffer.alloc(8);
  cabeca.writeUInt32BE(dados.length, 0);
  cabeca.write(tipo, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([cabeca.subarray(4), dados])) >>> 0, 0);
  return Buffer.concat([cabeca, dados, crc]);
}

function png(n, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  const linha = n * 4 + 1;
  const cru = Buffer.alloc(linha * n);
  for (let y = 0; y < n; y++) rgba.copy(cru, y * linha + 1, y * n * 4, (y + 1) * n * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(cru, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(PASTA, { recursive: true });
const icones = [
  // (arquivo, lado, fração do lado que a fada ocupa)
  ["icon-192.png", 192, 0.82],
  ["icon-512.png", 512, 0.82],
  // "Maskable": o sistema recorta o ícone; a fada fica na zona segura (um círculo de 80% do lado).
  ["icon-maskable-512.png", 512, 0.6],
  // O iPhone arredonda sozinho e não aceita transparência: ocupa o quadrado todo.
  ["apple-touch-icon.png", 180, 0.82],
  ["favicon-32.png", 32, 0.9],
];
for (const [arquivo, lado, escala] of icones) {
  writeFileSync(new URL(arquivo, PASTA), png(lado, desenhar(lado, escala)));
  console.log(`${arquivo} (${lado}x${lado})`);
}
