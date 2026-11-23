// Confere o site antes de publicar: todo arquivo do app tem de estar na lista do service worker (senão não abre
// sem internet) e toda entrada da lista tem de existir. Também vê se o manifesto e o index.html apontam para
// arquivos que existem. Uso: `node web/tools/conferir.mjs` (sai com erro se algo não bate).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const erros = [];

const sw = readFileSync(join(RAIZ, "sw.js"), "utf8");
const lista = sw.match(/const ARQUIVOS = \[([\s\S]*?)\];/)?.[1];
if (!lista) erros.push("sw.js: não achei a lista ARQUIVOS.");
const guardados = new Set([...(lista ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((a) => a !== "./"));

const arquivos = (pasta) =>
  readdirSync(join(RAIZ, pasta), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(RAIZ, join(RAIZ, pasta, e.name)).replaceAll("\\", "/"));
const doApp = new Set(["index.html", "manifest.webmanifest", ...arquivos("config"), ...arquivos("css"), ...arquivos("js"), ...arquivos("icons")]);

for (const a of doApp) if (!guardados.has(a)) erros.push(`${a}: existe mas não está na lista do service worker.`);
for (const a of guardados) if (!existsSync(join(RAIZ, a))) erros.push(`${a}: está na lista do service worker mas não existe.`);
if (!sw.includes('const VERSAO = "__VERSAO__"')) erros.push("sw.js: falta a marca __VERSAO__ que o workflow troca pelo commit.");

// Tudo que o index.html e o manifesto citam.
const html = readFileSync(join(RAIZ, "index.html"), "utf8");
const manifesto = JSON.parse(readFileSync(join(RAIZ, "manifest.webmanifest"), "utf8"));
const citados = [
  ...[...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]),
  ...manifesto.icons.map((i) => i.src),
];
for (const c of citados) if (!existsSync(join(RAIZ, c))) erros.push(`${c}: citado no index.html/manifesto mas não existe.`);
for (const c of citados) if (c.startsWith("/")) erros.push(`${c}: endereço absoluto; o site mora numa subpasta (/N.avi/), use relativo.`);

// Os módulos importam só arquivos que existem.
for (const a of arquivos("js")) {
  const fonte = readFileSync(join(RAIZ, a), "utf8");
  for (const m of fonte.matchAll(/from\s+"(\.[^"]+)"/g)) {
    if (!existsSync(join(RAIZ, "js", m[1]))) erros.push(`${a}: importa ${m[1]}, que não existe.`);
  }
}

if (erros.length) {
  console.error(erros.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`ok: ${doApp.size} arquivos do app, todos na lista do service worker.`);
