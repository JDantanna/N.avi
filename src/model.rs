use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};

/// Pasta de dados do app (`%APPDATA%\Navi`). Migra a antiga `Des_Atento` na primeira execução.
pub fn data_dir() -> PathBuf {
    // Os testes nunca tocam nos dados de verdade de quem os roda.
    if cfg!(test) {
        return std::env::temp_dir().join("navi_testes");
    }
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let new = base.join("Navi");
    let old = base.join("Des_Atento");
    if !new.exists() && old.exists() {
        let _ = std::fs::rename(&old, &new);
    }
    new
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
pub struct Subtask {
    pub title: String,
    pub done: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum Repeat {
    #[default]
    None,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Repeat {
    pub const ALL: [Repeat; 5] = [Repeat::None, Repeat::Daily, Repeat::Weekly, Repeat::Monthly, Repeat::Yearly];

    pub fn label(self) -> &'static str {
        match self {
            Repeat::None => "Não repete",
            Repeat::Daily => "Diariamente",
            Repeat::Weekly => "Semanalmente",
            Repeat::Monthly => "Mensalmente",
            Repeat::Yearly => "Anualmente",
        }
    }

    pub fn unit(self, n: u32) -> &'static str {
        match (self, n == 1) {
            (Repeat::Daily, true) => "dia",
            (Repeat::Daily, false) => "dias",
            (Repeat::Weekly, true) => "semana",
            (Repeat::Weekly, false) => "semanas",
            (Repeat::Monthly, true) => "mês",
            (Repeat::Monthly, false) => "meses",
            (Repeat::Yearly, true) => "ano",
            (Repeat::Yearly, false) => "anos",
            (Repeat::None, _) => "",
        }
    }
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) };
    next.and_then(|n| n.pred_opt()).map_or(28, |d| d.day())
}

/// Soma meses mantendo o dia-âncora; em meses curtos usa o último dia (30 -> 28 em fevereiro).
fn add_months(d: NaiveDate, months: i32, anchor: u32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 + months;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    NaiveDate::from_ymd_opt(y, m, anchor.min(days_in_month(y, m))).unwrap_or(d)
}

/// Quando cada grupo de campos de uma tarefa mudou pela última vez, no relógio de sincronização (ms Unix, de um
/// relógio híbrido que nunca anda para trás: ver `Store::now_stamp`). Cada grupo é mesclado por conta própria
/// entre aparelhos: concluir no celular e mudar o título no computador ao mesmo tempo não perde nenhum dos dois.
#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(default)]
pub struct Stamps {
    pub title: i64,
    pub notes: i64,
    /// Data, hora, concluída e repetição: mudam juntas ao concluir uma recorrente.
    pub state: i64,
    pub notify: i64,
    pub tags: i64,
    pub color: i64,
    pub subtasks: i64,
}

/// Os grupos de campos de uma tarefa que a sincronização mescla separadamente.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Group {
    Title,
    Notes,
    State,
    Notify,
    Tags,
    Color,
    Subtasks,
}

impl Group {
    pub const ALL: [Group; 7] = [Group::Title, Group::Notes, Group::State, Group::Notify, Group::Tags, Group::Color, Group::Subtasks];
}

impl Stamps {
    pub fn get(&self, g: Group) -> i64 {
        match g {
            Group::Title => self.title,
            Group::Notes => self.notes,
            Group::State => self.state,
            Group::Notify => self.notify,
            Group::Tags => self.tags,
            Group::Color => self.color,
            Group::Subtasks => self.subtasks,
        }
    }

    pub fn set(&mut self, g: Group, at: i64) {
        match g {
            Group::Title => self.title = at,
            Group::Notes => self.notes = at,
            Group::State => self.state = at,
            Group::Notify => self.notify = at,
            Group::Tags => self.tags = at,
            Group::Color => self.color = at,
            Group::Subtasks => self.subtasks = at,
        }
    }

    /// O carimbo mais recente da tarefa (a última vez que algo nela mudou).
    pub fn latest(&self) -> i64 {
        Group::ALL.iter().map(|g| self.get(*g)).max().unwrap_or(0)
    }
}

/// Tarefa excluída, lembrada para a exclusão chegar aos outros aparelhos.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct Tombstone {
    pub uid: String,
    /// Carimbo da exclusão.
    pub at: i64,
}

/// Identidade nova, única entre aparelhos: 128 bits misturados do relógio, do processo, de um contador e do
/// endereço de uma variável (que muda a cada execução). Sem dependência de gerador aleatório.
pub fn fresh_uid() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    fn mix(mut z: u64) -> u64 {
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    let addr = &n as *const u64 as u64;
    format!("{:016x}{:016x}", mix(t ^ pid.rotate_left(32) ^ n.wrapping_mul(0x9e37_79b9_7f4a_7c15)), mix(t.rotate_left(17) ^ addr ^ n))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: u64,
    /// Identidade entre aparelhos (o `id` vale só nesta máquina). Vazio só em arquivos de versões antigas.
    #[serde(default)]
    pub uid: String,
    /// Quando cada grupo de campos mudou pela última vez.
    #[serde(default)]
    pub stamps: Stamps,
    pub title: String,
    pub notes: String,
    pub done: bool,
    pub subtasks: Vec<Subtask>,
    pub date: Option<NaiveDate>,
    pub time: Option<NaiveTime>,
    /// Minutos de antecedência do aviso (0 = no horário). `None` = sem aviso.
    pub notify: Option<u32>,
    /// Avisar também no dia anterior (na mesma hora, ou às 9h se a tarefa não tem hora).
    #[serde(default)]
    pub notify_day_before: bool,
    pub tags: Vec<String>,
    pub color: [u8; 3],
    #[serde(default)]
    pub repeat: Repeat,
    /// Repete a cada N dias/semanas/meses/anos.
    #[serde(default = "one")]
    pub every: u32,
    /// Dia do mês de referência da recorrência mensal/anual (o dia 30 volta ao 30 depois de fevereiro).
    #[serde(default)]
    pub anchor_day: u32,
    /// Repetição finita: quantas ocorrências faltam, contando a da data atual. `None` = para sempre.
    #[serde(default)]
    pub repeat_times: Option<u32>,
}

fn one() -> u32 {
    1
}

impl Task {
    /// Guarda o dia da data atual como referência da recorrência.
    pub fn set_anchor(&mut self) {
        if let Some(d) = self.date {
            self.anchor_day = d.day();
        }
    }

    fn anchor(&self, d: NaiveDate) -> u32 {
        if self.anchor_day == 0 { d.day() } else { self.anchor_day }
    }

    /// A data seguinte à ocorrência `d`.
    fn next_after(&self, d: NaiveDate) -> NaiveDate {
        let n = self.every.max(1) as i64;
        match self.repeat {
            Repeat::None => d,
            Repeat::Daily => d + chrono::Duration::days(n),
            Repeat::Weekly => d + chrono::Duration::days(7 * n),
            Repeat::Monthly => add_months(d, n as i32, self.anchor(d)),
            Repeat::Yearly => add_months(d, 12 * n as i32, self.anchor(d)),
        }
    }

    /// Ao concluir uma tarefa recorrente, ela volta pendente na próxima data futura.
    /// Em repetição finita, a última ocorrência concluída fica concluída de vez.
    /// Retorna `true` se a tarefa foi reagendada.
    pub fn roll_over(&mut self) -> bool {
        self.roll_over_on(Local::now().date_naive())
    }

    /// [`Self::roll_over`] com o dia de hoje dado (para os testes e para o celular reproduzirem o mesmo).
    pub fn roll_over_on(&mut self, today: NaiveDate) -> bool {
        if self.repeat == Repeat::None || !self.done {
            return false;
        }
        // Ocorrências que ainda restam depois desta (as puladas por atraso também contam).
        let mut left = self.repeat_times.map(|n| n as i64 - 1);
        let mut next = self.next_after(self.date.unwrap_or(today));
        for _ in 0..2000 {
            if left.is_some_and(|n| n <= 0) {
                self.repeat_times = Some(1);
                return false;
            }
            if next >= today {
                break;
            }
            left = left.map(|n| n - 1);
            next = self.next_after(next);
        }
        if left.is_some_and(|n| n <= 0) {
            self.repeat_times = Some(1);
            return false;
        }
        self.repeat_times = left.map(|n| n as u32);
        self.date = Some(next);
        self.done = false;
        self.subtasks.iter_mut().for_each(|s| s.done = false);
        true
    }

    /// A tarefa cai no dia `d`? Considera a data marcada e as repetições futuras.
    pub fn occurs_on(&self, d: NaiveDate) -> bool {
        let Some(start) = self.date else { return false };
        if d == start {
            return true;
        }
        if self.repeat == Repeat::None || d < start {
            return false;
        }
        let n = self.every.max(1) as i64;
        let anchor = self.anchor(start);
        let months = (d.year() - start.year()) as i64 * 12 + d.month0() as i64 - start.month0() as i64;
        let on_day = d.day() == anchor.min(days_in_month(d.year(), d.month()));
        // Número da ocorrência (0 = a da data de início), se `d` for um dia em que a tarefa repete.
        let nth = match self.repeat {
            Repeat::None => None,
            Repeat::Daily => ((d - start).num_days() % n == 0).then(|| (d - start).num_days() / n),
            Repeat::Weekly => ((d - start).num_days() % (7 * n) == 0).then(|| (d - start).num_days() / (7 * n)),
            Repeat::Monthly => (months % n == 0 && on_day).then(|| months / n),
            Repeat::Yearly => (months % (12 * n) == 0 && on_day).then(|| months / (12 * n)),
        };
        nth.is_some_and(|k| self.repeat_times.is_none_or(|total| k < total as i64))
    }

    /// Pendente e com a data (e hora, se houver) já passada.
    pub fn overdue(&self, now: NaiveDateTime) -> bool {
        if self.done {
            return false;
        }
        match (self.date, self.time) {
            (Some(d), Some(t)) => d.and_time(t) < now,
            (Some(d), None) => d < now.date(),
            _ => false,
        }
    }

    pub fn subtasks_done(&self) -> (usize, usize) {
        (self.subtasks.iter().filter(|s| s.done).count(), self.subtasks.len())
    }

    /// Os campos do grupo `g` são iguais nas duas tarefas?
    pub fn group_eq(&self, other: &Task, g: Group) -> bool {
        match g {
            Group::Title => self.title == other.title,
            Group::Notes => self.notes == other.notes,
            Group::State => {
                self.done == other.done
                    && self.date == other.date
                    && self.time == other.time
                    && self.repeat == other.repeat
                    && self.every == other.every
                    && self.anchor_day == other.anchor_day
                    && self.repeat_times == other.repeat_times
            }
            Group::Notify => self.notify == other.notify && self.notify_day_before == other.notify_day_before,
            Group::Tags => self.tags == other.tags,
            Group::Color => self.color == other.color,
            Group::Subtasks => self.subtasks == other.subtasks,
        }
    }

    /// Copia os campos do grupo `g`, e o carimbo dele, de `from`.
    pub fn copy_group(&mut self, from: &Task, g: Group) {
        match g {
            Group::Title => self.title = from.title.clone(),
            Group::Notes => self.notes = from.notes.clone(),
            Group::State => {
                self.done = from.done;
                self.date = from.date;
                self.time = from.time;
                self.repeat = from.repeat;
                self.every = from.every;
                self.anchor_day = from.anchor_day;
                self.repeat_times = from.repeat_times;
            }
            Group::Notify => {
                self.notify = from.notify;
                self.notify_day_before = from.notify_day_before;
            }
            Group::Tags => self.tags = from.tags.clone(),
            Group::Color => self.color = from.color,
            Group::Subtasks => self.subtasks = from.subtasks.clone(),
        }
        self.stamps.set(g, from.stamps.get(g));
    }

    /// Texto canônico do grupo `g`, para desempatar carimbos iguais do mesmo jeito em qualquer aparelho.
    pub fn group_key(&self, g: Group) -> String {
        match g {
            Group::Title => format!("{:?}", self.title),
            Group::Notes => format!("{:?}", self.notes),
            Group::State => format!(
                "{}|{}|{}|{:?}|{}|{}|{}",
                self.done,
                self.date.map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default(),
                self.time.map(|t| t.format("%H:%M:%S").to_string()).unwrap_or_default(),
                self.repeat,
                self.every,
                self.anchor_day,
                self.repeat_times.map(|n| n.to_string()).unwrap_or_default()
            ),
            Group::Notify => format!("{}|{}", self.notify.map(|n| n.to_string()).unwrap_or_default(), self.notify_day_before),
            Group::Tags => format!("{:?}", self.tags),
            Group::Color => format!("{:?}", self.color),
            Group::Subtasks => format!("{:?}", self.subtasks),
        }
    }
}

pub type TagColors = BTreeMap<String, [u8; 3]>;

const TAG_PALETTE: [[u8; 3]; 8] =
    [[110, 142, 251], [236, 112, 99], [88, 196, 141], [240, 178, 70], [176, 124, 230], [80, 190, 210], [230, 120, 170], [160, 170, 90]];

/// Cor da tag: a escolhida pelo usuário ou, na falta dela, uma da paleta (sempre a mesma para o mesmo nome).
pub fn tag_rgb(colors: &TagColors, tag: &str) -> [u8; 3] {
    colors.get(tag).copied().unwrap_or_else(|| {
        let h = tag.bytes().fold(7usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize));
        TAG_PALETTE[h % TAG_PALETTE.len()]
    })
}

#[derive(Serialize, Deserialize, Default)]
pub struct Store {
    next_id: u64,
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub tag_colors: TagColors,
    /// Quando a cor de cada tag mudou pela última vez; uma tag com carimbo e sem cor teve a cor removida.
    #[serde(default)]
    pub tag_stamps: BTreeMap<String, i64>,
    /// Tarefas excluídas, para a exclusão chegar aos outros aparelhos.
    #[serde(default)]
    pub deleted: Vec<Tombstone>,
    /// Relógio de sincronização: o maior carimbo já dado ou visto. Nunca anda para trás, nem com o relógio do
    /// computador errado (ver `now_stamp`).
    #[serde(default)]
    pub clock: i64,
    /// Já mesclou com um arquivo de sincronização existente. Antes disso, a primeira mesclagem casa tarefas
    /// iguais (título, data, hora) que tenham `uid`s diferentes: as de um computador migrado e as do arquivo.
    #[serde(default)]
    pub synced_once: bool,
    #[serde(skip)]
    pub dirty: bool,
    /// As tarefas como estavam na última gravação ou sincronização, por `uid`: é comparando com isto que a
    /// gravação descobre o que mudou e carimba só os grupos certos.
    #[serde(skip)]
    last: HashMap<String, Task>,
}

impl Store {
    /// Um carimbo novo: o relógio de agora, ou um passo à frente do maior carimbo já visto, o que for maior.
    pub fn now_stamp(&mut self) -> i64 {
        self.stamp_at(Utc::now().timestamp_millis())
    }

    /// O mesmo que `now_stamp`, com o relógio de parede dado (a mesclagem usa o dela, para os casos
    /// compartilhados saírem iguais em qualquer máquina).
    pub fn stamp_at(&mut self, wall: i64) -> i64 {
        self.clock = wall.max(self.clock + 1);
        self.clock
    }

    /// Um carimbo lido de outro aparelho: o relógio daqui nunca fica atrás dele.
    pub fn bump_clock(&mut self, seen: i64) {
        self.clock = self.clock.max(seen);
    }

    /// Carimba os grupos que mudaram desde a última gravação, cria lápides para as tarefas que sumiram e tira as
    /// lápides das que voltaram (desfazer). Roda a cada gravação, antes de escrever o arquivo, e antes de cada
    /// mesclagem, para uma edição ainda não gravada ter carimbo de agora e não perder para o arquivo.
    pub(crate) fn stamp_changes(&mut self) {
        let changed = self
            .tasks
            .iter()
            .any(|t| self.last.get(&t.uid).is_none_or(|p| Group::ALL.iter().any(|g| !p.group_eq(t, *g))))
            || self.last.keys().any(|uid| !self.tasks.iter().any(|t| &t.uid == uid));
        if !changed {
            return;
        }
        let now = self.now_stamp();
        let Store { tasks, last, deleted, .. } = self;
        for t in tasks.iter_mut() {
            match last.get(&t.uid) {
                None => {
                    for g in Group::ALL {
                        t.stamps.set(g, now);
                    }
                }
                Some(prev) => {
                    for g in Group::ALL {
                        if !prev.group_eq(t, g) {
                            t.stamps.set(g, now);
                        }
                    }
                }
            }
        }
        let seen: HashSet<String> = tasks.iter().map(|t| t.uid.clone()).collect();
        for uid in last.keys() {
            if !seen.contains(uid) && !deleted.iter().any(|d| &d.uid == uid) {
                deleted.push(Tombstone { uid: uid.clone(), at: now });
            }
        }
        deleted.retain(|d| !seen.contains(&d.uid));
        *last = tasks.iter().map(|t| (t.uid.clone(), t.clone())).collect();
    }

    /// O estado de agora passa a ser a referência para a próxima gravação (depois de mesclar com outro aparelho,
    /// para o que veio de lá não ser carimbado de novo como mudança daqui).
    pub fn mark_synced(&mut self) {
        self.set_reference(&self.tasks.clone());
    }

    /// Uma referência dada (nos testes: o estado da última sincronização que o caso descreve).
    pub fn set_reference(&mut self, tasks: &[Task]) {
        self.last = tasks.iter().map(|t| (t.uid.clone(), t.clone())).collect();
    }

    /// A tarefa `uid` como estava na última gravação ou mesclagem: a base para saber se os dois lados mudaram
    /// o mesmo grupo desde então.
    pub fn reference(&self, uid: &str) -> Option<&Task> {
        self.last.get(uid)
    }

    /// Entra uma tarefa vinda de outro aparelho, com um id local novo.
    pub fn adopt(&mut self, mut task: Task) -> u64 {
        self.next_id += 1;
        task.id = self.next_id;
        self.tasks.push(task);
        self.dirty = true;
        self.next_id
    }

    pub fn find_uid(&self, uid: &str) -> Option<usize> {
        self.tasks.iter().position(|t| t.uid == uid)
    }

    pub fn remove_uid(&mut self, uid: &str) {
        self.tasks.retain(|t| t.uid != uid);
        self.dirty = true;
    }

    /// Tarefas de versões sem sincronização ganham identidade e carimbo; o retrato da última gravação começa daqui.
    fn migrate(&mut self) {
        let legacy = self.tasks.iter().any(|t| t.uid.is_empty() || t.stamps == Stamps::default());
        if legacy {
            let now = self.now_stamp();
            for t in &mut self.tasks {
                if t.uid.is_empty() {
                    t.uid = fresh_uid();
                }
                if t.stamps == Stamps::default() {
                    for g in Group::ALL {
                        t.stamps.set(g, now);
                    }
                }
            }
            self.dirty = true;
        }
        self.mark_synced();
    }

    pub fn add(&mut self, title: String, date: Option<NaiveDate>) -> u64 {
        self.next_id += 1;
        self.tasks.push(Task {
            id: self.next_id,
            uid: fresh_uid(),
            stamps: Stamps::default(),
            title,
            notes: String::new(),
            done: false,
            subtasks: Vec::new(),
            date,
            time: None,
            notify: None,
            notify_day_before: false,
            tags: Vec::new(),
            color: [110, 142, 251],
            repeat: Repeat::None,
            every: 1,
            anchor_day: 0,
            repeat_times: None,
        });
        self.dirty = true;
        self.next_id
    }

    /// Ordena as tarefas pela hora (as sem hora ficam no fim); a ordem passa a ser a da lista.
    pub fn sort_by_time(&mut self, descending: bool) {
        use std::cmp::Ordering;
        self.tasks.sort_by(|a, b| match (a.time, b.time) {
            (Some(x), Some(y)) if descending => y.cmp(&x),
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        });
        self.dirty = true;
    }

    /// Leva a tarefa `id` para a posição da tarefa `target` (as do meio se deslocam).
    pub fn move_task(&mut self, id: u64, target: u64) {
        let (Some(from), Some(to)) =
            (self.tasks.iter().position(|t| t.id == id), self.tasks.iter().position(|t| t.id == target))
        else {
            return;
        };
        if from != to {
            let t = self.tasks.remove(from);
            self.tasks.insert(to, t);
            self.dirty = true;
        }
    }

    pub fn remove(&mut self, id: u64) {
        self.tasks.retain(|t| t.id != id);
        self.dirty = true;
    }

    /// Desfaz uma mudança: a tarefa volta como estava e, se foi excluída, para a posição de antes.
    /// Se a exclusão já virou lápide (foi gravada), a lápide cai e a tarefa volta carimbada de agora, para vencer
    /// a lápide que já pode ter ido ao arquivo de sincronização.
    pub fn restore(&mut self, mut task: Task, index: usize) {
        if self.deleted.iter().any(|d| d.uid == task.uid) {
            self.deleted.retain(|d| d.uid != task.uid);
            let now = self.now_stamp();
            for g in Group::ALL {
                task.stamps.set(g, now);
            }
        }
        if let Some(p) = self.tasks.iter().position(|t| t.id == task.id) {
            self.tasks[p] = task;
        } else {
            self.tasks.insert(index.min(self.tasks.len()), task);
        }
        self.dirty = true;
    }

    /// Depois de restaurar um backup: tudo o que foi restaurado passa a valer como editado agora, para a
    /// sincronização não desfazer a restauração com o que o arquivo tem de mais novo (inclusive lápides).
    /// `floor` é o relógio de antes da restauração, para os carimbos novos ficarem à frente dele.
    pub fn restamp_all(&mut self, floor: i64) {
        self.bump_clock(floor);
        let now = self.now_stamp();
        for t in &mut self.tasks {
            for g in Group::ALL {
                t.stamps.set(g, now);
            }
        }
        for at in self.tag_stamps.values_mut() {
            *at = now;
        }
        for name in self.tag_colors.keys() {
            self.tag_stamps.insert(name.clone(), now);
        }
        self.mark_synced();
        self.dirty = true;
    }

    /// Tarefas pendentes que pedem atenção hoje, como índices: as atrasadas primeiro, depois as de hoje
    /// por hora (as sem hora no fim).
    pub fn today_pending(&self, today: NaiveDate, now: NaiveDateTime) -> Vec<usize> {
        let mut v: Vec<usize> = (0..self.tasks.len())
            .filter(|&i| {
                let t = &self.tasks[i];
                !t.done && (t.overdue(now) || t.occurs_on(today))
            })
            .collect();
        v.sort_by_key(|&i| {
            let t = &self.tasks[i];
            (!t.overdue(now), t.date, t.time.is_none(), t.time, t.id)
        });
        v
    }

    pub fn all_tags(&self) -> Vec<String> {
        let mut v: Vec<String> = self.tasks.iter().flat_map(|t| t.tags.iter().cloned()).collect();
        v.sort_by_key(|t| t.to_lowercase());
        v.dedup();
        v
    }

    /// Quantas tarefas usam a tag.
    pub fn tag_count(&self, tag: &str) -> usize {
        self.tasks.iter().filter(|t| t.tags.iter().any(|x| x == tag)).count()
    }

    pub fn set_tag_color(&mut self, tag: &str, rgb: [u8; 3]) {
        let now = self.now_stamp();
        self.tag_colors.insert(tag.to_owned(), rgb);
        self.tag_stamps.insert(tag.to_owned(), now);
        self.dirty = true;
    }

    /// Renomeia a tag em todas as tarefas; se o novo nome já existe, as duas se juntam.
    pub fn rename_tag(&mut self, from: &str, to: &str) {
        let to = to.trim().trim_start_matches('#').trim();
        if to.is_empty() || to == from {
            return;
        }
        for t in &mut self.tasks {
            if let Some(p) = t.tags.iter().position(|x| x == from) {
                if t.tags.iter().any(|x| x == to) {
                    t.tags.remove(p);
                } else {
                    t.tags[p] = to.to_owned();
                }
            }
        }
        let color = tag_rgb(&self.tag_colors, from);
        let now = self.now_stamp();
        self.tag_colors.remove(from);
        self.tag_stamps.insert(from.to_owned(), now);
        self.tag_colors.entry(to.to_owned()).or_insert(color);
        self.tag_stamps.insert(to.to_owned(), now);
        self.dirty = true;
    }

    pub fn delete_tag(&mut self, tag: &str) {
        let now = self.now_stamp();
        self.tasks.iter_mut().for_each(|t| t.tags.retain(|x| x != tag));
        self.tag_colors.remove(tag);
        self.tag_stamps.insert(tag.to_owned(), now);
        self.dirty = true;
    }

    fn path() -> PathBuf {
        data_dir().join("tasks.json")
    }

    /// Data da última gravação do arquivo de tarefas.
    pub fn modified() -> Option<std::time::SystemTime> {
        std::fs::metadata(Self::path()).and_then(|m| m.modified()).ok()
    }

    pub fn load() -> Self {
        let path = Self::path();
        let Ok(text) = std::fs::read_to_string(&path) else { return Self::default() };
        let mut store: Self = serde_json::from_str(&text).unwrap_or_else(|_| {
            // Arquivo ilegível: guarda uma cópia antes que a próxima gravação o substitua por uma lista vazia.
            let stamp = Local::now().format("%Y%m%d_%H%M%S");
            let _ = std::fs::copy(&path, path.with_file_name(format!("tasks_ilegivel_{stamp}.json")));
            Self::default()
        });
        store.migrate();
        store
    }

    pub fn save(&mut self) {
        self.stamp_changes();
        self.dirty = false;
        let path = Self::path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    /// Quantas tarefas de dias anteriores seguem pendentes (as que também caem hoje já estão na lista de hoje).
    pub fn pending_before(&self, today: NaiveDate) -> usize {
        self.tasks.iter().filter(|t| !t.done && t.date.is_some_and(|d| d < today) && !t.occurs_on(today)).count()
    }

    /// Títulos das tarefas pendentes de hoje, em ordem de horário.
    pub fn today_titles(&self, today: NaiveDate) -> Vec<String> {
        let mut v: Vec<&Task> = self.tasks.iter().filter(|t| !t.done && t.occurs_on(today)).collect();
        v.sort_by_key(|t| t.time);
        v.iter()
            .map(|t| match t.time {
                Some(h) => format!("{}  {}", h.format("%H:%M"), t.title),
                None => t.title.clone(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rent() -> Task {
        let mut s = Store::default();
        let id = s.add("Aluguel".into(), NaiveDate::from_ymd_opt(2026, 1, 30));
        let mut t = s.tasks.remove(s.tasks.iter().position(|t| t.id == id).unwrap());
        t.repeat = Repeat::Monthly;
        t.set_anchor();
        t
    }

    #[test]
    fn mensal_no_dia_30() {
        let t = rent();
        assert!(t.occurs_on(NaiveDate::from_ymd_opt(2026, 3, 30).unwrap()));
        assert!(t.occurs_on(NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()));
        assert!(!t.occurs_on(NaiveDate::from_ymd_opt(2026, 3, 29).unwrap()));
        assert!(!t.occurs_on(NaiveDate::from_ymd_opt(2025, 12, 30).unwrap()));
    }

    #[test]
    fn repeticao_finita_de_3_meses() {
        let mut t = rent();
        t.date = NaiveDate::from_ymd_opt(2026, 1, 5);
        t.set_anchor();
        t.repeat_times = Some(3);
        let d = |m, day| NaiveDate::from_ymd_opt(2026, m, day).unwrap();
        assert!(t.occurs_on(d(1, 5)) && t.occurs_on(d(2, 5)) && t.occurs_on(d(3, 5)));
        assert!(!t.occurs_on(d(4, 5)) && !t.occurs_on(d(5, 5)));
        t.repeat_times = None;
        assert!(t.occurs_on(d(4, 5)));
    }

    #[test]
    fn ultima_ocorrencia_conclui_de_vez() {
        let mut t = rent();
        t.date = Some(Local::now().date_naive());
        t.repeat = Repeat::Daily;
        t.repeat_times = Some(2);
        t.done = true;
        assert!(t.roll_over()); // sobra uma ocorrência
        assert_eq!(t.repeat_times, Some(1));
        assert!(!t.done);
        t.done = true;
        assert!(!t.roll_over()); // era a última
        assert!(t.done);
    }

    #[test]
    fn ordem_manual_e_por_hora() {
        let mut s = Store::default();
        let ids: Vec<u64> = ["a", "b", "c"].iter().map(|t| s.add((*t).into(), None)).collect();
        s.tasks[0].time = NaiveTime::from_hms_opt(15, 0, 0);
        s.tasks[2].time = NaiveTime::from_hms_opt(9, 0, 0);
        let titles = |s: &Store| s.tasks.iter().map(|t| t.title.clone()).collect::<Vec<_>>();
        s.sort_by_time(false);
        assert_eq!(titles(&s), ["c", "a", "b"]); // sem hora vai para o fim
        s.sort_by_time(true);
        assert_eq!(titles(&s), ["a", "c", "b"]);
        s.move_task(ids[1], ids[0]); // "b" sobe para a posição de "a"
        assert_eq!(titles(&s), ["b", "a", "c"]);
        s.move_task(ids[1], ids[2]); // e desce para a de "c"
        assert_eq!(titles(&s), ["a", "c", "b"]);
    }

    #[test]
    fn lista_de_hoje_poe_atrasadas_primeiro_e_ordena_por_hora() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 10).unwrap();
        let now = today.and_hms_opt(12, 0, 0).unwrap();
        let mut s = Store::default();
        let ids: Vec<u64> = ["sem hora", "tarde", "cedo", "ontem", "feita", "amanhã"].iter().map(|t| s.add((*t).into(), Some(today))).collect();
        s.tasks[1].time = NaiveTime::from_hms_opt(18, 0, 0);
        s.tasks[2].time = NaiveTime::from_hms_opt(13, 0, 0);
        s.tasks[3].date = NaiveDate::from_ymd_opt(2026, 5, 9);
        s.tasks[4].done = true;
        s.tasks[5].date = NaiveDate::from_ymd_opt(2026, 5, 11);
        let titles: Vec<&str> = s.today_pending(today, now).into_iter().map(|i| s.tasks[i].title.as_str()).collect();
        assert_eq!(titles, ["ontem", "cedo", "tarde", "sem hora"]);
        let _ = ids;
    }

    #[test]
    fn widget_migra_do_formato_antigo_e_limita_a_opacidade() {
        let mut s: Settings = serde_json::from_str("{\"widget_small\": true}").unwrap();
        s.normalize();
        assert_eq!(s.widget_format, Some(WidgetFormat::Pequeno));
        let mut s: Settings = serde_json::from_str("{}").unwrap();
        s.normalize();
        assert_eq!(s.widget_prefs(), WidgetPrefs { format: WidgetFormat::Medio, locked: false, opacity: 1.0 });
        // Uma escolha nova vale mais que o campo antigo, e a opacidade fica entre 30% e 100%.
        let mut s: Settings = serde_json::from_str("{\"widget_small\": true, \"widget_format\": \"Grande\", \"widget_opacity\": 0.05}").unwrap();
        s.normalize();
        assert_eq!(s.widget_format, Some(WidgetFormat::Grande));
        assert!((s.widget_opacity - 0.3).abs() < 1e-6);
        s.widget_opacity = f32::NAN;
        s.normalize();
        assert_eq!(s.widget_opacity, 1.0);
        // Gravar e ler de volta mantém a escolha.
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.widget_format, Some(WidgetFormat::Grande));
    }

    #[test]
    fn widget_sempre_abre_destrancado_e_lembra_do_ultimo_lugar() {
        // Arquivo das versões 0.9.7 a 0.9.9, que gravavam a trava: ela é ignorada e o resto continua valendo.
        let mut s: Settings = serde_json::from_str("{\"widget_locked\": true, \"widget_opacity\": 0.6}").unwrap();
        s.normalize();
        assert!(!s.widget_prefs().locked);
        assert!((s.widget_opacity - 0.6).abs() < 1e-6);
        assert_eq!(s.widget_place, None);
        // O último lugar volta igual, inclusive com coordenadas negativas (monitor à esquerda).
        let place = WidgetPlace { x: -1700, y: 40, w: 340.0, h: 190.0, format: WidgetFormat::Medio };
        s.widget_place = Some(place);
        s.set_widget_prefs(WidgetPrefs { locked: true, ..s.widget_prefs() });
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("widget_locked"), "a trava não é gravada");
        let mut back: Settings = serde_json::from_str(&json).unwrap();
        back.normalize();
        assert_eq!(back.widget_place, Some(place));
        assert!(!back.widget_prefs().locked);
        // Tamanho estragado no arquivo: sem lugar, em vez de uma janela de tamanho zero.
        let mut bad: Settings = serde_json::from_str("{\"widget_place\": {\"x\": 5, \"y\": 5, \"w\": 0.0, \"h\": 190.0, \"format\": \"Medio\"}}").unwrap();
        bad.normalize();
        assert_eq!(bad.widget_place, None);
    }

    #[test]
    fn gravar_carimba_so_o_que_mudou_e_guarda_as_exclusoes() {
        let mut s = Store::default();
        let a = s.add("A".into(), None);
        let b = s.add("B".into(), None);
        assert_ne!(s.tasks[0].uid, s.tasks[1].uid, "identidades diferentes");
        assert_eq!(s.tasks[0].stamps, Stamps::default(), "o carimbo só vem na gravação");
        s.stamp_changes();
        let first = s.tasks[0].stamps;
        assert!(first.title > 0 && first.latest() == first.title, "tarefa nova: todos os grupos carimbados juntos");
        assert_eq!(s.deleted.len(), 0);

        // Muda só o título de A: só o grupo do título ganha carimbo novo.
        s.tasks[0].title = "A2".into();
        s.stamp_changes();
        let second = s.tasks[0].stamps;
        assert!(second.title > first.title);
        assert_eq!((second.notes, second.state, second.tags), (first.notes, first.state, first.tags));
        assert_eq!(s.tasks[1].stamps, first, "B não mudou, não é carimbada");

        // Excluir B deixa uma lápide; desfazer a tira.
        let copy = s.tasks[1].clone();
        s.remove(b);
        s.stamp_changes();
        assert_eq!(s.deleted.len(), 1);
        assert_eq!(s.deleted[0].uid, copy.uid);
        assert!(s.deleted[0].at >= second.title);
        s.restore(copy, 1);
        s.stamp_changes();
        assert!(s.deleted.is_empty(), "a tarefa voltou: a lápide some");
        let _ = a;
    }

    #[test]
    fn relogio_de_sincronizacao_nunca_volta() {
        let mut s = Store::default();
        s.clock = 9_000_000_000_000; // muito à frente do relógio real
        let a = s.now_stamp();
        let b = s.now_stamp();
        assert_eq!((a, b), (9_000_000_000_001, 9_000_000_000_002));
        s.bump_clock(1);
        assert_eq!(s.clock, b, "um carimbo menor não o puxa para trás");
    }

    #[test]
    fn restaurar_backup_recarimba_tudo_para_vencer_o_arquivo() {
        // Furo 8 da auditoria: sem isto, a sincronização desfaz a restauração com o que o arquivo tem de mais novo.
        let mut s = Store::default();
        s.add("Antiga".into(), None);
        s.set_tag_color("casa", [1, 2, 3]);
        s.save();
        let old = s.tasks[0].stamps.latest();
        let uid = s.tasks[0].uid.clone();
        s.restamp_all(old + 1_000_000);
        let fresh = s.tasks[0].stamps.latest();
        assert!(fresh > old + 1_000_000, "à frente do relógio de antes da restauração");
        assert!(Group::ALL.iter().all(|g| s.tasks[0].stamps.get(*g) == fresh), "todos os grupos");
        assert_eq!(s.tag_stamps["casa"], fresh);
        s.save();
        assert_eq!(s.tasks[0].stamps.latest(), fresh, "gravar depois não recarimba");
        // O arquivo tinha excluído e renomeado a tarefa depois do backup: a restaurada vence os dois.
        let mut gone = crate::sync::SyncTask { uid: uid.clone(), title: "Renomeada".into(), ..Default::default() };
        gone.stamps.set(Group::Title, old + 600_000);
        let remote = crate::sync::SyncFile {
            schema: crate::sync::SCHEMA,
            tasks: vec![gone],
            deleted: vec![Tombstone { uid: uid.clone(), at: old + 500_000 }],
            ..Default::default()
        };
        let out = crate::sync::merge(&mut s, Some(&remote), "t", Utc::now().timestamp_millis());
        assert_eq!(s.tasks.len(), 1);
        assert_eq!(s.tasks[0].title, "Antiga");
        assert!(out.file.deleted.is_empty());
    }

    /// Os mesmos vetores que o app web roda (`web/tests/vetores-recorrencia.json`): se uma ponta mudar a regra,
    /// a outra quebra aqui antes de divergirem nos aparelhos.
    #[test]
    fn recorrencia_segue_os_vetores_compartilhados_com_o_web() {
        let doc: serde_json::Value = serde_json::from_str(include_str!("../web/tests/vetores-recorrencia.json")).unwrap();
        let day = |v: &serde_json::Value| NaiveDate::parse_from_str(v.as_str().unwrap(), "%Y-%m-%d").unwrap();
        let task = |v: &serde_json::Value| -> Task {
            let sync: crate::sync::SyncTask = serde_json::from_value(v.clone()).unwrap();
            sync.to_task(1)
        };
        let items = |key: &str| doc[key].as_array().unwrap_or_else(|| panic!("seção {key} nos vetores")).iter();

        let mut n = 0;
        for case in items("ocorre_em") {
            let (name, t) = (case["nome"].as_str().unwrap(), task(&case["tarefa"]));
            for d in case["sim"].as_array().unwrap() {
                assert!(t.occurs_on(day(d)), "{name}: devia ocorrer em {d}");
            }
            for d in case["nao"].as_array().unwrap() {
                assert!(!t.occurs_on(day(d)), "{name}: não devia ocorrer em {d}");
            }
            n += 1;
        }
        for case in items("proxima_apos") {
            let (name, t) = (case["nome"].as_str().unwrap(), task(&case["tarefa"]));
            assert_eq!(t.next_after(day(&case["de"])), day(&case["para"]), "{name}");
            n += 1;
        }
        for case in items("reagendar") {
            let (name, hoje) = (case["nome"].as_str().unwrap(), day(&case["hoje"]));
            for passo in case["passos"].as_array().unwrap() {
                let mut t = task(&passo["tarefa"]);
                let did = t.roll_over_on(hoje);
                let e = &passo["esperado"];
                assert_eq!(did, e["reagendou"].as_bool().unwrap(), "{name}: reagendou");
                assert_eq!(t.date, Some(day(&e["date"])), "{name}: data");
                assert_eq!(t.done, e["done"].as_bool().unwrap(), "{name}: concluída");
                assert_eq!(t.repeat_times, e["repeat_times"].as_u64().map(|n| n as u32), "{name}: vezes restantes");
            }
            n += 1;
        }
        for case in items("atrasada") {
            let name = case["nome"].as_str().unwrap();
            let now = NaiveDateTime::parse_from_str(case["agora"].as_str().unwrap(), "%Y-%m-%dT%H:%M:%S").unwrap();
            assert_eq!(task(&case["tarefa"]).overdue(now), case["esperado"].as_bool().unwrap(), "{name}");
            n += 1;
        }
        assert!(n >= 20, "os vetores foram lidos ({n})");
    }

    #[test]
    fn desfazer_devolve_a_tarefa_ao_lugar() {
        let mut s = Store::default();
        let ids: Vec<u64> = ["a", "b", "c"].iter().map(|t| s.add((*t).into(), None)).collect();
        let copy = s.tasks[1].clone();
        s.remove(ids[1]);
        s.restore(copy.clone(), 1);
        assert_eq!(s.tasks[1].title, "b");
        s.tasks[1].done = true;
        s.restore(copy, 1); // já existe: só volta ao estado de antes
        assert!(!s.tasks[1].done);
        assert_eq!(s.tasks.len(), 3);
    }

    #[test]
    fn atrasada_so_se_pendente_e_no_passado() {
        let now = NaiveDate::from_ymd_opt(2026, 5, 10).unwrap().and_hms_opt(12, 0, 0).unwrap();
        let mut t = rent();
        t.date = NaiveDate::from_ymd_opt(2026, 5, 9);
        assert!(t.overdue(now));
        t.date = NaiveDate::from_ymd_opt(2026, 5, 10);
        assert!(!t.overdue(now)); // hoje sem hora ainda não atrasou
        t.time = NaiveTime::from_hms_opt(11, 0, 0);
        assert!(t.overdue(now));
        t.done = true;
        assert!(!t.overdue(now));
    }

    #[test]
    fn renomear_e_remover_tags() {
        let mut s = Store::default();
        let a = s.add("A".into(), None);
        let b = s.add("B".into(), None);
        s.tasks[0].tags = vec!["casa".into(), "casa2".into()];
        s.tasks[1].tags = vec!["casa".into()];
        s.set_tag_color("casa", [1, 2, 3]);
        s.rename_tag("casa", "lar");
        assert_eq!(s.tasks[0].tags, ["lar", "casa2"]);
        assert_eq!(s.tag_colors.get("lar"), Some(&[1, 2, 3]));
        assert!(!s.tag_colors.contains_key("casa"));
        // Renomear para um nome que já existe junta as duas, sem duplicar.
        s.rename_tag("casa2", "lar");
        assert_eq!(s.tasks[0].tags, ["lar"]);
        assert_eq!(s.tag_count("lar"), 2);
        s.delete_tag("lar");
        assert!(s.all_tags().is_empty());
        let _ = (a, b);
    }

    #[test]
    fn proxima_data_volta_ao_30() {
        let t = rent();
        let feb = t.next_after(NaiveDate::from_ymd_opt(2026, 1, 30).unwrap());
        assert_eq!(feb, NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert_eq!(t.next_after(feb), NaiveDate::from_ymd_opt(2026, 3, 30).unwrap());
    }
}

/// Formatos padrão do widget flutuante, do mais fino ao maior.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum WidgetFormat {
    /// Faixa fina: só o ícone do programa e o cronômetro.
    Barra,
    /// Faixa com o programa, o cronômetro e os botões.
    Pequeno,
    #[default]
    Medio,
    Grande,
}

impl WidgetFormat {
    pub const ALL: [WidgetFormat; 4] = [WidgetFormat::Barra, WidgetFormat::Pequeno, WidgetFormat::Medio, WidgetFormat::Grande];

    pub fn label(self) -> &'static str {
        match self {
            WidgetFormat::Barra => "Barra",
            WidgetFormat::Pequeno => "Pequeno",
            WidgetFormat::Medio => "Médio",
            WidgetFormat::Grande => "Grande",
        }
    }
}

/// Escolhas do widget: formato, trava e opacidade. Só o formato e a opacidade ficam gravados; a trava vale para
/// o widget aberto no momento (ele sempre abre destrancado, no último lugar, que fica em [`WidgetPlace`]).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct WidgetPrefs {
    pub format: WidgetFormat,
    /// Trancado: o widget não muda de posição nem de tamanho com o mouse (só com o botão do meio, que o move).
    pub locked: bool,
    /// De 0.3 (bem transparente) a 1.0 (opaco).
    pub opacity: f32,
}

/// Onde o widget ficou da última vez, trancado ou não: o canto superior esquerdo em pixels da tela (negativo num
/// monitor à esquerda ou acima do principal) e o tamanho em pontos. O tamanho vale só para o formato em que foi deixado.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct WidgetPlace {
    pub x: i32,
    pub y: i32,
    pub w: f32,
    pub h: f32,
    pub format: WidgetFormat,
}

/// Opacidade mínima do widget: abaixo disso ele some da tela e ninguém acha de novo.
pub const OPACITY_RANGE: std::ops::RangeInclusive<f32> = 0.3..=1.0;

/// Preferências do app (`settings.json`).
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Antigo: o botão de minimizar perguntava bandeja ou só minimizar. Agora minimizar vai sempre para a
    /// bandeja (com o widget aberto o Navi não fica na barra de tarefas); o campo só é lido de arquivos antigos.
    pub minimize_to_tray: Option<bool>,
    /// Escala da interface (1.0 = 100%).
    pub scale: f32,
    /// O aviso "continua na bandeja" já foi mostrado (só aparece na primeira vez).
    pub tray_notice_shown: bool,
    /// Antigo: o widget usava o formato pequeno. Só é lido de arquivos antigos, para migrar para `widget_format`.
    #[serde(skip_serializing)]
    pub widget_small: bool,
    /// Formato do widget; `None` em arquivos antigos (vale então o campo `widget_small`).
    pub widget_format: Option<WidgetFormat>,
    /// Opacidade do widget (0.3 a 1.0).
    pub widget_opacity: f32,
    /// Posição e tamanho do widget da última vez que a pessoa o moveu ou redimensionou; `None` enquanto ninguém o fez.
    pub widget_place: Option<WidgetPlace>,
    /// Pasta dos backups (normalmente sincronizada com a nuvem). `None` = backup desligado.
    pub backup_dir: Option<PathBuf>,
    /// Quando o último backup deu certo.
    pub last_backup: Option<NaiveDateTime>,
    /// Pasta da sincronização entre aparelhos (uma pasta de nuvem). `None` = desligada.
    pub sync_dir: Option<PathBuf>,
    /// Identidade deste aparelho no arquivo de sincronização (só informativa).
    pub device_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            minimize_to_tray: None,
            scale: 1.0,
            tray_notice_shown: false,
            widget_small: false,
            widget_format: None,
            widget_opacity: 1.0,
            widget_place: None,
            backup_dir: None,
            last_backup: None,
            sync_dir: None,
            device_id: String::new(),
        }
    }
}

pub const SCALE_RANGE: std::ops::RangeInclusive<f32> = 0.7..=2.0;

impl Settings {
    fn path() -> PathBuf {
        data_dir().join("settings.json")
    }

    /// Coloca os valores lidos do arquivo dentro do que o app aceita e migra o que veio de versões antigas.
    pub fn normalize(&mut self) {
        self.scale = if self.scale.is_finite() { self.scale.clamp(*SCALE_RANGE.start(), *SCALE_RANGE.end()) } else { 1.0 };
        self.widget_opacity =
            if self.widget_opacity.is_finite() { self.widget_opacity.clamp(*OPACITY_RANGE.start(), *OPACITY_RANGE.end()) } else { 1.0 };
        if self.widget_format.is_none() {
            self.widget_format = Some(if self.widget_small { WidgetFormat::Pequeno } else { WidgetFormat::Medio });
        }
        self.widget_small = false;
        // Um lugar com número estragado (arquivo editado à mão) vale como nenhum.
        self.widget_place = self.widget_place.filter(|p| p.w.is_finite() && p.h.is_finite() && p.w >= 1.0 && p.h >= 1.0);
    }

    /// As escolhas do widget. Ele sempre abre destrancado, venha o arquivo de onde vier (as versões 0.9.7 a 0.9.9
    /// gravavam `widget_locked`; o campo antigo é ignorado).
    pub fn widget_prefs(&self) -> WidgetPrefs {
        WidgetPrefs { format: self.widget_format.unwrap_or_default(), locked: false, opacity: self.widget_opacity }
    }

    pub fn set_widget_prefs(&mut self, prefs: WidgetPrefs) {
        self.widget_format = Some(prefs.format);
        self.widget_opacity = prefs.opacity;
    }

    pub fn load() -> Self {
        let mut s: Self =
            std::fs::read_to_string(Self::path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        s.normalize();
        if s.device_id.is_empty() {
            s.device_id = fresh_uid();
            s.save();
        }
        s
    }

    pub fn save(&self) {
        let _ = std::fs::create_dir_all(data_dir());
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(Self::path(), json);
        }
    }
}
