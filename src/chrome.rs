//! Moldura própria da janela: fundo arredondado, barra de título, botões de
//! janela e áreas de redimensionamento (a janela do Windows é sem decoração).

use eframe::egui::{self, Color32, CursorIcon, Pos2, Rect, Response, Sense, Stroke, vec2};
use egui::viewport::ResizeDirection as Dir;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsZoomed, WM_NCCALCSIZE};

pub const RADIUS: f32 = 14.0;

#[derive(Clone, Copy, PartialEq)]
pub enum Glyph {
    Minimize,
    Maximize,
    Restore,
    Close,
    Refresh,
    Trash,
    /// Seta para cima: ordem crescente.
    SortUp,
    /// Seta para baixo: ordem decrescente.
    SortDown,
    /// Divisa para cima: reduzir.
    ChevronUp,
    /// Divisa para baixo: expandir.
    ChevronDown,
    /// Divisa para a direita: seção recolhida.
    ChevronRight,
    /// Seta para a esquerda: voltar.
    Back,
    Plus,
    /// Sol: tarefas de hoje.
    Today,
    /// Calendário: próximos dias.
    Upcoming,
    /// Linhas: todas as tarefas.
    All,
    /// Círculo com visto: concluídas.
    Done,
    /// Pontos que indicam que a linha pode ser arrastada.
    Grip,
    /// Sino: a tarefa tem aviso.
    Bell,
    /// Setas em círculo, pequenas: a tarefa se repete.
    Repeat,
    /// Visto: itens do checklist.
    Check,
    /// Nuvem: backup.
    Cloud,
    /// Cadeado fechado: o widget está trancado.
    Lock,
    /// Cadeado aberto: o widget está destrancado.
    Unlock,
}

pub fn window_button(ui: &mut egui::Ui, glyph: Glyph) -> Response {
    icon_button(ui, glyph, 0.0)
}

/// Id fixo de um botão da barra da janela principal (minimizar, maximizar, fechar), para ele poder ser achado
/// de fora da barra, como nos testes que clicam nele.
pub fn main_button_id(glyph: Glyph) -> egui::Id {
    egui::Id::unique(("botao_da_janela_principal", glyph as u8))
}

/// Botão de ícone desenhado em código. `spin` gira o ícone (em radianos; só o `Refresh`).
pub fn icon_button(ui: &mut egui::Ui, glyph: Glyph, spin: f32) -> Response {
    icon_button_id(ui, glyph, spin, None)
}

/// Como [`icon_button`], mas com um id fixo em vez do automático, quando `id` é dado.
pub fn icon_button_id(ui: &mut egui::Ui, glyph: Glyph, spin: f32, id: Option<egui::Id>) -> Response {
    let (rect, resp) = match id {
        Some(id) => {
            let (rect, _) = ui.allocate_exact_size(vec2(36.0, 28.0), Sense::hover());
            (rect, ui.interact(rect, id, Sense::click()))
        }
        None => ui.allocate_exact_size(vec2(36.0, 28.0), Sense::click()),
    };
    let hot = resp.hovered();
    let bg = match (hot, glyph) {
        (true, Glyph::Close) => Some(Color32::from_rgb(200, 60, 70)),
        (true, Glyph::Trash) => Some(Color32::from_rgba_unmultiplied(200, 60, 70, 90)),
        (true, _) => Some(Color32::from_white_alpha(22)),
        _ => None,
    };
    if let Some(bg) = bg {
        ui.painter().rect_filled(rect.shrink2(vec2(2.0, 0.0)), 7.0, bg);
    }
    let col = if hot { Color32::WHITE } else { Color32::from_gray(185) };
    paint_glyph(ui.painter(), rect.center(), glyph, col, spin);
    resp
}

/// Desenha um ícone centrado em `c`, sem fundo nem área de clique.
pub fn paint_glyph(p: &egui::Painter, c: Pos2, glyph: Glyph, col: Color32, spin: f32) {
    let st = Stroke::new(1.4, col);
    match glyph {
        Glyph::ChevronRight => {
            p.line_segment([c + vec2(-2.5, -5.0), c + vec2(2.5, 0.0)], st);
            p.line_segment([c + vec2(-2.5, 5.0), c + vec2(2.5, 0.0)], st);
        }
        Glyph::Back => {
            p.line_segment([c + vec2(-6.0, 0.0), c + vec2(6.0, 0.0)], st);
            p.line_segment([c + vec2(-6.0, 0.0), c + vec2(-1.5, -4.5)], st);
            p.line_segment([c + vec2(-6.0, 0.0), c + vec2(-1.5, 4.5)], st);
        }
        Glyph::Plus => {
            p.line_segment([c + vec2(-5.5, 0.0), c + vec2(5.5, 0.0)], st);
            p.line_segment([c + vec2(0.0, -5.5), c + vec2(0.0, 5.5)], st);
        }
        Glyph::Today => {
            p.circle_stroke(c, 3.2, st);
            for i in 0..8 {
                let a = i as f32 * std::f32::consts::FRAC_PI_4;
                let d = vec2(a.cos(), a.sin());
                p.line_segment([c + d * 5.2, c + d * 7.0], st);
            }
        }
        Glyph::Upcoming => {
            p.rect_stroke(Rect::from_center_size(c + vec2(0.0, 0.5), vec2(13.0, 12.0)), 2.5, st, egui::StrokeKind::Middle);
            p.line_segment([c + vec2(-6.5, -2.0), c + vec2(6.5, -2.0)], st);
            p.line_segment([c + vec2(-3.0, -7.0), c + vec2(-3.0, -4.0)], st);
            p.line_segment([c + vec2(3.0, -7.0), c + vec2(3.0, -4.0)], st);
        }
        Glyph::All => {
            for y in [-4.5, 0.0, 4.5] {
                p.circle_filled(c + vec2(-5.5, y), 1.1, col);
                p.line_segment([c + vec2(-2.5, y), c + vec2(6.5, y)], st);
            }
        }
        Glyph::Done => {
            p.circle_stroke(c, 6.8, st);
            p.line_segment([c + vec2(-3.2, 0.2), c + vec2(-0.8, 2.6)], st);
            p.line_segment([c + vec2(-0.8, 2.6), c + vec2(3.4, -2.6)], st);
        }
        Glyph::Grip => {
            for x in [-2.0, 2.0] {
                for y in [-4.0, 0.0, 4.0] {
                    p.circle_filled(c + vec2(x, y), 0.95, col);
                }
            }
        }
        Glyph::Bell => {
            let pts = vec![c + vec2(-3.6, 2.4), c + vec2(-3.0, -2.0), c + vec2(-1.4, -4.0), c + vec2(1.4, -4.0), c + vec2(3.0, -2.0), c + vec2(3.6, 2.4)];
            p.add(egui::Shape::line(pts, Stroke::new(1.1, col)));
            p.line_segment([c + vec2(-4.8, 2.6), c + vec2(4.8, 2.6)], Stroke::new(1.1, col));
            p.circle_filled(c + vec2(0.0, 4.3), 0.9, col);
        }
        Glyph::Repeat => {
            let r = 4.2;
            let thin = Stroke::new(1.1, col);
            for start in [0.3f32, 0.3 + std::f32::consts::PI] {
                let pts: Vec<_> = (0..=8).map(|i| {
                    let a = start + 2.4 * i as f32 / 8.0;
                    c + vec2(a.cos(), a.sin()) * r
                }).collect();
                let tip = pts[8];
                let a = start + 2.4;
                let (dir, out) = (vec2(-a.sin(), a.cos()), vec2(a.cos(), a.sin()));
                p.add(egui::Shape::line(pts, thin));
                p.line_segment([tip + dir * 1.2, tip - dir * 1.2 + out * 2.0], thin);
                p.line_segment([tip + dir * 1.2, tip - dir * 1.2 - out * 2.0], thin);
            }
        }
        Glyph::Cloud => {
            // Três arcos e a base; os ângulos crescem no sentido horário, com o y da tela para baixo.
            for (center, r, from, to) in [
                (vec2(-4.4, 1.4), 3.0f32, 90.0f32, 285.0f32),
                (vec2(0.0, -1.0), 4.2, 195.0, 340.0),
                (vec2(4.6, 1.7), 2.7, 255.0, 450.0),
            ] {
                let pts: Vec<_> = (0..=10)
                    .map(|i| {
                        let a = (from + (to - from) * i as f32 / 10.0).to_radians();
                        c + center + vec2(a.cos(), a.sin()) * r
                    })
                    .collect();
                p.add(egui::Shape::line(pts, st));
            }
            p.line_segment([c + vec2(-4.4, 4.4), c + vec2(4.6, 4.4)], st);
        }
        Glyph::Lock | Glyph::Unlock => {
            // Argola: meia circunferência por cima do corpo. Fechada, as duas pernas descem até o corpo;
            // aberta, ela sobe e só a perna da direita continua presa.
            let open = glyph == Glyph::Unlock;
            let ring = if open { vec2(0.0, -3.0) } else { vec2(0.0, -0.5) };
            let arc: Vec<Pos2> = (0..=10)
                .map(|i| {
                    let a = std::f32::consts::PI * (1.0 + i as f32 / 10.0);
                    c + ring + vec2(a.cos(), a.sin()) * 3.0
                })
                .collect();
            p.add(egui::Shape::line(arc, st));
            p.line_segment([c + ring + vec2(3.0, 0.0), c + vec2(3.0, -0.5)], st);
            if !open {
                p.line_segment([c + ring + vec2(-3.0, 0.0), c + vec2(-3.0, -0.5)], st);
            }
            p.rect_filled(Rect::from_min_max(c + vec2(-4.8, -0.5), c + vec2(4.8, 5.8)), 1.6, col);
        }
        Glyph::Check => {
            let thin = Stroke::new(1.3, col);
            p.line_segment([c + vec2(-3.8, 0.2), c + vec2(-1.0, 3.0)], thin);
            p.line_segment([c + vec2(-1.0, 3.0), c + vec2(4.0, -3.0)], thin);
        }
        Glyph::Minimize => {
            p.line_segment([c + vec2(-5.0, 3.0), c + vec2(5.0, 3.0)], st);
        }
        Glyph::Maximize => {
            p.rect_stroke(Rect::from_center_size(c, vec2(10.0, 10.0)), 2.0, st, egui::StrokeKind::Middle);
        }
        Glyph::Restore => {
            p.rect_stroke(Rect::from_center_size(c + vec2(-1.0, 1.0), vec2(8.0, 8.0)), 2.0, st, egui::StrokeKind::Middle);
            p.line_segment([c + vec2(-1.0, -4.5), c + vec2(5.0, -4.5)], st);
            p.line_segment([c + vec2(5.0, -4.5), c + vec2(5.0, 2.0)], st);
        }
        Glyph::Close => {
            p.line_segment([c + vec2(-5.0, -5.0), c + vec2(5.0, 5.0)], st);
            p.line_segment([c + vec2(-5.0, 5.0), c + vec2(5.0, -5.0)], st);
        }
        Glyph::Refresh => {
            // Arco de 280° com ponta de seta: o símbolo universal de atualizar.
            let r = 6.0;
            let a0 = spin - 1.0;
            let a1 = a0 + 4.9;
            let pt = |a: f32| c + vec2(a.cos(), a.sin()) * r;
            let pts: Vec<_> = (0..=18).map(|i| pt(a0 + (a1 - a0) * i as f32 / 18.0)).collect();
            p.add(egui::Shape::line(pts, st));
            let tip = pt(a1);
            let dir = vec2(-a1.sin(), a1.cos());
            let out = vec2(a1.cos(), a1.sin());
            p.add(egui::Shape::convex_polygon(
                vec![tip + dir * 4.0, tip + out * 3.4 - dir * 0.8, tip - out * 3.4 - dir * 0.8],
                col,
                Stroke::NONE,
            ));
        }
        Glyph::SortUp | Glyph::SortDown => {
            let s = if glyph == Glyph::SortUp { -1.0 } else { 1.0 };
            p.line_segment([c + vec2(0.0, -6.0 * s), c + vec2(0.0, 6.0 * s)], st);
            p.line_segment([c + vec2(-4.5, 1.5 * s), c + vec2(0.0, 6.0 * s)], st);
            p.line_segment([c + vec2(4.5, 1.5 * s), c + vec2(0.0, 6.0 * s)], st);
        }
        Glyph::ChevronUp | Glyph::ChevronDown => {
            let s = if glyph == Glyph::ChevronUp { -1.0 } else { 1.0 };
            p.line_segment([c + vec2(-5.0, -2.5 * s), c + vec2(0.0, 2.5 * s)], st);
            p.line_segment([c + vec2(5.0, -2.5 * s), c + vec2(0.0, 2.5 * s)], st);
        }
        Glyph::Trash => {
            p.line_segment([c + vec2(-6.0, -4.0), c + vec2(6.0, -4.0)], st); // tampa
            p.rect_stroke(Rect::from_min_max(c + vec2(-2.0, -6.5), c + vec2(2.0, -4.0)), 1.0, st, egui::StrokeKind::Middle); // alça
            p.add(egui::Shape::closed_line(
                vec![c + vec2(-4.6, -2.0), c + vec2(4.6, -2.0), c + vec2(3.8, 6.5), c + vec2(-3.8, 6.5)],
                st,
            )); // corpo
            let thin = Stroke::new(1.1, col);
            p.line_segment([c + vec2(-1.5, 0.0), c + vec2(-1.3, 4.5)], thin);
            p.line_segment([c + vec2(1.5, 0.0), c + vec2(1.3, 4.5)], thin);
        }
    }
}

/// Área de layout com limite próprio: o que passar de `rect` é cortado, em vez de invadir o vizinho.
pub fn region<R>(ui: &mut egui::Ui, rect: Rect, salt: impl std::hash::Hash + std::fmt::Debug, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let builder = egui::UiBuilder::new().id_salt(salt).max_rect(rect).layout(egui::Layout::top_down(egui::Align::Min));
    let mut child = ui.new_child(builder);
    child.set_clip_rect(rect.intersect(ui.clip_rect()));
    add(&mut child)
}

pub fn close_button(ui: &mut egui::Ui) -> Response {
    window_button(ui, Glyph::Close)
}

/// Sem isto, o winit reserva 1 px no topo das janelas sem decoração (para ter a sombra do sistema), e o
/// Windows pinta esse pixel de preto: era a linha preta acima do widget. Aqui a janela inteira vira área útil.
/// Maximizada, a janela segue a regra do winit, que limita o tamanho à área de trabalho do monitor.
unsafe extern "system" fn no_top_line(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    unsafe {
        if msg == WM_NCCALCSIZE && wparam != 0 && IsZoomed(hwnd) == 0 {
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// Tira da janela a moldura que o Windows desenha em janelas sem decoração (sombra, borda e a linha preta
/// de 1 px no topo), que aparecia atrás dos cantos arredondados. Retorna `false` se a janela ainda não existe.
/// Deve ser chamada na thread da janela (a da interface).
pub fn flatten_window(title: &str) -> bool {
    use std::ffi::c_void;
    use windows_sys::Win32::Graphics::Dwm::{DwmExtendFrameIntoClientArea, DwmSetWindowAttribute};
    use windows_sys::Win32::UI::Controls::MARGINS;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    let Some(hwnd) = find_window(title) else { return false };
    unsafe {
        let none = MARGINS { cxLeftWidth: 0, cxRightWidth: 0, cyTopHeight: 0, cyBottomHeight: 0 };
        DwmExtendFrameIntoClientArea(hwnd, &none);
        // DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED; DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND.
        let one: i32 = 1;
        DwmSetWindowAttribute(hwnd, 2, &one as *const i32 as *const c_void, 4);
        DwmSetWindowAttribute(hwnd, 33, &one as *const i32 as *const c_void, 4);
        // Passa a responder o cálculo da moldura e pede para o Windows refazê-lo já.
        SetWindowSubclass(hwnd, Some(no_top_line), 1, 0);
        SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    }
    true
}

/// Faz a janela de título `title` não ser ativada por cliques: usar a janela não tira o foco do programa em
/// que a pessoa está trabalhando (o widget e a lista de tarefas flutuam sobre ele). Retorna `false` se a janela
/// ainda não existe.
pub fn no_activate(title: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_NOACTIVATE};

    let Some(hwnd) = find_window(title) else { return false };
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE as isize);
    }
    true
}

/// Área de trabalho (a tela sem a barra de tarefas) do monitor em que está a janela de título `title`, em pontos
/// do egui. `None` se a janela ainda não existe. Serve para uma janela que acompanha outra não sair da tela.
pub fn work_area(title: &str, pixels_per_point: f32) -> Option<Rect> {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};

    let hwnd = find_window(title)?;
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let (r, k) = (info.rcWork, pixels_per_point.max(0.1));
        Some(Rect::from_min_max(egui::pos2(r.left as f32 / k, r.top as f32 / k), egui::pos2(r.right as f32 / k, r.bottom as f32 / k)))
    }
}

/// As oito faixas finas nas bordas e cantos que iniciam o redimensionamento: (área, lado, cursor).
pub fn handle_zones(full: Rect) -> [(Rect, Dir, CursorIcon); 8] {
    let (e, c) = (5.0, 12.0);
    [
        (Rect::from_min_max(full.left_top() + vec2(c, 0.0), full.right_top() + vec2(-c, e)), Dir::North, CursorIcon::ResizeVertical),
        (Rect::from_min_max(full.left_bottom() + vec2(c, -e), full.right_bottom() + vec2(-c, 0.0)), Dir::South, CursorIcon::ResizeVertical),
        (Rect::from_min_max(full.left_top() + vec2(0.0, c), full.left_bottom() + vec2(e, -c)), Dir::West, CursorIcon::ResizeHorizontal),
        (Rect::from_min_max(full.right_top() + vec2(-e, c), full.right_bottom() + vec2(0.0, -c)), Dir::East, CursorIcon::ResizeHorizontal),
        (Rect::from_min_size(full.left_top(), vec2(c, c)), Dir::NorthWest, CursorIcon::ResizeNwSe),
        (Rect::from_min_size(full.right_top() + vec2(-c, 0.0), vec2(c, c)), Dir::NorthEast, CursorIcon::ResizeNeSw),
        (Rect::from_min_size(full.left_bottom() + vec2(0.0, -c), vec2(c, c)), Dir::SouthWest, CursorIcon::ResizeNeSw),
        (Rect::from_min_size(full.right_bottom() - vec2(c, c), vec2(c, c)), Dir::SouthEast, CursorIcon::ResizeNwSe),
    ]
}

/// Faixas finas nas bordas e cantos que iniciam o redimensionamento (feito pelo Windows).
pub fn resize_handles(ui: &mut egui::Ui, full: Rect) {
    for (i, (rect, dir, cursor)) in handle_zones(full).into_iter().enumerate() {
        let r = ui.interact(rect, ui.scope_id().with(("resize", i)), Sense::drag());
        if r.hovered() || r.dragged() {
            ui.ctx().set_cursor_icon(cursor);
        }
        if r.drag_started() {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::BeginResize(dir));
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Mover e redimensionar uma janela por conta própria. O arrasto do sistema (o que o egui pede com StartDrag e
// BeginResize) entra num laço do Windows que não começa em janelas que não podem ser ativadas, como o widget:
// ele abria num ponto e não saía dele. Aqui a janela segue o ponteiro com SetWindowPos, em pixels da tela.

/// Retângulo em pixels da tela, como o Windows os conta: `[esquerda, topo, direita, base]`.
pub type PxRect = [i32; 4];

/// A janela de título `title` criada por esta thread (a da interface, dona de todas as janelas do app).
///
/// Não usa `FindWindowW`: ele procura em todos os processos e devolve a primeira janela com esse título na ordem
/// de empilhamento, que pode ser de outro programa, como uma janela do Explorer aberta numa pasta chamada
/// "N.avi" (a pasta de instalação se chama assim) ou uma segunda cópia do próprio app. Esconder ou mover a
/// janela errada deixava o botão de minimizar "sem efeito" e podia sumir com a janela de verdade.
pub fn find_window(title: &str) -> Option<HWND> {
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumThreadWindows, InternalGetWindowText};

    struct Search {
        wanted: Vec<u16>,
        found: HWND,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        // SAFETY: `lparam` é o ponteiro para o `Search` desta chamada, vivo até `EnumThreadWindows` voltar.
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut buf = vec![0u16; search.wanted.len() + 2];
        // Lê o título guardado pelo sistema, sem mandar mensagem à janela (que está no meio de um quadro).
        let len = unsafe { InternalGetWindowText(hwnd, buf.as_mut_ptr(), buf.len() as i32) } as usize;
        if len == search.wanted.len() && buf[..len] == search.wanted[..] {
            search.found = hwnd;
            return 0;
        }
        1
    }
    let mut search = Search { wanted: title.encode_utf16().collect(), found: std::ptr::null_mut() };
    unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(each), &mut search as *mut Search as LPARAM) };
    (!search.found.is_null()).then_some(search.found)
}

fn px_rect(r: windows_sys::Win32::Foundation::RECT) -> PxRect {
    [r.left, r.top, r.right, r.bottom]
}

/// Onde está, na tela, a janela de título `title`.
pub fn window_rect(title: &str) -> Option<PxRect> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = find_window(title)?;
    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    (unsafe { GetWindowRect(hwnd, &mut r) } != 0).then(|| px_rect(r))
}

/// Onde está o ponteiro do mouse, em pixels da tela.
pub fn cursor_pos() -> Option<[i32; 2]> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut pt) } != 0).then_some([pt.x, pt.y])
}

/// O botão do mouse está apertado agora, segundo o sistema (não o egui). Com a janela sem ativação e o app na
/// bandeja, soltar o botão com o ponteiro fora do widget pode não chegar até ele; quem arrasta confere por aqui.
/// `None` para um botão que não serve de arrasto. O botão principal é o da direita se o mouse for de canhoto.
pub fn button_down(button: egui::PointerButton) -> Option<bool> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    let key = match button {
        egui::PointerButton::Primary if swapped => VK_RBUTTON,
        egui::PointerButton::Primary => VK_LBUTTON,
        egui::PointerButton::Middle => VK_MBUTTON,
        _ => return None,
    };
    // O bit mais alto (número negativo) diz que a tecla está apertada agora.
    Some(unsafe { GetAsyncKeyState(key as i32) } < 0)
}

/// Põe a janela de título `title` em `rect`, sem ativá-la nem mudar a ordem das janelas.
pub fn set_window_rect(title: &str, rect: PxRect) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos};

    let Some(hwnd) = find_window(title) else { return false };
    let (w, h) = ((rect[2] - rect[0]).max(1), (rect[3] - rect[1]).max(1));
    unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), rect[0], rect[1], w, h, SWP_NOZORDER | SWP_NOACTIVATE) != 0 }
}

/// Leva a janela de título `title` para o canto `(x, y)`, sem mudar o tamanho.
pub fn move_window(title: &str, x: i32, y: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos};

    let Some(hwnd) = find_window(title) else { return false };
    unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) != 0 }
}

/// Área de trabalho (a tela sem a barra de tarefas) do monitor onde `rect` aparece mais; se nenhum monitor
/// o contém (o monitor que estava ali foi desligado), a do monitor mais próximo.
pub fn work_area_of(rect: PxRect) -> Option<PxRect> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect};

    let r = RECT { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] };
    unsafe {
        let monitor = MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        (GetMonitorInfoW(monitor, &mut info) != 0).then(|| px_rect(info.rcWork))
    }
}

/// Área de trabalho do monitor principal.
pub fn primary_work_area() -> Option<PxRect> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SPI_GETWORKAREA, SystemParametersInfoW};

    let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    (unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut c_void, 0) } != 0).then(|| px_rect(r))
}

/// O canto superior esquerdo mais próximo de `pos` com a janela (de `size` pixels) toda dentro de `work`.
pub fn fit_in(pos: [i32; 2], size: [i32; 2], work: PxRect) -> [i32; 2] {
    let max_x = (work[2] - size[0]).max(work[0]);
    let max_y = (work[3] - size[1]).max(work[1]);
    [pos[0].clamp(work[0], max_x), pos[1].clamp(work[1], max_y)]
}

/// Canto superior direito da área de trabalho, com uma margem: onde o widget aparece na primeira vez.
pub fn corner_pos(size: [i32; 2], work: PxRect, margin: i32) -> [i32; 2] {
    fit_in([work[2] - size[0] - margin, work[1] + margin], size, work)
}

/// Para onde vai a janela quando o ponteiro anda de `from` para `now`, tendo ela começado em `origin`.
pub fn drag_target(origin: [i32; 2], from: [i32; 2], now: [i32; 2]) -> [i32; 2] {
    [origin[0] + now[0] - from[0], origin[1] + now[1] - from[1]]
}

/// A janela `rect` depois de a borda ou o canto `dir` ser puxado por `(dx, dy)` pixels; nunca menor que `min`
/// (a borda que se move é a que para).
pub fn resized(rect: PxRect, dir: Dir, (dx, dy): (i32, i32), min: [i32; 2]) -> PxRect {
    let [mut left, mut top, mut right, mut bottom] = rect;
    let west = matches!(dir, Dir::West | Dir::NorthWest | Dir::SouthWest);
    let east = matches!(dir, Dir::East | Dir::NorthEast | Dir::SouthEast);
    let north = matches!(dir, Dir::North | Dir::NorthWest | Dir::NorthEast);
    let south = matches!(dir, Dir::South | Dir::SouthWest | Dir::SouthEast);
    if west {
        left += dx;
    }
    if east {
        right += dx;
    }
    if north {
        top += dy;
    }
    if south {
        bottom += dy;
    }
    if right - left < min[0] {
        if west {
            left = right - min[0];
        } else {
            right = left + min[0];
        }
    }
    if bottom - top < min[1] {
        if north {
            top = bottom - min[1];
        } else {
            bottom = top + min[1];
        }
    }
    [left, top, right, bottom]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_acha_janelas_desta_thread() {
        // O processo dos testes não tem janela nenhuma: mesmo com um N.avi de verdade aberto na máquina (que o
        // `FindWindowW` acharia), nada é devolvido. Também não derruba quando o título não existe.
        assert_eq!(find_window(crate::brand::MAIN_TITLE), None);
        assert_eq!(find_window(crate::brand::WIDGET_TITLE), None);
        assert_eq!(find_window(""), None);
    }

    #[test]
    fn dentro_da_tela_mesmo_sem_o_monitor_de_antes() {
        let work = [0, 0, 1920, 1040];
        assert_eq!(fit_in([100, 80], [340, 190], work), [100, 80], "já cabe: não mexe");
        assert_eq!(fit_in([2500, 80], [340, 190], work), [1580, 80], "monitor desligado à direita");
        assert_eq!(fit_in([-1800, -300], [340, 190], work), [0, 0], "monitor desligado à esquerda e acima");
        assert_eq!(fit_in([1800, 1000], [340, 190], work), [1580, 850], "passou da borda de baixo e da direita");
        // Janela maior que a tela: fica no canto de cima, sem erro.
        assert_eq!(fit_in([50, 50], [3000, 2000], work), [0, 0]);
        // Segundo monitor à esquerda, com coordenadas negativas.
        assert_eq!(fit_in([-1700, 40], [340, 190], [-1920, 0, 0, 1040]), [-1700, 40]);
    }

    #[test]
    fn canto_de_partida_do_widget() {
        assert_eq!(corner_pos([340, 190], [0, 0, 1920, 1040], 24), [1556, 24]);
        assert_eq!(corner_pos([340, 190], [0, 40, 1920, 1080], 24), [1556, 64], "barra de tarefas no topo");
    }

    #[test]
    fn so_os_botoes_de_arrasto_tem_estado() {
        // O botão da direita (menu) não serve de arrasto; os outros devolvem algum estado, sem erro.
        assert_eq!(button_down(egui::PointerButton::Secondary), None);
        assert!(button_down(egui::PointerButton::Primary).is_some());
        assert!(button_down(egui::PointerButton::Middle).is_some());
    }

    #[test]
    fn arrastar_acompanha_o_ponteiro() {
        assert_eq!(drag_target([500, 300], [900, 700], [950, 640]), [550, 240]);
        assert_eq!(drag_target([500, 300], [900, 700], [900, 700]), [500, 300]);
    }

    #[test]
    fn redimensionar_pela_borda_e_pelo_canto() {
        let r = [100, 100, 440, 290];
        assert_eq!(resized(r, Dir::East, (30, 99), [90, 24]), [100, 100, 470, 290], "a borda de lado só mexe na largura");
        assert_eq!(resized(r, Dir::West, (-20, 5), [90, 24]), [80, 100, 440, 290]);
        assert_eq!(resized(r, Dir::South, (7, 15), [90, 24]), [100, 100, 440, 305]);
        assert_eq!(resized(r, Dir::NorthWest, (10, 10), [90, 24]), [110, 110, 440, 290]);
        assert_eq!(resized(r, Dir::SouthEast, (-10, -10), [90, 24]), [100, 100, 430, 280]);
        // Nunca menor que o mínimo, e a borda que se move é a que para.
        assert_eq!(resized(r, Dir::East, (-1000, 0), [90, 24]), [100, 100, 190, 290]);
        assert_eq!(resized(r, Dir::West, (1000, 0), [90, 24]), [350, 100, 440, 290]);
        assert_eq!(resized(r, Dir::North, (0, 1000), [90, 24]), [100, 266, 440, 290]);
        assert_eq!(resized(r, Dir::South, (0, -1000), [90, 24]), [100, 100, 440, 124]);
    }
}
