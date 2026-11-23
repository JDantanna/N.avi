// Recorrência das tarefas: o mesmo cálculo de `occurs_on`, `next_after`, `roll_over` e `overdue` do desktop
// (src/model.rs). A data de hoje entra como parâmetro, o que deixa tudo testável; os testes usam os vetores
// de `web/tests/vetores-recorrencia.json`, que o desktop também pode rodar para provar que os dois batem.

import { diasEntre, diasNoMes, diaDaSemana, partes, somaDias, somaMeses } from "./datas.js";

export const REPETE = ["None", "Daily", "Weekly", "Monthly", "Yearly"];

export const ROTULO_REPETE = {
  None: "Não repete",
  Daily: "Diariamente",
  Weekly: "Semanalmente",
  Monthly: "Mensalmente",
  Yearly: "Anualmente",
};

/** A unidade da repetição no singular ou no plural: "dia", "dias", "mês", "meses"... */
export function unidade(repete, n) {
  const um = n === 1;
  switch (repete) {
    case "Daily": return um ? "dia" : "dias";
    case "Weekly": return um ? "semana" : "semanas";
    case "Monthly": return um ? "mês" : "meses";
    case "Yearly": return um ? "ano" : "anos";
    default: return "";
  }
}

const cada = (t) => Math.max(1, t.every | 0 || 1);

/** O dia do mês de referência da recorrência mensal e anual. */
function ancora(t, d) {
  return t.anchor_day ? t.anchor_day : partes(d).d;
}

/** Guarda o dia da data atual como referência da recorrência (o dia 30 volta ao 30 depois de fevereiro). */
export function definirAncora(t) {
  if (t.date) t.anchor_day = partes(t.date).d;
}

/** A data seguinte à ocorrência `d`. */
export function proximaApos(t, d) {
  const n = cada(t);
  switch (t.repeat) {
    case "Daily": return somaDias(d, n);
    case "Weekly": return somaDias(d, 7 * n);
    case "Monthly": return somaMeses(d, n, ancora(t, d));
    case "Yearly": return somaMeses(d, 12 * n, ancora(t, d));
    default: return d;
  }
}

/**
 * Ao concluir uma tarefa recorrente, ela volta pendente na próxima data de hoje em diante. Em repetição finita,
 * a última ocorrência concluída fica concluída de vez. Retorna `true` se a tarefa foi reagendada.
 */
export function reagendar(t, hoje) {
  if (t.repeat === "None" || !t.done) return false;
  // Ocorrências que ainda restam depois desta (as puladas por atraso também contam).
  let resta = t.repeat_times == null ? null : t.repeat_times - 1;
  let proxima = proximaApos(t, t.date ?? hoje);
  for (let i = 0; i < 2000; i++) {
    if (resta !== null && resta <= 0) {
      t.repeat_times = 1;
      return false;
    }
    if (proxima >= hoje) break;
    if (resta !== null) resta -= 1;
    proxima = proximaApos(t, proxima);
  }
  if (resta !== null && resta <= 0) {
    t.repeat_times = 1;
    return false;
  }
  t.repeat_times = resta;
  t.date = proxima;
  t.done = false;
  for (const s of t.subtasks ?? []) s.done = false;
  return true;
}

/** A tarefa cai no dia `d`? Considera a data marcada e as repetições futuras. */
export function ocorreEm(t, d) {
  const inicio = t.date;
  if (!inicio) return false;
  if (d === inicio) return true;
  if (t.repeat === "None" || d < inicio) return false;
  const n = cada(t);
  const a = ancora(t, inicio);
  const { y: yi, m: mi } = partes(inicio);
  const { y, m, d: dia } = partes(d);
  const meses = (y - yi) * 12 + (m - mi);
  const noDia = dia === Math.min(a, diasNoMes(y, m));
  const dias = diasEntre(inicio, d);
  // Número da ocorrência (0 é a da data de início), se `d` for um dia em que a tarefa repete.
  let nth = null;
  switch (t.repeat) {
    case "Daily": if (dias % n === 0) nth = dias / n; break;
    case "Weekly": if (dias % (7 * n) === 0) nth = dias / (7 * n); break;
    case "Monthly": if (meses % n === 0 && noDia) nth = meses / n; break;
    case "Yearly": if (meses % (12 * n) === 0 && noDia) nth = meses / (12 * n); break;
    default: break;
  }
  return nth !== null && (t.repeat_times == null || nth < t.repeat_times);
}

/** "14:30" ou "14:30:00" como "14:30:00", para comparar horas como texto. */
const comSegundos = (h) => (String(h).length === 5 ? `${h}:00` : String(h).slice(0, 8));

/** Pendente e com a data (e a hora, se houver) já passada. `agora` é a hora de agora, "HH:MM:SS". */
export function atrasada(t, hoje, agora) {
  if (t.done || !t.date) return false;
  if (t.time) return t.date < hoje || (t.date === hoje && comSegundos(t.time) < comSegundos(agora));
  return t.date < hoje;
}

/** Em qual dia da semana (segunda = 0) cai uma data; reexportado para quem só precisa da recorrência. */
export { diaDaSemana };
