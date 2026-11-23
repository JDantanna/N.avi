//! Sincronização das tarefas entre aparelhos por um arquivo numa pasta de nuvem: o computador grava e lê
//! `N.avi.sync.json` numa pasta que o Google Drive ou o OneDrive sincronizam; o celular lê e grava o mesmo
//! arquivo pela API da nuvem. O formato, os carimbos e a regra de mesclagem estão em `docs/sincronizacao.md`;
//! os casos de teste em `docs/sync-casos/` valem para as duas implementações.
//!
//! A leitura e a gravação rodam em segundo plano (a unidade da nuvem pode demorar); a mesclagem roda na thread
//! da interface, sobre as tarefas como estão agora, para nunca gravar por cima do que a pessoa acabou de digitar.

use std::collections::{BTreeMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::model::{Group, Repeat, Stamps, Store, Subtask, Task, Tombstone};

/// Versão do formato do arquivo. Quem lê um `schema` maior não grava nada.
pub const SCHEMA: u32 = 1;
pub const FILE_NAME: &str = "N.avi.sync.json";
const FILE_STEM: &str = "N.avi.sync";
const CORRUPT_MARK: &str = ".corrompido-";
/// Subpasta para onde vão as cópias de conflito depois de mescladas.
pub const CONFLICTS_DIR: &str = "conflitos";
/// Quanto tempo uma exclusão fica lembrada no arquivo.
const TOMBSTONE_MS: i64 = 90 * 24 * 3600 * 1000;
/// De quanto em quanto tempo o arquivo é relido.
pub const CHECK_SECS: f64 = 20.0;
/// Espera depois de abrir o app: a unidade da nuvem pode ainda estar montando.
const FIRST_CHECK_SECS: f64 = 15.0;
/// Um arquivo ilegível é relido este tanto de vezes, com este intervalo, antes de ser dado como corrompido: na
/// maioria das vezes é um download do cliente da nuvem ainda pela metade.
const BAD_READS: u8 = 3;
const RETRY_SECS: f64 = 3.0;

fn one() -> u32 {
    1
}

/// Uma tarefa como vai no arquivo: igual à do app, menos o id numérico (que vale só na máquina).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct SyncTask {
    pub uid: String,
    pub title: String,
    pub notes: String,
    pub done: bool,
    pub subtasks: Vec<Subtask>,
    pub date: Option<NaiveDate>,
    pub time: Option<NaiveTime>,
    pub notify: Option<u32>,
    pub notify_day_before: bool,
    pub tags: Vec<String>,
    pub color: [u8; 3],
    pub repeat: Repeat,
    #[serde(default = "one")]
    pub every: u32,
    pub anchor_day: u32,
    pub repeat_times: Option<u32>,
    pub stamps: Stamps,
}

impl SyncTask {
    pub fn from_task(t: &Task) -> Self {
        Self {
            uid: t.uid.clone(),
            title: t.title.clone(),
            notes: t.notes.clone(),
            done: t.done,
            subtasks: t.subtasks.clone(),
            date: t.date,
            time: t.time,
            notify: t.notify,
            notify_day_before: t.notify_day_before,
            tags: t.tags.clone(),
            color: t.color,
            repeat: t.repeat,
            every: t.every,
            anchor_day: t.anchor_day,
            repeat_times: t.repeat_times,
            stamps: t.stamps,
        }
    }

    pub fn to_task(&self, id: u64) -> Task {
        Task {
            id,
            uid: self.uid.clone(),
            stamps: self.stamps,
            title: self.title.clone(),
            notes: self.notes.clone(),
            done: self.done,
            subtasks: self.subtasks.clone(),
            date: self.date,
            time: self.time,
            notify: self.notify,
            notify_day_before: self.notify_day_before,
            tags: self.tags.clone(),
            color: self.color,
            repeat: self.repeat,
            every: self.every,
            anchor_day: self.anchor_day,
            repeat_times: self.repeat_times,
        }
    }
}

/// Cor de uma tag no arquivo; `None` é uma cor removida (a remoção também precisa chegar aos outros aparelhos).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct TagEntry {
    pub color: Option<[u8; 3]>,
    pub at: i64,
}

/// O arquivo inteiro.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct SyncFile {
    pub schema: u32,
    pub app: String,
    /// Aparelho que gravou por último (só informativo).
    pub written_by: String,
    pub written_at: i64,
    /// Maior carimbo já dado ou visto por quem gravou.
    pub clock: i64,
    pub tasks: Vec<SyncTask>,
    pub deleted: Vec<Tombstone>,
    pub tags: BTreeMap<String, TagEntry>,
}

impl SyncFile {
    /// O arquivo que representa o estado de `store`.
    pub fn from_store(store: &Store, device: &str) -> Self {
        let mut tags: BTreeMap<String, TagEntry> = BTreeMap::new();
        for (name, color) in &store.tag_colors {
            tags.insert(name.clone(), TagEntry { color: Some(*color), at: store.tag_stamps.get(name).copied().unwrap_or(0) });
        }
        for (name, at) in &store.tag_stamps {
            tags.entry(name.clone()).or_insert(TagEntry { color: None, at: *at });
        }
        Self {
            schema: SCHEMA,
            app: brand::NAME.to_owned(),
            written_by: device.to_owned(),
            written_at: store.clock,
            clock: store.clock,
            tasks: store.tasks.iter().map(SyncTask::from_task).collect(),
            deleted: store.deleted.clone(),
            tags,
        }
    }

    /// O mesmo conteúdo que `other`, fora o cabeçalho (quem gravou, quando)? A ordem das tarefas não conta.
    pub fn same_content(&self, other: &Self) -> bool {
        let sorted = |f: &Self| {
            let mut tasks = f.tasks.clone();
            tasks.sort_by(|a, b| a.uid.cmp(&b.uid));
            let mut deleted = f.deleted.clone();
            deleted.sort_by(|a, b| a.uid.cmp(&b.uid));
            (tasks, deleted)
        };
        sorted(self) == sorted(other) && self.tags == other.tags
    }

    /// O relógio local nunca fica atrás de nada que o arquivo traz.
    fn bump(&self, store: &mut Store) {
        store.bump_clock(self.clock);
        for t in &self.tasks {
            store.bump_clock(t.stamps.latest());
        }
        for d in &self.deleted {
            store.bump_clock(d.at);
        }
        for e in self.tags.values() {
            store.bump_clock(e.at);
        }
    }
}

pub struct MergeOutcome {
    /// As tarefas, lápides ou tags locais mudaram: é preciso gravar e mostrar.
    pub changed_local: bool,
    /// O arquivo mesclado difere do que foi lido: é preciso regravá-lo.
    pub changed_file: bool,
    pub file: SyncFile,
}

/// Mescla o arquivo lido (`None` se ele não existe) com as tarefas locais, dentro de `store`, e devolve o arquivo
/// a gravar. Determinística: dois aparelhos que mesclem os mesmos dados, em qualquer ordem, chegam ao mesmo lugar.
/// `now_wall` é o relógio de parede em ms, usado só para podar lápides velhas (nunca o relógio híbrido, que
/// pode estar adiantado por causa de um aparelho com a hora errada).
pub fn merge(store: &mut Store, remote: Option<&SyncFile>, device: &str, now_wall: i64) -> MergeOutcome {
    let mut changed_local = false;
    if let Some(r) = remote {
        r.bump(store);
        // Carimbo para os grupos que precisarem ser combinados (os dois lados mudaram): novo, à frente de tudo o
        // que já se viu, para o resultado combinado vencer as duas versões em qualquer aparelho.
        let fresh = now_wall.max(store.clock + 1);
        let mut used_fresh = false;

        for rt in &r.tasks {
            // Exclusão local depois da última edição remota: continua excluída (a lápide vai no arquivo).
            let local_tomb = store.deleted.iter().find(|d| d.uid == rt.uid).map(|d| d.at);
            if local_tomb.is_some_and(|at| at >= rt.stamps.latest()) {
                continue;
            }
            if local_tomb.is_some() {
                // Edição remota depois da exclusão local: a tarefa volta.
                store.deleted.retain(|d| d.uid != rt.uid);
                changed_local = true;
            }
            match store.find_uid(&rt.uid) {
                Some(i) => {
                    let base = store.reference(&rt.uid).cloned();
                    let local = &mut store.tasks[i];
                    let incoming = rt.to_task(local.id);
                    for g in Group::ALL {
                        let (ls, rs) = (local.stamps.get(g), incoming.stamps.get(g));
                        if local.group_eq(&incoming, g) {
                            // O mesmo valor nos dois lados nunca é conflito; só o carimbo converge para o maior.
                            if rs > ls {
                                local.stamps.set(g, rs);
                                changed_local = true;
                            }
                            continue;
                        }
                        // Os dois lados mudaram o mesmo grupo desde a última mesclagem que este aparelho conhece:
                        // informações, checklist e tags são combinados em vez de escolher um lado.
                        let both_changed = base.as_ref().is_some_and(|b| !b.group_eq(local, g) && !b.group_eq(&incoming, g));
                        if both_changed && combine(local, &incoming, g) {
                            local.stamps.set(g, fresh);
                            used_fresh = true;
                            changed_local = true;
                            continue;
                        }
                        let newer = rs > ls;
                        // Empate exato com conteúdo diferente: decide pelo texto, igual nos dois lados.
                        let tie = rs == ls && incoming.group_key(g) > local.group_key(g);
                        if newer || tie {
                            local.copy_group(&incoming, g);
                            changed_local = true;
                        }
                    }
                }
                None => {
                    store.adopt(rt.to_task(0));
                    changed_local = true;
                }
            }
        }

        for d in &r.deleted {
            if let Some(i) = store.find_uid(&d.uid) {
                if store.tasks[i].stamps.latest() > d.at {
                    // Editada aqui depois da exclusão lá: sobrevive, e a lápide remota cai.
                    continue;
                }
                store.remove_uid(&d.uid);
                changed_local = true;
            }
            if !store.deleted.iter().any(|x| x.uid == d.uid) {
                store.deleted.push(d.clone());
                changed_local = true;
            }
        }

        for (name, e) in &r.tags {
            let ls = store.tag_stamps.get(name).copied().unwrap_or(0);
            if e.at > ls {
                match e.color {
                    Some(c) => {
                        store.tag_colors.insert(name.clone(), c);
                    }
                    None => {
                        store.tag_colors.remove(name);
                    }
                }
                store.tag_stamps.insert(name.clone(), e.at);
                changed_local = true;
            }
        }
        if used_fresh {
            store.bump_clock(fresh);
        }
    }

    // Lápides velhas saem, pelo relógio de parede: uma lápide "do futuro" (aparelho com a hora adiantada) fica.
    let horizon = now_wall - TOMBSTONE_MS;
    let before = store.deleted.len();
    store.deleted.retain(|d| d.at >= horizon);
    changed_local |= store.deleted.len() != before;

    let file = SyncFile::from_store(store, device);
    let changed_file = remote.is_none_or(|r| !r.same_content(&file));
    MergeOutcome { changed_local, changed_file, file }
}

/// Separador entre o texto que venceu e o do outro aparelho, quando os dois editaram as informações.
pub const OTHER_VERSION_MARK: &str = "--- versão de outro aparelho ---";

/// Combina um grupo que os dois lados mudaram, sem perder nada de nenhum: tags em união, checklist em união por
/// item (concluído se qualquer lado concluiu), informações com o texto vencedor (carimbo maior; empate pelo texto)
/// e o perdedor no fim, depois de um separador. Os outros grupos não se combinam (devolve `false`).
pub fn combine(local: &mut Task, incoming: &Task, g: Group) -> bool {
    match g {
        Group::Tags => {
            for t in &incoming.tags {
                if !local.tags.contains(t) {
                    local.tags.push(t.clone());
                }
            }
            true
        }
        Group::Subtasks => {
            for s in &incoming.subtasks {
                match local.subtasks.iter_mut().find(|l| l.title == s.title) {
                    Some(l) => l.done |= s.done,
                    None => local.subtasks.push(s.clone()),
                }
            }
            true
        }
        Group::Notes => {
            let (ls, rs) = (local.stamps.get(g), incoming.stamps.get(g));
            let local_wins = ls > rs || (ls == rs && local.group_key(g) >= incoming.group_key(g));
            let (winner, loser) = if local_wins { (&local.notes, &incoming.notes) } else { (&incoming.notes, &local.notes) };
            // Um dos lados apagou o texto: fica o que sobrou, sem separador. Um lado já contém o outro (uma
            // combinação anterior, por exemplo): fica o maior, sem acrescentar de novo.
            let (w, l) = (winner.trim(), loser.trim());
            local.notes = if l.is_empty() || w.contains(l) {
                winner.clone()
            } else if w.is_empty() || l.contains(w) {
                loser.clone()
            } else {
                format!("{}\n\n{OTHER_VERSION_MARK}\n{l}", winner.trim_end())
            };
            true
        }
        _ => false,
    }
}

/// Primeira mesclagem com um arquivo que já existe: uma tarefa daqui sem par no arquivo e uma do arquivo sem par
/// aqui, **iguais em todos os grupos**, são a mesma tarefa que ganhou `uid`s diferentes (um computador migrado
/// de uma versão sem sincronização, um backup antigo restaurado). A daqui assume o `uid` e os carimbos da do
/// arquivo. Se algo difere (informações só daqui, checklist, tags...), as duas ficam: uma duplicata visível, que
/// a pessoa apaga, em vez de perder conteúdo em silêncio.
pub fn adopt_matches(store: &mut Store, remote: &SyncFile) -> bool {
    let remote_uids: HashSet<&str> = remote.tasks.iter().map(|t| t.uid.as_str()).collect();
    let mut changed = false;
    for rt in &remote.tasks {
        if store.find_uid(&rt.uid).is_some() {
            continue;
        }
        let incoming = rt.to_task(0);
        let found = store.tasks.iter().position(|lt| !remote_uids.contains(lt.uid.as_str()) && Group::ALL.iter().all(|g| lt.group_eq(&incoming, *g)));
        if let Some(i) = found {
            store.tasks[i].uid = rt.uid.clone();
            store.tasks[i].stamps = rt.stamps;
            changed = true;
        }
    }
    if changed {
        store.dirty = true;
    }
    changed
}

/// Pasta sugerida para a sincronização em cada nuvem: no OneDrive (e no Dropbox) a pasta de apps, que o celular
/// alcança como "pasta do app"; no Google Drive uma pasta `N.avi` na raiz, que o celular abre pelo seletor.
pub fn suggested_folder(cloud: &str, root: &Path) -> PathBuf {
    match cloud {
        "OneDrive" | "Dropbox" => root.join("Apps").join(brand::NAME),
        _ => root.join(brand::NAME),
    }
}

/// Grava `bytes` no próprio arquivo, sem trocá-lo por outro: no Google Drive um arquivo substituído por
/// renomeação vira outro arquivo (outro id), e o celular, que guarda o id, ficaria preso ao antigo. A gravação
/// é conferida lendo de volta; três tentativas. Um leitor que apanhe o arquivo no meio da gravação vê um JSON
/// pela metade, e por isso toda leitura ilegível é repetida antes de valer (ver `BAD_READS`).
pub fn write_same_file(path: &Path, bytes: &[u8]) -> Result<(), WriteFail> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| WriteFail::Io(format!("Não foi possível criar a pasta de sincronização: {e}")))?;
    }
    let mut last_err = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        let written = (|| -> std::io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
            f.write_all(bytes)?;
            f.sync_all()
        })();
        match written {
            Err(e) => last_err = format!("Não foi possível gravar na pasta de sincronização: {e}"),
            Ok(()) => match std::fs::read(path) {
                Ok(back) if back == bytes => return Ok(()),
                // Outro conteúdo no lugar do nosso: o cliente da nuvem trouxe a versão de outro aparelho entre a
                // gravação e a conferência. Não se grava por cima do que não foi lido: quem chamou relê e mescla.
                Ok(_) => return Err(WriteFail::Changed),
                Err(e) => last_err = format!("Não foi possível conferir a gravação: {e}"),
            },
        }
    }
    Err(WriteFail::Io(last_err))
}

/// Por que uma gravação não valeu.
#[derive(Debug, PartialEq)]
pub enum WriteFail {
    Io(String),
    /// O arquivo já tinha outro conteúdo ao conferir: é preciso reler e mesclar.
    Changed,
}

/// Guarda uma cópia de um arquivo ilegível, com a data no nome, e devolve o nome da cópia. Copia em vez de
/// renomear: renomear levaria junto a identidade do arquivo na nuvem, e o celular passaria a gravar na cópia.
fn quarantine_copy(path: &Path) -> Result<String, String> {
    let name = format!("{FILE_STEM}{CORRUPT_MARK}{}.json", Local::now().format("%Y%m%d-%H%M%S"));
    std::fs::copy(path, path.with_file_name(&name)).map(|_| name).map_err(|e| e.to_string())
}

/// Aproveita o que der de um arquivo ilegível (quase sempre um JSON truncado): as tarefas, lápides e tags que
/// ainda se leem inteiras. Mesclar isso só acrescenta ou atualiza; nada local some por causa de um arquivo ruim.
fn salvage(bytes: &[u8]) -> Option<SyncFile> {
    let text = String::from_utf8_lossy(bytes);
    let mut file = SyncFile { schema: SCHEMA, ..Default::default() };
    let mut any = false;
    for item in array_items(&text, "\"tasks\"") {
        match serde_json::from_str::<SyncTask>(item) {
            Ok(t) if !t.uid.is_empty() => {
                file.tasks.push(t);
                any = true;
            }
            _ => break,
        }
    }
    for item in array_items(&text, "\"deleted\"") {
        match serde_json::from_str::<Tombstone>(item) {
            Ok(d) => {
                file.deleted.push(d);
                any = true;
            }
            Err(_) => break,
        }
    }
    if let Some(obj) = object_after(&text, "\"tags\"")
        && let Ok(tags) = serde_json::from_str::<BTreeMap<String, TagEntry>>(obj)
    {
        any |= !tags.is_empty();
        file.tags = tags;
    }
    any.then_some(file)
}

/// Os objetos `{...}` inteiros do array que vem depois de `key` no texto (para no primeiro incompleto).
fn array_items<'a>(text: &'a str, key: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let Some(k) = text.find(key) else { return out };
    let Some(open) = text[k..].find('[') else { return out };
    let mut i = k + open + 1;
    loop {
        while let Some(c) = text[i..].chars().next() {
            if c.is_whitespace() || c == ',' {
                i += c.len_utf8();
            } else {
                break;
            }
        }
        if !text[i..].starts_with('{') {
            break;
        }
        let Some(end) = balanced_end(text, i) else { break };
        out.push(&text[i..end]);
        i = end;
    }
    out
}

/// O objeto `{...}` inteiro que vem depois de `key` no texto, se estiver completo.
fn object_after<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let k = text.find(key)?;
    let open = k + text[k..].find('{')?;
    let end = balanced_end(text, open)?;
    Some(&text[open..end])
}

/// Índice logo depois do `}` que fecha o objeto aberto em `start`, respeitando textos entre aspas.
fn balanced_end(text: &str, start: usize) -> Option<usize> {
    let (mut depth, mut in_str, mut esc) = (0usize, false, false);
    for (i, &b) in text.as_bytes().iter().enumerate().skip(start) {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// Uma cópia de conflito criada pela nuvem ao lado do arquivo: "N.avi.sync (1).json" (Google Drive),
/// "N.avi.sync-NOMEDOPC.json" (OneDrive), "N.avi.sync (conflicted copy ...).json" (Dropbox).
fn is_conflict_copy(name: &str) -> bool {
    name != FILE_NAME && name.starts_with(FILE_STEM) && name.ends_with(".json") && !name.contains(CORRUPT_MARK)
}

/// Leva uma cópia de conflito já mesclada para a subpasta `conflitos/`, sem apagar nada.
fn shelve(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return };
    let target_dir = dir.join(CONFLICTS_DIR);
    if std::fs::create_dir_all(&target_dir).is_err() {
        return;
    }
    let mut target = target_dir.join(name);
    if target.exists() {
        target = target_dir.join(format!("{}-{}", Local::now().format("%Y%m%d-%H%M%S"), name.to_string_lossy()));
    }
    let _ = std::fs::rename(path, target);
}

/// O que a janela mostra sobre a sincronização.
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Off,
    Working,
    Ok(NaiveDateTime),
    Error(String),
}

struct Read {
    /// `None`: o arquivo (ou a pasta) ainda não existe.
    bytes: Option<Vec<u8>>,
    /// Cópias de conflito encontradas ao lado, com o conteúdo, em ordem de nome.
    copies: Vec<(PathBuf, Vec<u8>)>,
}

fn read_folder(dir: &Path) -> Result<Read, String> {
    let bytes = match std::fs::read(dir.join(FILE_NAME)) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Não foi possível ler a pasta de sincronização: {e}")),
    };
    let mut copies = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_conflict_copy(&name)
                && let Ok(b) = std::fs::read(entry.path())
            {
                copies.push((entry.path(), b));
            }
        }
    }
    copies.sort();
    Ok(Read { bytes, copies })
}

fn parse(bytes: &[u8]) -> Result<SyncFile, serde_json::Error> {
    serde_json::from_slice::<SyncFile>(bytes)
}

/// A sincronização em andamento: lê e grava em segundo plano (a unidade da nuvem pode demorar) e mescla na
/// thread da interface, onde as tarefas estão.
pub struct Sync {
    reading: Option<Receiver<Result<Read, String>>>,
    writing: Option<Receiver<Result<(), WriteFail>>>,
    /// Instante, no relógio da interface, da próxima leitura.
    next_check: f64,
    /// Há mudanças locais gravadas que ainda não foram para o arquivo.
    pending: bool,
    /// Hash do conteúdo do arquivo já mesclado ou gravado por aqui: igual, não há o que mesclar.
    seen: Option<u64>,
    /// Leituras ilegíveis seguidas do mesmo conteúdo (download pela metade ou arquivo corrompido de vez).
    bad_reads: u8,
    bad_hash: Option<u64>,
    last_ok: Option<NaiveDateTime>,
    error: Option<String>,
    /// Aviso que fica até a próxima leitura boa (arquivo ilegível posto de lado).
    notice: Option<String>,
}

impl Sync {
    pub fn new() -> Self {
        Self {
            reading: None,
            writing: None,
            next_check: FIRST_CHECK_SECS,
            pending: false,
            seen: None,
            bad_reads: 0,
            bad_hash: None,
            last_ok: None,
            error: None,
            notice: None,
        }
    }

    /// As tarefas locais acabaram de ser gravadas: o arquivo precisa delas.
    pub fn mark_pending(&mut self) {
        self.pending = true;
    }

    /// Lê e grava já, sem esperar a próxima conferência (a pessoa escolheu a pasta agora).
    pub fn kick(&mut self) {
        self.pending = true;
        self.next_check = 0.0;
        self.seen = None;
        self.bad_reads = 0;
        self.error = None;
        self.notice = None;
    }

    pub fn status(&self, on: bool) -> Status {
        if !on {
            return Status::Off;
        }
        if let Some(e) = self.error.clone().or_else(|| self.notice.clone()) {
            return Status::Error(e);
        }
        if self.reading.is_some() || self.writing.is_some() {
            return Status::Working;
        }
        match self.last_ok {
            Some(at) => Status::Ok(at),
            None => Status::Working,
        }
    }

    /// Quanto falta para a próxima conferência; com trabalho em andamento, logo.
    pub fn until_check(&self, time: f64) -> std::time::Duration {
        if self.reading.is_some() || self.writing.is_some() {
            return std::time::Duration::from_millis(250);
        }
        std::time::Duration::from_secs_f64((self.next_check - time).max(0.5))
    }

    /// Um passo, a cada quadro. Devolve `true` se as tarefas locais mudaram por causa de outro aparelho.
    pub fn tick(&mut self, store: &mut Store, dir: Option<&Path>, device: &str, time: f64) -> bool {
        let Some(dir) = dir else {
            self.reading = None;
            self.writing = None;
            self.pending = false;
            return false;
        };
        let mut changed = false;
        if let Some(rx) = &self.writing {
            match rx.try_recv() {
                Ok(Ok(())) => {
                    self.writing = None;
                    self.last_ok = Some(Local::now().naive_local());
                    self.error = None;
                }
                Ok(Err(WriteFail::Changed)) => {
                    // Outro aparelho gravou no meio: lê de novo já e mescla, em vez de gravar por cima.
                    self.writing = None;
                    self.pending = true;
                    self.seen = None;
                    self.next_check = time;
                }
                Ok(Err(WriteFail::Io(e))) => {
                    self.writing = None;
                    self.error = Some(e);
                    // A mudança local continua devendo ao arquivo.
                    self.pending = true;
                    self.seen = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => self.writing = None,
            }
        }
        if let Some(rx) = &self.reading {
            match rx.try_recv() {
                Ok(Ok(read)) => {
                    self.reading = None;
                    changed = self.apply(store, read, dir, device, time);
                }
                Ok(Err(e)) => {
                    self.reading = None;
                    self.error = Some(e);
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => self.reading = None,
            }
        }
        // Com uma leitura ilegível em aberto, até uma mudança local espera a releitura marcada.
        let due = (self.pending && self.bad_reads == 0) || time >= self.next_check;
        if self.reading.is_none() && self.writing.is_none() && due {
            self.next_check = time + CHECK_SECS;
            let dir = dir.to_path_buf();
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(read_folder(&dir));
            });
            self.reading = Some(rx);
        }
        changed
    }

    /// Com a pasta lida em mãos: mescla (aqui, na thread da interface, sobre as tarefas atuais) e, se preciso,
    /// grava. Devolve `true` se as tarefas locais mudaram.
    fn apply(&mut self, store: &mut Store, read: Read, dir: &Path, device: &str, time: f64) -> bool {
        let path = dir.join(FILE_NAME);
        let hash = read.bytes.as_deref().map(fnv);
        if !self.pending && read.copies.is_empty() && hash.is_some() && hash == self.seen {
            // O mesmo conteúdo que já foi mesclado (ou que este app gravou): nada a fazer.
            self.last_ok = Some(Local::now().naive_local());
            self.error = None;
            return false;
        }
        // O arquivo precisa ser regravado mesmo que a mesclagem não mude nada (não existe, ou foi posto de lado).
        let mut rewrite = false;
        let remote = match &read.bytes {
            None => None,
            Some(bytes) => match parse(bytes) {
                Ok(f) if f.schema > SCHEMA => {
                    self.error = Some(format!("O arquivo foi gravado por uma versão mais nova do {}. Atualize o app para sincronizar.", brand::NAME));
                    self.seen = hash;
                    return false;
                }
                Ok(f) => {
                    self.notice = None;
                    self.bad_reads = 0;
                    Some(f)
                }
                Err(e) => {
                    // Quase sempre é um download do cliente da nuvem pela metade: relê antes de concluir qualquer coisa.
                    if hash != self.bad_hash {
                        self.bad_hash = hash;
                        self.bad_reads = 0;
                    }
                    self.bad_reads += 1;
                    if self.bad_reads < BAD_READS {
                        self.next_check = time + RETRY_SECS;
                        return false;
                    }
                    self.bad_reads = 0;
                    self.bad_hash = None;
                    let saved = salvage(bytes);
                    let kept = match quarantine_copy(&path) {
                        Ok(name) => format!("Uma cópia dele ficou como {name}"),
                        Err(err) => format!("Não deu para guardar uma cópia dele ({err})"),
                    };
                    let used = match &saved {
                        Some(s) => format!("{} tarefa(s) legível(is) dele foram aproveitadas", s.tasks.len()),
                        None => "nada dele pôde ser aproveitado".to_owned(),
                    };
                    self.notice = Some(format!("O arquivo de sincronização estava ilegível ({e}). {kept}, {used}, e ele foi regravado com as tarefas deste computador."));
                    rewrite = true;
                    saved
                }
            },
        };

        // Uma edição feita e ainda não gravada ganha carimbo antes de mesclar, com o relógio já adiantado pelo
        // arquivo: é a mudança mais recente e não pode perder para o que veio de fora.
        if let Some(r) = &remote {
            r.bump(store);
        }
        // Sempre, não só com `dirty`: é só uma comparação, e assim nenhuma mudança que tenha escapado da marca
        // entra na referência sem carimbo.
        store.stamp_changes();
        let now = Utc::now().timestamp_millis();
        let mut changed_local = false;
        if let Some(r) = &remote
            && !store.synced_once
        {
            changed_local |= adopt_matches(store, r);
        }
        changed_local |= merge(store, remote.as_ref(), device, now).changed_local;
        let mut shelved = Vec::new();
        for (copy_path, bytes) in &read.copies {
            // Ilegível (talvez ainda baixando) ou de uma versão mais nova: fica para uma próxima leitura.
            if let Ok(f) = parse(bytes)
                && f.schema <= SCHEMA
            {
                // O resultado até aqui é a base da próxima: uma cópia com a mesma origem não combina de novo.
                store.mark_synced();
                changed_local |= merge(store, Some(&f), device, now).changed_local;
                shelved.push(copy_path.clone());
            }
        }
        if !store.synced_once {
            store.synced_once = true;
            changed_local = true;
        }
        self.pending = false;
        // Com arquivo lido, a base da próxima mesclagem muda e precisa ir ao disco, mesmo sem mudança nas tarefas.
        if changed_local || remote.is_some() {
            store.dirty = true;
        }
        // O estado mesclado passa a ser a referência de carimbar e a base da próxima mesclagem.
        store.mark_synced();

        let file = SyncFile::from_store(store, device);
        let changed_file = rewrite || remote.as_ref().is_none_or(|r| !r.same_content(&file));
        if changed_file {
            match serde_json::to_vec_pretty(&file) {
                Ok(json) => {
                    self.seen = Some(fnv(&json));
                    let (tx, rx) = mpsc::channel();
                    std::thread::spawn(move || {
                        let result = write_same_file(&path, &json);
                        for p in &shelved {
                            shelve(p);
                        }
                        let _ = tx.send(result);
                    });
                    self.writing = Some(rx);
                }
                Err(e) => self.error = Some(format!("Não foi possível montar o arquivo de sincronização: {e}")),
            }
        } else {
            self.seen = hash;
            self.last_ok = Some(Local::now().naive_local());
            self.error = None;
            if !shelved.is_empty() {
                std::thread::spawn(move || {
                    for p in &shelved {
                        shelve(p);
                    }
                });
            }
        }
        changed_local
    }

    /// Ao fechar o app: espera a gravação em andamento e manda o que ainda falta, tudo na hora (sem threads).
    pub fn flush(&mut self, store: &mut Store, dir: &Path, device: &str) {
        if let Some(rx) = self.writing.take() {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
        }
        self.reading = None;
        store.stamp_changes();
        if store.dirty {
            self.pending = true;
        }
        if !self.pending {
            return;
        }
        let path = dir.join(FILE_NAME);
        let now = Utc::now().timestamp_millis();
        let mut changed_local = false;
        // Duas voltas no máximo: se outro aparelho gravar entre a nossa gravação e a conferência, relê e mescla.
        for _ in 0..2 {
            let Ok(read) = read_folder(dir) else { return };
            let remote = read.bytes.as_deref().and_then(|b| parse(b).ok()).filter(|f| f.schema <= SCHEMA);
            if read.bytes.is_some() && remote.is_none() {
                // Ilegível ou de uma versão mais nova: não é hora de mexer nele.
                break;
            }
            if let Some(r) = &remote {
                r.bump(store);
                if !store.synced_once {
                    changed_local |= adopt_matches(store, r);
                }
            }
            changed_local |= merge(store, remote.as_ref(), device, now).changed_local;
            for (copy_path, bytes) in &read.copies {
                if let Ok(f) = parse(bytes)
                    && f.schema <= SCHEMA
                {
                    store.mark_synced();
                    changed_local |= merge(store, Some(&f), device, now).changed_local;
                    shelve(copy_path);
                }
            }
            if !store.synced_once {
                store.synced_once = true;
                changed_local = true;
            }
            store.mark_synced();
            let file = SyncFile::from_store(store, device);
            if remote.as_ref().is_some_and(|r| r.same_content(&file)) {
                break;
            }
            let Ok(json) = serde_json::to_vec_pretty(&file) else { break };
            if write_same_file(&path, &json) != Err(WriteFail::Changed) {
                break;
            }
        }
        // O que entrou na saída, e a base da próxima mesclagem, ficam gravados aqui também.
        store.dirty = true;
        store.save();
        self.pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Relógio de parede dos testes, perto dos carimbos usados neles.
    const NOW: i64 = 1_764_001_000_000;

    /// Um `Store` montado a partir de um arquivo de sincronização (como se ele tivesse sido lido numa máquina vazia).
    /// Com relógio de parede zero, nenhuma lápide do arquivo é podada ao montar.
    fn store_from(file: &SyncFile) -> Store {
        let mut s = Store::default();
        merge(&mut s, Some(file), "teste", 0);
        s.synced_once = true;
        s.mark_synced();
        s.dirty = false;
        s
    }

    fn task(uid: &str, title: &str, stamp: i64) -> SyncTask {
        let mut t = SyncTask { uid: uid.into(), title: title.into(), ..Default::default() };
        for g in Group::ALL {
            t.stamps.set(g, stamp);
        }
        t
    }

    fn file(tasks: Vec<SyncTask>, deleted: Vec<Tombstone>) -> SyncFile {
        SyncFile { schema: SCHEMA, tasks, deleted, ..Default::default() }
    }

    fn json(f: &SyncFile) -> Vec<u8> {
        serde_json::to_vec_pretty(f).unwrap()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("navi_sync_teste_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    /// Roda a sincronização até ela ficar parada, avançando o relógio da interface `step` s por quadro.
    fn run(s: &mut Sync, st: &mut Store, dir: &Path, who: &str, time: &mut f64, step: f64) {
        let mut idle = 0;
        for _ in 0..3000 {
            *time += step;
            s.tick(st, Some(dir), who, *time);
            if s.reading.is_none() && s.writing.is_none() {
                idle += 1;
                if idle > 3 {
                    break;
                }
            } else {
                idle = 0;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn casos_de_mesclagem_compartilhados() {
        // Os mesmos casos que o N.avi do celular vai rodar (docs/sync-casos/mesclagem.json).
        let doc: serde_json::Value = serde_json::from_str(include_str!("../docs/sync-casos/mesclagem.json")).unwrap();
        let default_now = doc["agora"].as_i64().unwrap();
        let mut n = 0;
        for case in doc["casos"].as_array().unwrap() {
            let name = case["nome"].as_str().unwrap();
            let local: SyncFile = serde_json::from_value(case["local"].clone()).unwrap();
            let remote: Option<SyncFile> = serde_json::from_value(case["remoto"].clone()).unwrap();
            let expected: SyncFile = serde_json::from_value(case["esperado"].clone()).unwrap();
            let now = case["agora"].as_i64().unwrap_or(default_now);
            let mut store = store_from(&local);
            if let Some(base) = case.get("base") {
                // O estado da última mesclagem que este aparelho conhece, para saber quem mudou o quê.
                let base: SyncFile = serde_json::from_value(base.clone()).unwrap();
                let tasks: Vec<Task> = base.tasks.iter().map(|t| t.to_task(0)).collect();
                store.set_reference(&tasks);
            }
            if case["primeira_vez"].as_bool() == Some(true)
                && let Some(r) = &remote
            {
                adopt_matches(&mut store, r);
            }
            let out = merge(&mut store, remote.as_ref(), "teste", now);
            assert!(out.file.same_content(&expected), "{name}: esperado {expected:?}, veio {:?}", out.file);
            n += 1;
        }
        assert!(n >= 15, "{n} casos lidos");
    }

    /// Um par (local, remoto) da mesma tarefa com a base da última mesclagem já na referência do `Store`.
    fn three_way(base: &SyncTask, local: &SyncTask, remote: &SyncTask) -> (Store, SyncFile) {
        let mut s = store_from(&file(vec![local.clone()], vec![]));
        s.set_reference(&[base.to_task(1)]);
        (s, file(vec![remote.clone()], vec![]))
    }

    #[test]
    fn os_dois_lados_mudaram_tags_e_checklist_viram_uniao() {
        let mut base = task("a", "Reunião", 100);
        base.tags = vec!["trabalho".into()];
        base.subtasks = vec![Subtask { title: "Pauta".into(), done: false }, Subtask { title: "Sala".into(), done: false }];
        let mut local = base.clone();
        local.tags.push("urgente".into());
        local.subtasks[0].done = true; // marcou a pauta
        local.stamps.set(Group::Tags, 300);
        local.stamps.set(Group::Subtasks, 300);
        let mut remote = base.clone();
        remote.tags.push("cliente".into());
        remote.subtasks.push(Subtask { title: "Café".into(), done: true }); // acrescentou um item
        remote.stamps.set(Group::Tags, 400);
        remote.stamps.set(Group::Subtasks, 400);
        let (mut s, r) = three_way(&base, &local, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        let t = &out.file.tasks[0];
        assert_eq!(t.tags, ["trabalho", "urgente", "cliente"]);
        let items: Vec<(&str, bool)> = t.subtasks.iter().map(|x| (x.title.as_str(), x.done)).collect();
        assert_eq!(items, [("Pauta", true), ("Sala", false), ("Café", true)]);
        assert_eq!(t.stamps.tags, NOW, "o combinado ganha carimbo novo, à frente dos dois");
        assert_eq!(t.stamps.subtasks, NOW);
        assert_eq!(t.stamps.title, 100, "os grupos que ninguém mexeu ficam como estavam");
        // O outro aparelho recebe o combinado por carimbo maior, e os dois convergem.
        let mut other = store_from(&r);
        merge(&mut other, Some(&out.file), "o", NOW);
        assert!(SyncFile::from_store(&other, "o").same_content(&out.file));
    }

    #[test]
    fn informacoes_editadas_dos_dois_lados_guardam_as_duas_versoes() {
        let mut base = task("a", "Consulta", 100);
        base.notes = "Levar documentos".into();
        let mut local = base.clone();
        local.notes = "Levar documentos e exames".into();
        local.stamps.set(Group::Notes, 300);
        let mut remote = base.clone();
        remote.notes = "Levar RG".into();
        remote.stamps.set(Group::Notes, 400);
        let (mut s, r) = three_way(&base, &local, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, format!("Levar RG\n\n{OTHER_VERSION_MARK}\nLevar documentos e exames"), "a mais nova em cima, a outra embaixo");
        assert_eq!(out.file.tasks[0].stamps.notes, NOW);
        // Só um lado mudou: continua valendo o carimbo, sem anexo.
        let (mut s, r) = three_way(&base, &base, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, "Levar RG");
        assert_eq!(out.file.tasks[0].stamps.notes, 400);
        // O outro lado apagou as informações: a versão que sobrou fica, sem separador.
        let mut cleared = base.clone();
        cleared.notes = String::new();
        cleared.stamps.set(Group::Notes, 400);
        let (mut s, r) = three_way(&base, &local, &cleared);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, "Levar documentos e exames");
        // Um lado já tem a combinação (contém o outro): não acrescenta de novo, de nenhum dos dois lados.
        let mut combined = base.clone();
        combined.notes = format!("Levar RG\n\n{OTHER_VERSION_MARK}\nLevar documentos e exames");
        combined.stamps.set(Group::Notes, 500);
        let (mut s, r) = three_way(&base, &combined, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, combined.notes, "o vencedor já contém o perdedor");
        let (mut s, r) = three_way(&base, &local, &combined);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, combined.notes, "o perdedor já contém o vencedor");
    }

    #[test]
    fn copia_de_conflito_com_a_mesma_origem_nao_combina_de_novo() {
        // Furo da reauditoria final: "A --- B" virava "A --- B --- B" ao mesclar uma cópia com a mesma base.
        let dir = temp_dir("copia_mesma_origem");
        let mut base = task("a", "Consulta", 100);
        base.notes = "A".into();
        let mut remote = base.clone();
        remote.notes = "B".into();
        remote.stamps.set(Group::Notes, 400);
        std::fs::write(dir.join(FILE_NAME), json(&file(vec![remote.clone()], vec![]))).unwrap();
        std::fs::write(dir.join("N.avi.sync (1).json"), json(&file(vec![remote], vec![]))).unwrap();
        let mut local = base.clone();
        local.notes = "A editado".into();
        local.stamps.set(Group::Notes, 300);
        let mut store = store_from(&file(vec![local], vec![]));
        store.set_reference(&[base.to_task(1)]);
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        run(&mut sync, &mut store, &dir, "pc", &mut time, 0.05);
        assert_eq!(store.tasks[0].notes, format!("B\n\n{OTHER_VERSION_MARK}\nA editado"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn combinacao_vale_no_fluxo_real_com_gravacao_no_meio_e_sobrevive_ao_disco() {
        // A base é o fim da última mesclagem, não a última gravação: gravar entre as duas não a apaga.
        let mut base = task("a", "Reunião", 100);
        base.tags = vec!["trabalho".into()];
        let mut s = store_from(&file(vec![base.clone()], vec![])); // mesclou: base = ["trabalho"]
        s.tasks[0].tags.push("urgente".into());
        s.save(); // carimba e refaz a referência de carimbar; a base fica
        assert_eq!(s.reference("a").unwrap().tags, ["trabalho"]);
        let mut remote = base.clone();
        remote.tags.push("cliente".into());
        remote.stamps.set(Group::Tags, Utc::now().timestamp_millis() + 60_000);
        let now = Utc::now().timestamp_millis();
        let out = merge(&mut s, Some(&file(vec![remote], vec![])), "t", now);
        assert_eq!(out.file.tasks[0].tags, ["trabalho", "urgente", "cliente"], "os dois lados mudaram: união");
        s.mark_synced();
        // A base vai ao disco com o Store e volta na próxima execução.
        let text = serde_json::to_string(&s).unwrap();
        let again: Store = serde_json::from_str(&text).unwrap();
        assert_eq!(again.reference("a").unwrap().tags, ["trabalho", "urgente", "cliente"]);
    }

    #[test]
    fn mesmo_valor_nos_dois_lados_nunca_e_conflito() {
        let mut base = task("a", "Consulta", 100);
        base.notes = "a".into();
        let mut local = base.clone();
        local.notes = "b".into();
        local.stamps.set(Group::Notes, 300);
        let mut remote = local.clone();
        remote.stamps.set(Group::Notes, 400);
        let (mut s, r) = three_way(&base, &local, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].notes, "b");
        assert_eq!(out.file.tasks[0].stamps.notes, 400, "só o carimbo converge para o maior");
        assert!(!out.changed_file, "o arquivo já tinha exatamente isto");
    }

    #[test]
    fn titulo_e_estado_nao_se_combinam_e_seguem_o_carimbo() {
        let base = task("a", "Pão", 100);
        let mut local = base.clone();
        local.title = "Pão integral".into();
        local.stamps.set(Group::Title, 300);
        let mut remote = base.clone();
        remote.title = "Pão francês".into();
        remote.stamps.set(Group::Title, 400);
        let (mut s, r) = three_way(&base, &local, &remote);
        let out = merge(&mut s, Some(&r), "t", NOW);
        assert_eq!(out.file.tasks[0].title, "Pão francês");
        assert_eq!(out.file.tasks[0].stamps.title, 400);
    }

    #[test]
    fn mesma_mesclagem_em_qualquer_ordem() {
        let a = file(vec![task("x", "Pão", 100), task("y", "Leite", 300)], vec![Tombstone { uid: "z".into(), at: 200 }]);
        let b = file(vec![task("x", "Pão francês", 250), task("z", "Ovos", 150)], vec![]);
        let mut ab = store_from(&a);
        let mut ba = store_from(&b);
        merge(&mut ab, Some(&b), "1", 1000);
        merge(&mut ba, Some(&a), "2", 1000);
        let (fa, fb) = (SyncFile::from_store(&ab, "1"), SyncFile::from_store(&ba, "2"));
        assert!(fa.same_content(&fb), "{fa:?} vs {fb:?}");
        assert_eq!(fa.tasks.iter().find(|t| t.uid == "x").unwrap().title, "Pão francês");
        assert!(fa.tasks.iter().all(|t| t.uid != "z"), "a exclusão de z (200) é mais nova que a edição (150)");
    }

    #[test]
    fn exclusao_contra_edicao_dos_dois_lados() {
        // Excluída aqui depois de editada lá: continua excluída.
        let mut s = store_from(&file(vec![task("a", "A", 100)], vec![]));
        s.remove_uid("a");
        s.deleted.push(Tombstone { uid: "a".into(), at: 500 });
        let out = merge(&mut s, Some(&file(vec![task("a", "A editada", 400)], vec![])), "t", 1000);
        assert!(s.find_uid("a").is_none() && out.file.deleted.len() == 1);
        // Editada aqui depois de excluída lá: volta a valer, sem lápide.
        let mut s = store_from(&file(vec![task("b", "B", 600)], vec![]));
        let out = merge(&mut s, Some(&file(vec![], vec![Tombstone { uid: "b".into(), at: 550 }])), "t", 1000);
        assert!(s.find_uid("b").is_some() && out.file.deleted.is_empty());
    }

    #[test]
    fn mudanca_local_ganha_carimbo_e_vai_para_o_arquivo() {
        let mut s = store_from(&file(vec![task("a", "A", 1_764_000_000_000)], vec![]));
        let i = s.find_uid("a").unwrap();
        s.tasks[i].title = "A nova".into();
        s.save(); // carimba (em pasta temporária, nos testes)
        assert!(s.tasks[i].stamps.title > 1_764_000_000_000);
        assert_eq!(s.tasks[i].stamps.notes, 1_764_000_000_000, "só o título mudou");
        let remote = file(vec![task("a", "A", 1_764_000_000_000)], vec![]);
        let out = merge(&mut s, Some(&remote), "t", NOW);
        assert!(out.changed_file && !out.changed_local);
        assert_eq!(out.file.tasks[0].title, "A nova");
    }

    #[test]
    fn mesclar_nao_recarimba_o_que_veio_de_fora() {
        // Furo 4 da auditoria: B recebe "X"@200 e o regrava; se o recarimbasse, "X" venceria uma edição mais nova de C.
        let mut s = store_from(&file(vec![], vec![]));
        let remote = file(vec![task("a", "X", 1_764_000_000_200)], vec![]);
        merge(&mut s, Some(&remote), "b", NOW);
        s.mark_synced();
        s.save();
        let t = &s.tasks[s.find_uid("a").unwrap()];
        assert_eq!(t.stamps.title, 1_764_000_000_200, "gravar depois de mesclar não gera carimbo novo");
        // E uma edição local de verdade continua ganhando carimbo.
        let i = s.find_uid("a").unwrap();
        s.tasks[i].notes = "anotação".into();
        s.save();
        assert!(s.tasks[i].stamps.notes > 1_764_000_000_200);
        assert_eq!(s.tasks[i].stamps.title, 1_764_000_000_200);
    }

    #[test]
    fn lapides_velhas_saem_pelo_relogio_de_parede() {
        let mut s = store_from(&file(
            vec![task("a", "A", NOW)],
            vec![
                Tombstone { uid: "velha".into(), at: NOW - TOMBSTONE_MS - 1 },
                Tombstone { uid: "nova".into(), at: NOW - 1000 },
                Tombstone { uid: "do_futuro".into(), at: NOW + 10 * 24 * 3600 * 1000 },
            ],
        ));
        // Um aparelho com a hora muito adiantada empurrou o relógio híbrido para o futuro: isso não pode podar nada.
        s.bump_clock(NOW + 400 * 24 * 3600 * 1000);
        let out = merge(&mut s, None, "t", NOW);
        let mut uids: Vec<&str> = out.file.deleted.iter().map(|d| d.uid.as_str()).collect();
        uids.sort();
        assert_eq!(uids, ["do_futuro", "nova"]);
    }

    #[test]
    fn desfazer_exclusao_vence_a_lapide() {
        // Furo 7: excluir, gravar (vira lápide, que já pode ter ido ao arquivo), desfazer.
        let mut s = store_from(&file(vec![task("a", "Dentista", 100)], vec![]));
        let t = s.tasks[0].clone();
        s.remove(t.id);
        s.save();
        assert_eq!(s.deleted.len(), 1);
        let tomb_at = s.deleted[0].at;
        s.restore(t, 0);
        assert!(s.deleted.is_empty(), "desfazer tira a lápide");
        assert!(s.tasks[0].stamps.latest() > tomb_at, "e a tarefa volta carimbada depois da exclusão");
        // A lápide já estava no arquivo: a tarefa restaurada sobrevive à mesclagem e a lápide cai do arquivo.
        let out = merge(&mut s, Some(&file(vec![], vec![Tombstone { uid: "a".into(), at: tomb_at }])), "t", NOW);
        assert_eq!(s.tasks.len(), 1);
        assert!(out.file.deleted.is_empty());
    }

    #[test]
    fn primeira_entrada_casa_tarefas_iguais_sem_duplicar() {
        // Furo 12: um computador migrado (uids próprios) entra num arquivo que já tem as mesmas tarefas.
        let date = NaiveDate::from_ymd_opt(2026, 12, 5);
        let mut local = Store::default();
        let id = local.add("Aluguel".into(), date);
        local.add("Só daqui".into(), None);
        local.save();
        assert!(!local.synced_once);
        // No arquivo, a mesma "Aluguel" (igual em todos os grupos) com outro uid, e uma "Só daqui" que difere
        // (lá ela tem anotações): essa não casa, e as duas ficam.
        let mut r1 = SyncTask::from_task(&local.tasks[0]);
        r1.uid = "r-1".into();
        for g in Group::ALL {
            r1.stamps.set(g, 1_764_000_000_100);
        }
        let mut r3 = SyncTask::from_task(&local.tasks[1]);
        r3.uid = "r-3".into();
        r3.notes = "anotação só do arquivo".into();
        let remote = file(vec![r1, task("r-2", "Dentista", 1_764_000_000_100), r3], vec![]);
        assert!(adopt_matches(&mut local, &remote));
        let out = merge(&mut local, Some(&remote), "t", NOW);
        assert_eq!(local.tasks.len(), 4, "Aluguel não dobrou; Só daqui dobrou de propósito, porque difere");
        let aluguel = &local.tasks[local.tasks.iter().position(|t| t.id == id).unwrap()];
        assert_eq!((aluguel.uid.as_str(), aluguel.stamps.title), ("r-1", 1_764_000_000_100), "assume uid e carimbos do arquivo, com o id local");
        assert_eq!(local.tasks.iter().filter(|t| t.title == "Só daqui").count(), 2);
        assert_eq!(out.file.tasks.len(), 4);
        // Depois da primeira vez, duas tarefas iguais criadas de lados diferentes são mesmo duas.
        let mut again = store_from(&out.file);
        again.add("Dentista".into(), None);
        again.save();
        let remote2 = file(vec![task("r-9", "Dentista", NOW)], vec![]);
        assert!(!adopt_matches(&mut Store::default(), &file(vec![], vec![])), "sem nada a casar");
        merge(&mut again, Some(&remote2), "t", NOW);
        assert_eq!(again.tasks.iter().filter(|t| t.title == "Dentista").count(), 3);
    }

    #[test]
    fn edicao_nao_gravada_nao_e_sobrescrita_pela_mesclagem() {
        // Furo 3: a pessoa digitou e ainda não gravou; o arquivo traz um título mais novo que o último carimbo.
        let dir = temp_dir("digitando");
        let stamp = Utc::now().timestamp_millis() - 60_000;
        let mut store = store_from(&file(vec![task("a", "Original", stamp)], vec![]));
        let mut other = task("a", "Do celular", stamp + 5_000);
        other.notes = "nota do celular".into();
        std::fs::write(dir.join(FILE_NAME), json(&file(vec![other], vec![]))).unwrap();
        // Sem marcar `dirty` de propósito: a mudança precisa ser carimbada mesmo assim antes de mesclar.
        store.tasks[0].title = "Digitado agora".into();
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        run(&mut sync, &mut store, &dir, "pc", &mut time, 0.05);
        assert_eq!(store.tasks[0].title, "Digitado agora", "o que foi digitado fica");
        assert_eq!(store.tasks[0].notes, "nota do celular", "e o que veio de fora em outro grupo entra");
        let written = parse(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(written.tasks[0].title, "Digitado agora");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn gravar_mantem_o_mesmo_arquivo() {
        // Furo 1: regravar o conteúdo, não trocar o arquivo (no Drive a troca vira outro id).
        let dir = temp_dir("mesmo_arquivo");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, b"antigo").unwrap();
        let created = std::fs::metadata(&path).unwrap().created().ok();
        std::thread::sleep(std::time::Duration::from_millis(30));
        write_same_file(&path, b"novo conteudo, maior que o antigo").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"novo conteudo, maior que o antigo");
        assert_eq!(std::fs::metadata(&path).unwrap().created().ok(), created, "é o mesmo arquivo de antes");
        assert_eq!(names(&dir), [FILE_NAME], "sem arquivo temporário sobrando");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn arquivo_pela_metade_e_relido_antes_de_ser_posto_de_lado() {
        // Furo 2: um download pela metade não é "corrompido"; se completar a tempo, é mesclado normalmente.
        let dir = temp_dir("pela_metade");
        let path = dir.join(FILE_NAME);
        let full = json(&file(vec![task("c", "Do celular", 100)], vec![]));
        std::fs::write(&path, &full[..full.len() / 2]).unwrap();
        let mut store = store_from(&file(vec![task("a", "Minha", 100)], vec![]));
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        run(&mut sync, &mut store, &dir, "pc", &mut time, 0.05);
        assert_eq!(sync.bad_reads, 1, "uma leitura ruim, ainda sem conclusão");
        assert_eq!(names(&dir), [FILE_NAME], "nada foi posto de lado nem regravado");
        assert_eq!(std::fs::read(&path).unwrap(), &full[..full.len() / 2]);
        // O download termina antes da releitura marcada.
        std::fs::write(&path, &full).unwrap();
        time += RETRY_SECS;
        run(&mut sync, &mut store, &dir, "pc", &mut time, 0.5);
        assert_eq!(store.tasks.len(), 2, "o conteúdo completo foi mesclado");
        assert_eq!(sync.bad_reads, 0);
        assert!(sync.notice.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn arquivo_corrompido_de_vez_e_copiado_aproveitado_e_regravado_no_lugar() {
        let dir = temp_dir("corrompido");
        let path = dir.join(FILE_NAME);
        // Truncado no meio da segunda tarefa: a primeira ainda se lê inteira.
        let full = String::from_utf8(json(&file(vec![task("c1", "Inteira", 100), task("c2", "Cortada", 100)], vec![]))).unwrap();
        let cut = full.find("Cortada").unwrap() + 3;
        std::fs::write(&path, &full.as_bytes()[..cut]).unwrap();
        let created = std::fs::metadata(&path).unwrap().created().ok();
        let mut store = store_from(&file(vec![task("a", "Minha tarefa", 100)], vec![]));
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        for _ in 0..BAD_READS {
            run(&mut sync, &mut store, &dir, "pc", &mut time, 0.5);
        }
        let Status::Error(msg) = sync.status(true) else { panic!("devia avisar do arquivo ilegível: {:?}", sync.status(true)) };
        assert!(msg.contains("ilegível") && msg.contains("1 tarefa(s)"), "{msg}");
        let names = names(&dir);
        assert!(names.iter().any(|n| n.starts_with("N.avi.sync.corrompido-")), "{names:?}");
        assert!(names.contains(&FILE_NAME.to_owned()), "o arquivo original continua no lugar: {names:?}");
        assert_eq!(std::fs::metadata(&path).unwrap().created().ok(), created, "e é o mesmo arquivo");
        let written = parse(&std::fs::read(&path).unwrap()).unwrap();
        let mut titles: Vec<&str> = written.tasks.iter().map(|t| t.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["Inteira", "Minha tarefa"], "a tarefa legível foi aproveitada e nada local foi apagado");
        assert_eq!(store.tasks.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lixo_sem_nada_aproveitavel_tambem_e_posto_de_lado() {
        let dir = temp_dir("lixo");
        std::fs::write(dir.join(FILE_NAME), b"{ isto nao e json").unwrap();
        let mut store = store_from(&file(vec![task("a", "Minha tarefa", 100)], vec![]));
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        for _ in 0..BAD_READS {
            run(&mut sync, &mut store, &dir, "pc", &mut time, 0.5);
        }
        let Status::Error(msg) = sync.status(true) else { panic!("{:?}", sync.status(true)) };
        assert!(msg.contains("nada dele pôde ser aproveitado"), "{msg}");
        let written = parse(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(written.tasks.len(), 1);
        assert_eq!(store.tasks.len(), 1, "nada local foi apagado");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn aproveitamento_respeita_chaves_dentro_de_textos() {
        let mut t = task("x", "Título com } e \"aspas\" e [colchete", 7);
        t.notes = "{\"tasks\": [ falso ]".into();
        let full = json(&file(vec![t, task("y", "Outra", 8)], vec![Tombstone { uid: "z".into(), at: 9 }]));
        let cut = &full[..full.len() - 3];
        let saved = salvage(cut).unwrap();
        assert_eq!(saved.tasks.len(), 2);
        assert_eq!(saved.tasks[0].title, "Título com } e \"aspas\" e [colchete");
        assert_eq!(saved.deleted.len(), 1);
    }

    #[test]
    fn copias_de_conflito_sao_mescladas_e_guardadas() {
        // Furo 5: "N.avi.sync (1).json" (Google) e "N.avi.sync-PC.json" (OneDrive) entram e vão para conflitos/.
        let dir = temp_dir("conflitos");
        std::fs::write(dir.join(FILE_NAME), json(&file(vec![task("x", "Principal", 100)], vec![]))).unwrap();
        std::fs::write(dir.join("N.avi.sync (1).json"), json(&file(vec![task("y", "Da cópia do Google", 100)], vec![]))).unwrap();
        std::fs::write(dir.join("N.avi.sync-NOTEBOOK.json"), json(&file(vec![task("z", "Da cópia do OneDrive", 100)], vec![]))).unwrap();
        std::fs::write(dir.join("N.avi.sync.corrompido-20260101-000000.json"), b"{").unwrap();
        let mut store = store_from(&file(vec![], vec![]));
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        run(&mut sync, &mut store, &dir, "pc", &mut time, 0.05);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(store.tasks.len(), 3);
        let written = parse(&std::fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(written.tasks.len(), 3, "o arquivo principal recebeu tudo");
        assert_eq!(names(&dir), ["N.avi.sync.corrompido-20260101-000000.json", FILE_NAME, CONFLICTS_DIR], "a cópia corrompida não é cópia de conflito e fica");
        assert_eq!(names(&dir.join(CONFLICTS_DIR)), ["N.avi.sync (1).json", "N.avi.sync-NOTEBOOK.json"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dois_computadores_convergem_pelo_arquivo() {
        let dir = temp_dir("dois");
        let mut a = store_from(&file(vec![task("x", "Do primeiro", 100)], vec![]));
        let mut b = store_from(&file(vec![task("y", "Do segundo", 200)], vec![]));
        let (mut sa, mut sb) = (Sync::new(), Sync::new());
        let (mut ta, mut tb) = (0.0, 0.0);
        sa.kick();
        run(&mut sa, &mut a, &dir, "a", &mut ta, 0.05);
        sb.kick();
        run(&mut sb, &mut b, &dir, "b", &mut tb, 0.05);
        assert_eq!(b.tasks.len(), 2, "o segundo recebeu a tarefa do primeiro");
        sa.kick();
        run(&mut sa, &mut a, &dir, "a", &mut ta, 0.05);
        assert_eq!(a.tasks.len(), 2, "e o primeiro recebeu a do segundo");
        assert!(SyncFile::from_store(&a, "a").same_content(&SyncFile::from_store(&b, "b")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pasta_sugerida_por_nuvem() {
        let root = Path::new("C:\\Nuvem");
        assert_eq!(suggested_folder("OneDrive", root), Path::new("C:\\Nuvem\\Apps\\N.avi"));
        assert_eq!(suggested_folder("Google Drive", root), Path::new("C:\\Nuvem\\N.avi"));
        assert!(is_conflict_copy("N.avi.sync (1).json") && is_conflict_copy("N.avi.sync-PC.json"));
        assert!(!is_conflict_copy(FILE_NAME) && !is_conflict_copy("N.avi.sync.corrompido-20260101-000000.json"));
    }
}
