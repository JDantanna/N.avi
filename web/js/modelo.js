// A tarefa e as listas do app: criar, agrupar por data, filtrar e escolher o que mostrar em cada linha.
// Reproduz o que o desktop faz em src/model.rs e src/tasks.rs, sobre o mesmo formato de dados (tasks.json).

import { DIAS_CURTOS, diaDaSemana, diaMes, diasEntre, horaCurta, partes } from "./datas.js";
import { atrasada, ocorreEm } from "./recorrencia.js";

/** Cor de partida das tarefas (a mesma do desktop). */
export const COR_PADRAO = [110, 142, 251];

/** Identidade da tarefa entre aparelhos: 32 dígitos hexadecimais, como a do desktop (`fresh_uid`). */
export function novoUid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uma tarefa nova, com todos os campos do formato do desktop. */
export function novaTarefa(id, titulo, data = null) {
  return {
    id,
    uid: novoUid(),
    title: titulo,
    notes: "",
    done: false,
    subtasks: [],
    date: data,
    time: null,
    notify: null,
    notify_day_before: false,
    tags: [],
    color: [...COR_PADRAO],
    repeat: "None",
    every: 1,
    anchor_day: data ? partes(data).d : 0,
    repeat_times: null,
  };
}

/** Completa o que falta numa tarefa lida de um arquivo, sem apagar nada que o app não conhece. */
export function normalizar(t) {
  if (typeof t.uid !== "string" || !t.uid) t.uid = novoUid(); // arquivos de versões antigas não têm
  t.title ??= "";
  t.notes ??= "";
  t.done = Boolean(t.done);
  t.subtasks = Array.isArray(t.subtasks) ? t.subtasks : [];
  t.date ??= null;
  t.time ??= null;
  t.notify ??= null;
  t.notify_day_before = Boolean(t.notify_day_before);
  t.tags = Array.isArray(t.tags) ? t.tags : [];
  t.color = Array.isArray(t.color) && t.color.length === 3 ? t.color : [...COR_PADRAO];
  t.repeat = ["None", "Daily", "Weekly", "Monthly", "Yearly"].includes(t.repeat) ? t.repeat : "None";
  t.every = Number.isFinite(t.every) && t.every >= 1 ? Math.floor(t.every) : 1;
  t.anchor_day ??= 0;
  t.repeat_times ??= null;
  return t;
}

/** Cores de partida das tags (as mesmas do desktop, escolhidas pelo nome). */
const PALETA_TAGS = [
  [110, 142, 251], [236, 112, 99], [88, 196, 141], [240, 178, 70],
  [176, 124, 230], [80, 190, 210], [230, 120, 170], [160, 170, 90],
];

/** Cor da tag: a escolhida pelo usuário ou, na falta dela, uma da paleta (sempre a mesma para o mesmo nome). */
export function corDaTag(cores, tag) {
  if (cores?.[tag]) return cores[tag];
  // A mesma conta do desktop: h = h * 31 + byte, em 64 bits, começando em 7.
  let h = 7n;
  for (const byte of new TextEncoder().encode(tag)) h = (h * 31n + BigInt(byte)) & 0xffff_ffff_ffff_ffffn;
  return PALETA_TAGS[Number(h % BigInt(PALETA_TAGS.length))];
}

export const rgb = ([r, g, b], alfa = 1) => (alfa === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alfa})`);

export const GRUPOS = ["Atrasadas", "Hoje", "Amanha", "Semana", "Depois", "SemData", "Concluidas"];

export const ROTULO_GRUPO = {
  Atrasadas: "Atrasadas",
  Hoje: "Hoje",
  Amanha: "Amanhã",
  Semana: "Próximos 7 dias",
  Depois: "Mais adiante",
  SemData: "Sem data",
  Concluidas: "Concluídas",
};

/** Em que seção da lista a tarefa fica. `agora`: "HH:MM:SS". */
export function grupoDe(t, hoje, agora) {
  if (t.done) return "Concluidas";
  if (atrasada(t, hoje, agora)) return "Atrasadas";
  if (!t.date) return "SemData";
  const n = diasEntre(hoje, t.date);
  if (n <= 0) return "Hoje";
  if (n === 1) return "Amanha";
  if (n <= 7) return "Semana";
  return "Depois";
}

export const FILTROS = [
  { id: "hoje", rotulo: "Hoje" },
  { id: "proximos", rotulo: "Próximos" },
  { id: "todas", rotulo: "Todas" },
  { id: "concluidas", rotulo: "Concluídas" },
];

/** A tarefa, que está na seção `grupo`, aparece neste filtro? */
export function noFiltro(filtro, grupo, t, hoje) {
  switch (filtro) {
    case "hoje":
      if (grupo === "Atrasadas" || grupo === "Hoje") return true;
      return grupo === "Concluidas" && ocorreEm(t, hoje);
    case "proximos": return grupo === "Amanha" || grupo === "Semana" || grupo === "Depois";
    case "todas": return true;
    case "concluidas": return grupo === "Concluidas";
    default: return false;
  }
}

/** O número ao lado de cada lista: o que falta fazer (ou, em Concluídas, o que já foi feito). */
export function contar(tarefas, filtro, hoje, agora) {
  return tarefas.filter((t) => (filtro === "concluidas" || !t.done) && noFiltro(filtro, grupoDe(t, hoje, agora), t, hoje)).length;
}

/** Data e hora à direita da linha, cada uma à parte: só o que a seção ainda não diz. */
export function partesQuando(t, grupo) {
  const hora = horaCurta(t.time);
  let dia = null;
  if (t.date && grupo !== "Hoje" && grupo !== "Amanha") {
    dia = grupo === "Semana" ? DIAS_CURTOS[diaDaSemana(t.date)] : diaMes(t.date);
  }
  return { dia, hora };
}

/** As tarefas de um dia, em ordem de horário (as sem hora no fim, as concluídas depois). */
export function doDia(tarefas, dia, mostrarConcluidas = true) {
  return tarefas
    .filter((t) => ocorreEm(t, dia) && (mostrarConcluidas || !t.done))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(a.t.done) - Number(b.t.done) || (a.t.time ?? "99:99").localeCompare(b.t.time ?? "99:99") || a.i - b.i)
    .map(({ t }) => t);
}

/** Ordem dentro de uma seção: por data, depois por hora (sem hora no fim), mantendo a ordem do arquivo. */
export function ordenar(lista) {
  return lista
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date ?? "9999").localeCompare(b.t.date ?? "9999") || (a.t.time ?? "99:99").localeCompare(b.t.time ?? "99:99") || a.i - b.i)
    .map(({ t }) => t);
}
