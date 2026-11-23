// Montar tela sem framework: um `h()` para criar elementos e um conjunto de ícones desenhados em SVG.

const SVG = "http://www.w3.org/2000/svg";

/** Cria um elemento. `props`: class, estilos, atributos e `on...` para eventos; filhos: textos, nós, listas ou nada. */
export function h(tag, props = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [chave, valor] of Object.entries(props ?? {})) {
    if (valor === undefined || valor === null || valor === false) continue;
    if (chave === "class") el.className = valor;
    else if (chave === "style" && typeof valor === "object") {
      // Variáveis do CSS ("--cor") só entram por setProperty.
      for (const [k, v] of Object.entries(valor)) (k.startsWith("--") ? el.style.setProperty(k, v) : (el.style[k] = v));
    }
    else if (chave.startsWith("on") && typeof valor === "function") el.addEventListener(chave.slice(2).toLowerCase(), valor);
    else if (chave === "value") el.value = valor;
    else if (chave === "checked") el.checked = Boolean(valor);
    else el.setAttribute(chave, valor === true ? "" : valor);
  }
  anexar(el, filhos);
  return el;
}

function anexar(el, filhos) {
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
}

/** Esvazia um elemento e põe novos filhos. */
export function trocar(el, ...filhos) {
  el.replaceChildren();
  anexar(el, filhos);
  return el;
}

// Traços dos ícones, numa grade de 24 por 24 (cada item é um elemento do SVG).
const FORMAS = {
  tarefas: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M8 12.5l2.6 2.6L16 9.5" }]],
  calendario: [["rect", { x: 3.5, y: 5, width: 17, height: 15.5, rx: 3 }], ["path", { d: "M3.5 10h17M8 3v4M16 3v4" }]],
  relogio: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
  repetir: [["path", { d: "M17 3.5l3 3-3 3M20 6.5H9a5 5 0 0 0-5 5M7 20.5l-3-3 3-3M4 17.5h11a5 5 0 0 0 5-5" }]],
  ajustes: [["path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3m4 0h9" }], ["circle", { cx: 15, cy: 7, r: 2 }], ["circle", { cx: 9, cy: 17, r: 2 }], ["circle", { cx: 9, cy: 12, r: 2 }]],
  mais: [["path", { d: "M12 5v14M5 12h14" }]],
  lixeira: [["path", { d: "M4 7h16M10 3.5h4M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7M10 11v6M14 11v6" }]],
  fechar: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  esquerda: [["path", { d: "M15 5l-7 7 7 7" }]],
  direita: [["path", { d: "M9 5l7 7-7 7" }]],
  baixo: [["path", { d: "M5 9l7 7 7-7" }]],
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  lista: [["path", { d: "M10 6.5h10M10 12h10M10 17.5h10" }], ["path", { d: "M3.5 6.5l1.4 1.4 2.4-2.6M3.5 12l1.4 1.4 2.4-2.6M3.5 17.5l1.4 1.4 2.4-2.6" }]],
  nota: [["path", { d: "M6 3.5h9l3.5 3.5v13.5H6z" }], ["path", { d: "M9 11h6M9 15h6" }]],
  hoje: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" }]],
  proximos: [["rect", { x: 3.5, y: 5, width: 17, height: 15.5, rx: 3 }], ["path", { d: "M3.5 10h17M8 3v4M16 3v4" }]],
  todas: [["path", { d: "M9 6.5h11M9 12h11M9 17.5h11" }], ["circle", { cx: 4.8, cy: 6.5, r: 1 }], ["circle", { cx: 4.8, cy: 12, r: 1 }], ["circle", { cx: 4.8, cy: 17.5, r: 1 }]],
  concluidas: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M8 12.5l3 3 5-6" }]],
  nuvem: [["path", { d: "M7.5 18.5a4.5 4.5 0 0 1-.9-8.9 5.5 5.5 0 0 1 10.6 1.4 3.8 3.8 0 0 1-.7 7.5z" }]],
  exportar: [["path", { d: "M12 15V3.5M7.5 8L12 3.5 16.5 8M5 13v6.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V13" }]],
  importar: [["path", { d: "M12 3.5V15M7.5 11L12 15.5 16.5 11M5 13v6.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V13" }]],
};

/** Um ícone em SVG: traço de 1.8 na cor do texto à volta. */
export function icone(nome, tamanho = 20) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(tamanho));
  svg.setAttribute("height", String(tamanho));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icone");
  for (const [forma, atributos] of FORMAS[nome] ?? []) {
    const el = document.createElementNS(SVG, forma);
    for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

/** A fada do N.avi em SVG, com o mesmo desenho do desktop: orbe brilhante e quatro asas. */
export function fada(tamanho = 30) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "-50 -50 100 100");
  svg.setAttribute("width", String(tamanho));
  svg.setAttribute("height", String(tamanho));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("fada");
  const asas = [[-2.36, 0.5, 0.2], [-0.78, 0.5, 0.2], [2.2, 0.34, 0.15], [0.94, 0.34, 0.15]];
  const tam = 100;
  for (const [ang, comp, larg] of asas) {
    const l = tam * comp;
    const w = tam * larg;
    const el = document.createElementNS(SVG, "ellipse");
    el.setAttribute("cx", String((Math.cos(ang) * l) / 2));
    el.setAttribute("cy", String((Math.sin(ang) * l) / 2));
    el.setAttribute("rx", String(l / 2));
    el.setAttribute("ry", String(w / 2));
    el.setAttribute("transform", `rotate(${(ang * 180) / Math.PI} ${(Math.cos(ang) * l) / 2} ${(Math.sin(ang) * l) / 2})`);
    el.setAttribute("fill", "rgba(205,235,255,.6)");
    el.setAttribute("stroke", "rgba(235,248,255,.8)");
    el.setAttribute("stroke-width", "1.4");
    svg.append(el);
  }
  const r = tam * 0.2;
  const disco = (cx, cy, raio, cor) => {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(raio));
    c.setAttribute("fill", cor);
    svg.append(c);
  };
  for (let i = 5; i >= 1; i--) {
    const k = i / 5;
    disco(0, 0, r * (1 + 1.5 * k), `rgba(130,205,255,${((14 + 30 * 0.7) * (1.1 - k)) / 255})`);
  }
  disco(0, 0, r, "rgb(190,230,255)");
  disco(-r * 0.2, -r * 0.2, r * 0.55, "#fff");
  return svg;
}
