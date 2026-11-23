//! Sincronização das tarefas entre aparelhos por um arquivo numa pasta de nuvem: o computador grava e lê
//! `N.avi.sync.json` numa pasta que o Google Drive ou o OneDrive sincronizam; o celular lê e grava o mesmo
//! arquivo pela API da nuvem. O formato, os carimbos e a regra de mesclagem estão em `docs/sincronizacao.md`;
//! os casos de teste em `docs/sync-casos/` valem para as duas implementações.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};

use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::brand;
use crate::model::{Group, Repeat, Stamps, Store, Subtask, Task, Tombstone};

/// Versão do formato do arquivo. Quem lê um `schema` maior não grava nada.
pub const SCHEMA: u32 = 1;
pub const FILE_NAME: &str = "N.avi.sync.json";
/// Quanto tempo uma exclusão fica lembrada no arquivo.
const TOMBSTONE_MS: i64 = 90 * 24 * 3600 * 1000;
/// De quanto em quanto tempo o arquivo é relido.
pub const CHECK_SECS: f64 = 20.0;
/// Espera depois de abrir o app: a unidade da nuvem pode ainda estar montando.
const FIRST_CHECK_SECS: f64 = 15.0;

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
pub fn merge(store: &mut Store, remote: Option<&SyncFile>, device: &str) -> MergeOutcome {
    let mut changed_local = false;
    if let Some(r) = remote {
        store.bump_clock(r.clock);
        for t in &r.tasks {
            store.bump_clock(t.stamps.latest());
        }
        for d in &r.deleted {
            store.bump_clock(d.at);
        }
        for e in r.tags.values() {
            store.bump_clock(e.at);
        }

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
                    let local = &mut store.tasks[i];
                    let incoming = rt.to_task(local.id);
                    for g in Group::ALL {
                        let (ls, rs) = (local.stamps.get(g), incoming.stamps.get(g));
                        let newer = rs > ls;
                        // Empate exato com conteúdo diferente: decide pelo texto, igual nos dois lados.
                        let tie = rs == ls && !local.group_eq(&incoming, g) && incoming.group_key(g) > local.group_key(g);
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
    }

    // Lápides velhas saem (de todo mundo, no mesmo critério).
    let horizon = store.clock - TOMBSTONE_MS;
    let before = store.deleted.len();
    store.deleted.retain(|d| d.at >= horizon);
    changed_local |= store.deleted.len() != before;

    let file = SyncFile::from_store(store, device);
    let changed_file = remote.is_none_or(|r| !r.same_content(&file));
    MergeOutcome { changed_local, changed_file, file }
}

/// Pasta sugerida para a sincronização em cada nuvem: no OneDrive (e no Dropbox) a pasta de apps, que o celular
/// alcança como "pasta do app"; no Google Drive uma pasta `N.avi` na raiz, que o celular abre pelo seletor.
pub fn suggested_folder(cloud: &str, root: &Path) -> PathBuf {
    match cloud {
        "OneDrive" | "Dropbox" => root.join("Apps").join(brand::NAME),
        _ => root.join(brand::NAME),
    }
}

/// Grava `bytes` em `path` por um arquivo temporário e uma troca: a nuvem nunca vê um arquivo pela metade.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Não foi possível criar a pasta de sincronização: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Não foi possível gravar na pasta de sincronização: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Não foi possível concluir a gravação: {e}"))
}

/// Põe de lado um arquivo ilegível, com a data no nome, e devolve o nome novo.
fn quarantine(path: &Path) -> String {
    let name = format!("N.avi.sync.corrompido-{}.json", Local::now().format("%Y%m%d-%H%M%S"));
    let _ = std::fs::rename(path, path.with_file_name(&name));
    name
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x0100_0000_01b3))
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
}

fn read_file(path: &Path) -> Result<Read, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Read { bytes: Some(bytes) }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Read { bytes: None }),
        Err(e) => Err(format!("Não foi possível ler a pasta de sincronização: {e}")),
    }
}

/// A sincronização em andamento: lê e grava em segundo plano (a unidade da nuvem pode demorar) e mescla na
/// thread da interface, onde as tarefas estão.
pub struct Sync {
    reading: Option<Receiver<Result<Read, String>>>,
    writing: Option<Receiver<Result<(), String>>>,
    /// Instante, no relógio da interface, da próxima leitura.
    next_check: f64,
    /// Há mudanças locais gravadas que ainda não foram para o arquivo.
    pending: bool,
    /// Hash do conteúdo do arquivo já mesclado ou gravado por aqui: igual, não há o que mesclar.
    seen: Option<u64>,
    last_ok: Option<NaiveDateTime>,
    error: Option<String>,
    /// Aviso que fica até a próxima leitura boa (arquivo ilegível posto de lado).
    notice: Option<String>,
}

impl Sync {
    pub fn new() -> Self {
        Self { reading: None, writing: None, next_check: FIRST_CHECK_SECS, pending: false, seen: None, last_ok: None, error: None, notice: None }
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
                Ok(Err(e)) => {
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
                    changed = self.apply(store, read, &dir.join(FILE_NAME), device);
                }
                Ok(Err(e)) => {
                    self.reading = None;
                    self.error = Some(e);
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => self.reading = None,
            }
        }
        if self.reading.is_none() && self.writing.is_none() && (self.pending || time >= self.next_check) {
            self.next_check = time + CHECK_SECS;
            let path = dir.join(FILE_NAME);
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(read_file(&path));
            });
            self.reading = Some(rx);
        }
        changed
    }

    /// Com o arquivo lido em mãos: mescla e, se preciso, grava.
    fn apply(&mut self, store: &mut Store, read: Read, path: &Path, device: &str) -> bool {
        let hash = read.bytes.as_deref().map(fnv);
        if !self.pending && hash.is_some() && hash == self.seen {
            // O mesmo conteúdo que já foi mesclado (ou que este app gravou): nada a fazer.
            self.last_ok = Some(Local::now().naive_local());
            self.error = None;
            return false;
        }
        let remote = match &read.bytes {
            None => None,
            Some(bytes) => match serde_json::from_slice::<SyncFile>(bytes) {
                Ok(f) if f.schema > SCHEMA => {
                    self.error = Some(format!("O arquivo foi gravado por uma versão mais nova do {}. Atualize o app para sincronizar.", brand::NAME));
                    self.seen = hash;
                    return false;
                }
                Ok(f) => {
                    self.notice = None;
                    Some(f)
                }
                Err(e) => {
                    let aside = quarantine(path);
                    self.notice = Some(format!("O arquivo de sincronização estava ilegível ({e}). Ele foi posto de lado como {aside}, e um novo foi gravado com as tarefas deste computador."));
                    None
                }
            },
        };
        let outcome = merge(store, remote.as_ref(), device);
        self.pending = false;
        if outcome.changed_local {
            store.dirty = true;
        }
        store.mark_synced();
        if remote.is_none() || outcome.changed_file {
            match serde_json::to_vec_pretty(&outcome.file) {
                Ok(json) => {
                    self.seen = Some(fnv(&json));
                    let path = path.to_path_buf();
                    let (tx, rx) = mpsc::channel();
                    std::thread::spawn(move || {
                        let _ = tx.send(write_atomic(&path, &json));
                    });
                    self.writing = Some(rx);
                }
                Err(e) => self.error = Some(format!("Não foi possível montar o arquivo de sincronização: {e}")),
            }
        } else {
            self.seen = hash;
            self.last_ok = Some(Local::now().naive_local());
            self.error = None;
        }
        outcome.changed_local
    }

    /// Ao fechar o app: espera a gravação em andamento e manda o que ainda falta, tudo na hora (sem threads).
    pub fn flush(&mut self, store: &mut Store, dir: &Path, device: &str) {
        if let Some(rx) = self.writing.take() {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
        }
        self.reading = None;
        if !self.pending && store.dirty {
            self.pending = true;
        }
        if !self.pending {
            return;
        }
        let path = dir.join(FILE_NAME);
        let Ok(read) = read_file(&path) else { return };
        let remote = read.bytes.as_deref().and_then(|b| serde_json::from_slice::<SyncFile>(b).ok()).filter(|f| f.schema <= SCHEMA);
        if read.bytes.is_some() && remote.is_none() {
            // Ilegível ou de uma versão mais nova: não é hora de mexer nele.
            return;
        }
        let outcome = merge(store, remote.as_ref(), device);
        store.mark_synced();
        if (remote.is_none() || outcome.changed_file)
            && let Ok(json) = serde_json::to_vec_pretty(&outcome.file)
        {
            let _ = write_atomic(&path, &json);
        }
        self.pending = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Um `Store` montado a partir de um arquivo de sincronização (como se ele tivesse sido lido numa máquina vazia).
    fn store_from(file: &SyncFile) -> Store {
        let mut s = Store::default();
        merge(&mut s, Some(file), "teste");
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

    #[test]
    fn casos_de_mesclagem_compartilhados() {
        // Os mesmos casos que o N.avi do celular vai rodar (docs/sync-casos/mesclagem.json).
        let doc: serde_json::Value = serde_json::from_str(include_str!("../docs/sync-casos/mesclagem.json")).unwrap();
        let mut n = 0;
        for case in doc["casos"].as_array().unwrap() {
            let name = case["nome"].as_str().unwrap();
            let local: SyncFile = serde_json::from_value(case["local"].clone()).unwrap();
            let remote: Option<SyncFile> = serde_json::from_value(case["remoto"].clone()).unwrap();
            let expected: SyncFile = serde_json::from_value(case["esperado"].clone()).unwrap();
            let mut store = store_from(&local);
            let out = merge(&mut store, remote.as_ref(), "teste");
            assert!(out.file.same_content(&expected), "{name}: esperado {expected:?}, veio {:?}", out.file);
            n += 1;
        }
        assert!(n >= 7);
    }

    #[test]
    fn mesma_mesclagem_em_qualquer_ordem() {
        let a = file(vec![task("x", "Pão", 100), task("y", "Leite", 300)], vec![Tombstone { uid: "z".into(), at: 200 }]);
        let b = file(vec![task("x", "Pão francês", 250), task("z", "Ovos", 150)], vec![]);
        let mut ab = store_from(&a);
        let mut ba = store_from(&b);
        merge(&mut ab, Some(&b), "1");
        merge(&mut ba, Some(&a), "2");
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
        let out = merge(&mut s, Some(&file(vec![task("a", "A editada", 400)], vec![])), "t");
        assert!(s.find_uid("a").is_none() && out.file.deleted.len() == 1);
        // Editada aqui depois de excluída lá: volta a valer, sem lápide.
        let mut s = store_from(&file(vec![task("b", "B", 600)], vec![]));
        let out = merge(&mut s, Some(&file(vec![], vec![Tombstone { uid: "b".into(), at: 550 }])), "t");
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
        let out = merge(&mut s, Some(&remote), "t");
        assert!(out.changed_file && !out.changed_local);
        assert_eq!(out.file.tasks[0].title, "A nova");
    }

    #[test]
    fn lapides_velhas_saem() {
        let now = 1_764_000_000_000;
        let mut s = store_from(&file(vec![task("a", "A", now)], vec![Tombstone { uid: "velha".into(), at: now - TOMBSTONE_MS - 1 }, Tombstone { uid: "nova".into(), at: now - 1000 }]));
        let out = merge(&mut s, None, "t");
        let uids: Vec<&str> = out.file.deleted.iter().map(|d| d.uid.as_str()).collect();
        assert_eq!(uids, ["nova"]);
    }

    #[test]
    fn arquivo_corrompido_e_posto_de_lado_e_substituido() {
        let dir = std::env::temp_dir().join("navi_sync_teste_corrompido");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, b"{ isto nao e json").unwrap();
        let mut store = store_from(&file(vec![task("a", "Minha tarefa", 100)], vec![]));
        let mut sync = Sync::new();
        sync.kick();
        let mut time = 0.0;
        for _ in 0..400 {
            time += 0.05;
            sync.tick(&mut store, Some(&dir), "pc", time);
            if matches!(sync.status(true), Status::Error(_)) && sync.writing.is_none() && sync.reading.is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let Status::Error(msg) = sync.status(true) else { panic!("devia avisar do arquivo ilegível: {:?}", sync.status(true)) };
        assert!(msg.contains("ilegível"), "{msg}");
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().any(|n| n.starts_with("N.avi.sync.corrompido-")), "{names:?}");
        let written: SyncFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written.tasks.len(), 1);
        assert_eq!(written.tasks[0].title, "Minha tarefa");
        assert_eq!(store.tasks.len(), 1, "nada local foi apagado");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dois_computadores_convergem_pelo_arquivo() {
        let dir = std::env::temp_dir().join("navi_sync_teste_dois");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = store_from(&file(vec![task("x", "Do primeiro", 100)], vec![]));
        let mut b = store_from(&file(vec![task("y", "Do segundo", 200)], vec![]));
        let (mut sa, mut sb) = (Sync::new(), Sync::new());
        sa.kick();
        let run = |s: &mut Sync, st: &mut Store, who: &str| {
            let mut time = 0.0;
            for _ in 0..300 {
                time += 0.05;
                s.tick(st, Some(&dir), who, time);
                if s.reading.is_none() && s.writing.is_none() && time > 0.2 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };
        run(&mut sa, &mut a, "a");
        sb.kick();
        run(&mut sb, &mut b, "b");
        assert_eq!(b.tasks.len(), 2, "o segundo recebeu a tarefa do primeiro");
        sa.kick();
        run(&mut sa, &mut a, "a");
        assert_eq!(a.tasks.len(), 2, "e o primeiro recebeu a do segundo");
        assert!(SyncFile::from_store(&a, "a").same_content(&SyncFile::from_store(&b, "b")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pasta_sugerida_por_nuvem() {
        let root = Path::new("C:\\Nuvem");
        assert_eq!(suggested_folder("OneDrive", root), Path::new("C:\\Nuvem\\Apps\\N.avi"));
        assert_eq!(suggested_folder("Google Drive", root), Path::new("C:\\Nuvem\\N.avi"));
    }
}
