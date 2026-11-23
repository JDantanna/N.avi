// A mesclagem entre aparelhos: o mesmo que o desktop faz em src/sync.rs, sobre o arquivo N.avi.sync.json.
// O formato, os carimbos e as regras estão em docs/sincronizacao.md; os casos de teste compartilhados com o Rust
// estão em docs/sync-casos/mesclagem.json. São funções sem rede e sem tela: recebem o armazém e o arquivo lido.

import { GRUPOS_SYNC, carimbosCompletos, normalizar } from "./modelo.js";

export const SCHEMA = 1;
export const NOME_DO_ARQUIVO = "N.avi.sync.json";
/** Quanto tempo uma exclusão fica lembrada no arquivo (90 dias), contado no relógio de parede. */
export const VIDA_DA_LAPIDE_MS = 90 * 24 * 3600 * 1000;

/** O carimbo mais recente de uma tarefa: a última vez que algo nela mudou. */
export const maisRecente = (carimbos) => Math.max(0, ...GRUPOS_SYNC.map((g) => carimbos[g]));

// ------------------------------------------------------------------------------------------------------- grupos

const mesmoJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Os campos do grupo `g` são iguais nas duas tarefas? */
export function igualGrupo(a, b, g) {
  switch (g) {
    case "title":
      return a.title === b.title;
    case "notes":
      return a.notes === b.notes;
    case "state":
      return (
        a.done === b.done && a.date === b.date && a.time === b.time && a.repeat === b.repeat &&
        a.every === b.every && a.anchor_day === b.anchor_day && a.repeat_times === b.repeat_times
      );
    case "notify":
      return a.notify === b.notify && a.notify_day_before === b.notify_day_before;
    case "tags":
      return mesmoJson(a.tags, b.tags);
    case "color":
      return mesmoJson(a.color, b.color);
    case "subtasks":
      return mesmoJson(subtarefas(a), subtarefas(b));
    default:
      return true;
  }
}

const subtarefas = (t) => t.subtasks.map((s) => ({ title: s.title, done: s.done }));

/** Copia os campos do grupo `g`, e o carimbo dele, de `de` para `para`. */
export function copiarGrupo(para, de, g) {
  switch (g) {
    case "title":
      para.title = de.title;
      break;
    case "notes":
      para.notes = de.notes;
      break;
    case "state":
      for (const c of ["done", "date", "time", "repeat", "every", "anchor_day", "repeat_times"]) para[c] = de[c];
      break;
    case "notify":
      para.notify = de.notify;
      para.notify_day_before = de.notify_day_before;
      break;
    case "tags":
      para.tags = [...de.tags];
      break;
    case "color":
      para.color = [...de.color];
      break;
    case "subtasks":
      para.subtasks = structuredClone(de.subtasks);
      break;
  }
  para.stamps[g] = de.stamps[g];
}

/** Texto de um string como o Rust o escreve em `{:?}`: o desempate precisa dar o mesmo nos dois aparelhos. */
function depuracaoRust(texto) {
  let saida = '"';
  for (const c of texto) {
    const n = c.codePointAt(0);
    if (c === '"') saida += '\\"';
    else if (c === "\\") saida += "\\\\";
    else if (c === "\n") saida += "\\n";
    else if (c === "\r") saida += "\\r";
    else if (c === "\t") saida += "\\t";
    else if (n === 0) saida += "\\0";
    else if (n < 0x20 || n === 0x7f) saida += `\\u{${n.toString(16)}}`;
    else saida += c;
  }
  return `${saida}"`;
}

/** Texto canônico do grupo, igual ao `Task::group_key` do desktop, para desempatar carimbos iguais do mesmo jeito. */
export function chaveGrupo(t, g) {
  switch (g) {
    case "title":
      return depuracaoRust(t.title);
    case "notes":
      return depuracaoRust(t.notes);
    case "state":
      return [t.done, t.date ?? "", t.time ?? "", t.repeat, t.every, t.anchor_day, t.repeat_times ?? ""].join("|");
    case "notify":
      return `${t.notify ?? ""}|${t.notify_day_before}`;
    case "tags":
      return `[${t.tags.map(depuracaoRust).join(", ")}]`;
    case "color":
      return `[${t.color.join(", ")}]`;
    case "subtasks":
      return `[${t.subtasks.map((s) => `Subtask { title: ${depuracaoRust(s.title)}, done: ${s.done} }`).join(", ")}]`;
    default:
      return "";
  }
}

const codificador = new TextEncoder();

/** Compara dois textos byte a byte em UTF-8, como o Rust compara `String`. */
export function compararBytes(a, b) {
  const x = codificador.encode(a);
  const y = codificador.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// --------------------------------------------------------------------------------------------------- o arquivo

const CAMPOS_DA_TAREFA = [
  "uid", "title", "notes", "done", "subtasks", "date", "time", "notify", "notify_day_before",
  "tags", "color", "repeat", "every", "anchor_day", "repeat_times", "stamps",
];

/** Uma tarefa como vai no arquivo: sem o id numérico, que vale só neste aparelho. */
export function tarefaParaArquivo(t) {
  const saida = {};
  for (const c of CAMPOS_DA_TAREFA) saida[c] = t[c];
  saida.subtasks = subtarefas(t);
  saida.tags = [...t.tags];
  saida.color = [...t.color];
  saida.stamps = carimbosCompletos(t.stamps);
  return saida;
}

/** O arquivo que representa o estado do armazém. */
export function arquivoDe(armazem, aparelho) {
  const d = armazem.dados;
  const tags = {};
  for (const [nome, cor] of Object.entries(d.tag_colors)) tags[nome] = { color: [...cor], at: d.tag_stamps[nome] ?? 0 };
  for (const [nome, at] of Object.entries(d.tag_stamps)) tags[nome] ??= { color: null, at };
  return {
    schema: SCHEMA,
    app: "N.avi",
    written_by: aparelho,
    written_at: d.clock,
    clock: d.clock,
    tasks: d.tasks.map(tarefaParaArquivo),
    deleted: d.deleted.map((x) => ({ uid: x.uid, at: x.at })),
    tags,
  };
}

/**
 * Lê o texto de um arquivo de sincronização e o completa (o que falta vale o padrão). Lança um erro se o texto
 * não é um arquivo do N.avi. Tarefas sem `uid` são descartadas: sem identidade não há como mesclar.
 */
export function lerArquivo(texto) {
  let bruto;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new Error("O arquivo de sincronização não é um JSON legível.");
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) throw new Error("O arquivo de sincronização não tem o formato esperado.");
  const tags = {};
  for (const [nome, e] of Object.entries(bruto.tags && typeof bruto.tags === "object" ? bruto.tags : {})) {
    const cor = Array.isArray(e?.color) && e.color.length === 3 ? e.color.map((n) => Math.trunc(Number(n)) || 0) : null;
    tags[nome] = { color: cor, at: Number.isFinite(e?.at) ? Math.trunc(e.at) : 0 };
  }
  return {
    schema: Number.isFinite(bruto.schema) ? bruto.schema : 0,
    app: String(bruto.app ?? ""),
    written_by: String(bruto.written_by ?? ""),
    written_at: Number.isFinite(bruto.written_at) ? bruto.written_at : 0,
    clock: Number.isFinite(bruto.clock) ? bruto.clock : 0,
    tasks: (Array.isArray(bruto.tasks) ? bruto.tasks : [])
      .filter((t) => t && typeof t === "object" && typeof t.uid === "string" && t.uid)
      .map((t) => {
        const { id: _local, ...resto } = structuredClone(t); // o id de outro aparelho não vale aqui
        return normalizar(resto);
      }),
    deleted: (Array.isArray(bruto.deleted) ? bruto.deleted : [])
      .filter((x) => x && typeof x.uid === "string" && x.uid)
      .map((x) => ({ uid: x.uid, at: Number.isFinite(x.at) ? Math.trunc(x.at) : 0 })),
    tags,
  };
}

/** Os dois arquivos têm o mesmo conteúdo (fora o cabeçalho: quem gravou e quando)? A ordem das tarefas não conta. */
export function mesmoConteudo(a, b) {
  const porUid = (x, y) => (x.uid < y.uid ? -1 : x.uid > y.uid ? 1 : 0);
  const canonico = (f) =>
    JSON.stringify({
      tasks: [...f.tasks].map(tarefaParaArquivo).sort(porUid),
      deleted: [...f.deleted].sort(porUid),
      tags: Object.fromEntries(Object.entries(f.tags).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    });
  return canonico(a) === canonico(b);
}

/** O relógio local nunca fica atrás de nada que o arquivo traz. */
export function adiantarRelogio(armazem, arquivo) {
  armazem.adiantarRelogio(arquivo.clock);
  for (const t of arquivo.tasks) armazem.adiantarRelogio(maisRecente(t.stamps));
  for (const x of arquivo.deleted) armazem.adiantarRelogio(x.at);
  for (const e of Object.values(arquivo.tags)) armazem.adiantarRelogio(e.at);
}

// ---------------------------------------------------------------------------------------------------- mesclar

/**
 * Mescla o arquivo lido (`null` se ele não existe) com as tarefas do armazém e devolve o arquivo a gravar.
 * Determinística: dois aparelhos que mesclem os mesmos dados, em qualquer ordem, chegam ao mesmo lugar.
 * `agoraParede` (ms) serve só para podar lápides velhas, nunca o relógio híbrido, que pode estar adiantado.
 * Quem chama já carimbou as edições ainda não gravadas (`armazem.carimbarMudancas()`) com o relógio adiantado.
 */
export function mesclar(armazem, remoto, aparelho, agoraParede) {
  const d = armazem.dados;
  let mudouLocal = false;
  if (remoto) {
    adiantarRelogio(armazem, remoto);

    for (const rt of remoto.tasks) {
      const lapide = d.deleted.find((x) => x.uid === rt.uid);
      // Exclusão aqui depois da última edição lá: continua excluída (a lápide vai no arquivo).
      if (lapide && lapide.at >= maisRecente(rt.stamps)) continue;
      if (lapide) {
        // Edição lá depois da exclusão aqui: a tarefa volta.
        d.deleted = d.deleted.filter((x) => x.uid !== rt.uid);
        mudouLocal = true;
      }
      const local = armazem.acharUid(rt.uid);
      if (local) {
        for (const g of GRUPOS_SYNC) {
          const [ls, rs] = [local.stamps[g], rt.stamps[g]];
          const maisNova = rs > ls;
          // Empate exato com conteúdo diferente: decide pelo texto, igual nos dois lados.
          const empate = rs === ls && !igualGrupo(local, rt, g) && compararBytes(chaveGrupo(rt, g), chaveGrupo(local, g)) > 0;
          if (maisNova || empate) {
            copiarGrupo(local, rt, g);
            mudouLocal = true;
          }
        }
      } else {
        armazem.adotar(structuredClone(rt));
        mudouLocal = true;
      }
    }

    for (const x of remoto.deleted) {
      const local = armazem.acharUid(x.uid);
      if (local) {
        // Editada aqui depois da exclusão lá: sobrevive, e a lápide remota cai.
        if (maisRecente(local.stamps) > x.at) continue;
        armazem.removerUid(x.uid);
        mudouLocal = true;
      }
      if (!d.deleted.some((y) => y.uid === x.uid)) {
        d.deleted.push({ uid: x.uid, at: x.at });
        mudouLocal = true;
      }
    }

    for (const [nome, e] of Object.entries(remoto.tags)) {
      if (e.at > (d.tag_stamps[nome] ?? 0)) {
        if (e.color) d.tag_colors[nome] = [...e.color];
        else delete d.tag_colors[nome];
        d.tag_stamps[nome] = e.at;
        mudouLocal = true;
      }
    }
  }

  // Lápides velhas saem, pelo relógio de parede: uma lápide "do futuro" (aparelho com a hora adiantada) fica.
  const horizonte = agoraParede - VIDA_DA_LAPIDE_MS;
  const antes = d.deleted.length;
  d.deleted = d.deleted.filter((x) => x.at >= horizonte);
  mudouLocal ||= d.deleted.length !== antes;

  const arquivo = arquivoDe(armazem, aparelho);
  return { mudouLocal, mudouArquivo: !remoto || !mesmoConteudo(remoto, arquivo), arquivo };
}

/**
 * Primeira mesclagem com um arquivo que já existe: uma tarefa daqui sem par no arquivo e uma do arquivo sem par
 * aqui, com o mesmo título, data e hora, são a mesma tarefa que ganhou `uid`s diferentes. A daqui assume a do
 * arquivo, inteira (só o `id` local fica). Sem isto, tudo apareceria em dobro.
 */
export function adotarIguais(armazem, remoto) {
  const uidsRemotos = new Set(remoto.tasks.map((t) => t.uid));
  const chave = (t) => `${t.title.trim()}\u0000${t.date ?? ""}\u0000${t.time ?? ""}`;
  let mudou = false;
  for (const rt of remoto.tasks) {
    if (armazem.acharUid(rt.uid)) continue;
    const i = armazem.dados.tasks.findIndex((lt) => !uidsRemotos.has(lt.uid) && chave(lt) === chave(rt));
    if (i >= 0) {
      armazem.dados.tasks[i] = { ...structuredClone(rt), id: armazem.dados.tasks[i].id };
      mudou = true;
    }
  }
  if (mudou) armazem.marcarSujo();
  return mudou;
}
