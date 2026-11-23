// Datas como texto "AAAA-MM-DD" (o mesmo formato do tasks.json do desktop). A conta é feita em UTC, em dias
// inteiros, para o horário de verão e o fuso do aparelho nunca mudarem o dia de uma tarefa.

const DIA_MS = 86_400_000;

export const DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"];
export const DIAS_CURTOS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
export const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

const dois = (n) => String(n).padStart(2, "0");

/** Milissegundos (UTC, meia-noite) de uma data "AAAA-MM-DD". */
export function parse(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function fmt(ms) {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${dois(t.getUTCMonth() + 1)}-${dois(t.getUTCDate())}`;
}

/** As partes de uma data: ano, mês (1 a 12) e dia. */
export function partes(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export const somaDias = (iso, n) => fmt(parse(iso) + n * DIA_MS);

/** Quantos dias de `a` até `b` (positivo se `b` vem depois). */
export const diasEntre = (a, b) => Math.round((parse(b) - parse(a)) / DIA_MS);

/** Quantos dias tem o mês `m` (1 a 12) do ano `y`. */
export const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Soma meses mantendo o dia-âncora; em meses curtos usa o último dia (30 vira 28 em fevereiro). */
export function somaMeses(iso, meses, ancora) {
  const { y, m } = partes(iso);
  const total = y * 12 + (m - 1) + meses;
  const ny = Math.floor(total / 12);
  const nm = (((total % 12) + 12) % 12) + 1;
  return fmt(Date.UTC(ny, nm - 1, Math.min(ancora, diasNoMes(ny, nm))));
}

/** Dia da semana com a segunda-feira em 0 e o domingo em 6. */
export function diaDaSemana(iso) {
  return (new Date(parse(iso)).getUTCDay() + 6) % 7;
}

/** Primeiro dia do mês de `iso`. */
export const primeiroDoMes = (iso) => `${iso.slice(0, 8)}01`;

/** O dia de hoje no relógio do aparelho. */
export function hojeIso(agora = new Date()) {
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;
}

/** A hora de agora no relógio do aparelho, "HH:MM:SS". */
export function agoraHMS(agora = new Date()) {
  return `${dois(agora.getHours())}:${dois(agora.getMinutes())}:${dois(agora.getSeconds())}`;
}

/** "14:30:00" (o formato do arquivo do desktop) vira "14:30"; vazio fica `null`. */
export const horaCurta = (t) => (t ? String(t).slice(0, 5) : null);

/** "14:30" vira "14:30:00", como o desktop grava. */
export const horaDoArquivo = (hm) => (hm ? `${hm.slice(0, 5)}:00` : null);

/** "19/11" ou "19/11/2026". */
export function diaMes(iso, comAno = false) {
  const { y, m, d } = partes(iso);
  return comAno ? `${dois(d)}/${dois(m)}/${y}` : `${dois(d)}/${dois(m)}`;
}

/** Rótulo de um dia em relação a hoje: Hoje, Amanhã, o dia da semana (nos próximos dias) ou a data. */
export function rotuloDia(iso, hoje) {
  const n = diasEntre(hoje, iso);
  if (n === 0) return "Hoje";
  if (n === 1) return "Amanhã";
  if (n >= 2 && n <= 6) return DIAS[diaDaSemana(iso)];
  return diaMes(iso, partes(iso).y !== partes(hoje).y);
}

export const nomeDoMes = (iso) => `${MESES[partes(iso).m - 1]} de ${partes(iso).y}`;
