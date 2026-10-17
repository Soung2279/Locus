use crate::protocol::*;
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::*,
        Graphics::{
            Direct3D::*,
            Direct3D11::*,
            Dxgi::{Common::*, *},
            Gdi::*,
        },
        System::{LibraryLoader::GetModuleHandleW, Threading::*},
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub rect: Rect,
    pub clip: Rect,
    pub occluders: Vec<Rect>,
    pub visible: bool,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub state: String,
    pub error: Option<String>,
    pub width: u32,
    pub height: u32,
    pub generation: u64,
    pub frames: u64,
    pub stale_frames: u64,
    pub inputs: u64,
    pub last_present_qpc: u64,
    pub input_to_present_p95_ms: Option<f64>,
}

struct Control {
    layout: Layout,
    touched: Instant,
    revision: u64,
}
pub struct Surface {
    control: Arc<Mutex<Control>>,
    stats: Arc<Mutex<Stats>>,
    stop: Arc<AtomicBool>,
    wake: Arc<Handle>,
    thread: Option<JoinHandle<()>>,
}
impl Surface {
    /// Parent HWND is supplied by the trusted host, never by View JavaScript.
    pub fn start(id: String, parent: usize, layout: Layout) -> Result<Self, String> {
        validate_layout(&layout)?;
        let connection = Arc::new(Connection::new(&id, false)?);
        let wake = Arc::new(event(&format!("Local\\LocusRender_{id}_control"))?);
        if connection.header().attached.swap(1, Ordering::AcqRel) != 0 {
            return Err("Output already has a mounted surface".into());
        }
        let control = Arc::new(Mutex::new(Control {
            layout,
            touched: Instant::now(),
            revision: 1,
        }));
        let stats = Arc::new(Mutex::new(Stats {
            state: "waiting".into(),
            ..Default::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let (c, s, st, w, conn) = (
            control.clone(),
            stats.clone(),
            stop.clone(),
            wake.clone(),
            connection.clone(),
        );
        let thread = std::thread::Builder::new()
            .name("locus-gpu-surface".into())
            .spawn(move || {
                let result = unsafe { run(&id, parent, conn.clone(), &c, &s, &st, &w) };
                conn.header().visible.store(0, RELEASE);
                conn.header().attached.store(0, RELEASE);
                conn.header().input.push(InputEvent {
                    kind: 7,
                    timestamp: qpc(),
                    ..Default::default()
                });
                conn.wake_unity();
                if let Ok(mut stats) = s.lock() {
                    match result {
                        Ok(()) => stats.state = "detached".into(),
                        Err(error) => {
                            stats.state = "failed".into();
                            stats.error = Some(error);
                        }
                    }
                }
            })
            .map_err(|error| {
                connection.header().attached.store(0, RELEASE);
                err(error)
            })?;
        Ok(Self {
            control,
            stats,
            stop,
            wake,
            thread: Some(thread),
        })
    }
    pub fn update(&self, layout: Layout) -> Result<(), String> {
        validate_layout(&layout)?;
        let mut control = self.control.lock().map_err(err)?;
        control.touched = Instant::now();
        if control.layout != layout {
            control.layout = layout;
            control.revision += 1;
        }
        unsafe {
            let _ = SetEvent(self.wake.0);
        }
        Ok(())
    }
    pub fn status(&self) -> Stats {
        if let Ok(mut c) = self.control.lock() {
            c.touched = Instant::now();
        }
        self.stats.lock().map(|s| s.clone()).unwrap_or_default()
    }
    /// Call from a worker, never from the parent HWND message-pump thread.
    pub fn stop_and_join(mut self) {
        self.stop.store(true, RELEASE);
        unsafe {
            let _ = SetEvent(self.wake.0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
// Drop is nonblocking: child destruction and Present can require its parent UI
// thread. Hosts that need a completion barrier use stop_and_join off that thread.
impl Drop for Surface {
    fn drop(&mut self) {
        self.stop.store(true, RELEASE);
        unsafe {
            let _ = SetEvent(self.wake.0);
        }
        self.thread.take();
    }
}
pub fn close_output(id: &str) {
    if let Ok(connection) = Connection::new(id, false) {
        connection.close();
    }
}
pub fn touch_output(id: &str) {
    if let Ok(connection) = Connection::new(id, false) {
        connection.header().consumer_heartbeat.store(qpc(), RELEASE);
    }
}
pub fn validate_layout(layout: &Layout) -> Result<(), String> {
    if layout.occluders.len() > 64 {
        return Err("Too many native surface occluders".into());
    }
    for r in std::iter::once(&layout.rect)
        .chain(std::iter::once(&layout.clip))
        .chain(layout.occluders.iter())
    {
        if r.x.unsigned_abs() > 100000
            || r.y.unsigned_abs() > 100000
            || r.width > 16384
            || r.height > 16384
        {
            return Err("Invalid native surface bounds".into());
        }
    }
    Ok(())
}

struct WindowState {
    connection: Arc<Connection>,
    stop: Arc<AtomicBool>,
    buttons: Cell<u32>,
    last: Cell<(f32, f32)>,
}
unsafe fn modifiers() -> u32 {
    u32::from(GetKeyState(VK_SHIFT.0 as i32) < 0)
        | (u32::from(GetKeyState(VK_CONTROL.0 as i32) < 0) << 1)
        | (u32::from(GetKeyState(VK_MENU.0 as i32) < 0) << 2)
}
unsafe fn push(
    state: &WindowState,
    hwnd: HWND,
    kind: u32,
    key: u32,
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
) {
    let mut bounds = RECT::default();
    let _ = GetClientRect(hwnd, &mut bounds);
    let h = state.connection.header();
    let sequence = h.next_input_sequence.fetch_add(1, RELAXED) + 1;
    h.input.push(InputEvent {
        sequence,
        timestamp: qpc(),
        kind,
        key,
        buttons: state.buttons.get(),
        modifiers: modifiers(),
        x,
        y,
        dx,
        dy,
        width: bounds.right.max(0) as u32,
        height: bounds.bottom.max(0) as u32,
        reserved: 0,
    });
    h.frame_request.fetch_add(1, RELEASE);
    state.connection.wake_unity();
}
unsafe fn cancel(state: &WindowState, hwnd: HWND) {
    state.buttons.set(0);
    push(
        state,
        hwnd,
        7,
        0,
        state.last.get().0,
        state.last.get().1,
        0.,
        0.,
    );
    if GetCapture() == hwnd {
        let _ = ReleaseCapture();
    }
}
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if msg == WM_NCCREATE {
        let create = &*(l.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowState;
    if !pointer.is_null() {
        let state = &*pointer;
        match msg {
            WM_DESTROY => {
                cancel(state, hwnd);
                state.stop.store(true, RELEASE);
            }
            WM_KILLFOCUS | WM_CANCELMODE => {
                cancel(state, hwnd);
            }
            WM_CAPTURECHANGED if state.buttons.get() != 0 => {
                state.buttons.set(0);
                push(
                    state,
                    hwnd,
                    7,
                    0,
                    state.last.get().0,
                    state.last.get().1,
                    0.,
                    0.,
                );
            }
            WM_SETFOCUS => {
                push(
                    state,
                    hwnd,
                    8,
                    0,
                    state.last.get().0,
                    state.last.get().1,
                    0.,
                    0.,
                );
            }
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP => {
                push(
                    state,
                    hwnd,
                    if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                        5
                    } else {
                        6
                    },
                    w.0 as u32,
                    state.last.get().0,
                    state.last.get().1,
                    0.,
                    0.,
                );
                return LRESULT(0);
            }
            WM_MOUSEMOVE | WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP
            | WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MOUSEWHEEL | WM_MOUSEHWHEEL => {
                let mut point = POINT {
                    x: (l.0 as u32 & 0xffff) as i16 as i32,
                    y: ((l.0 as u32 >> 16) & 0xffff) as i16 as i32,
                };
                let wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
                if wheel {
                    let _ = ScreenToClient(hwnd, &mut point);
                }
                let mut rect = RECT::default();
                let _ = GetClientRect(hwnd, &mut rect);
                let x = point.x as f32 / rect.right.max(1) as f32;
                let y = point.y as f32 / rect.bottom.max(1) as f32;
                let (kind, button) = match msg {
                    WM_LBUTTONDOWN => (2, 1),
                    WM_RBUTTONDOWN => (2, 2),
                    WM_MBUTTONDOWN => (2, 4),
                    WM_LBUTTONUP => (3, 1),
                    WM_RBUTTONUP => (3, 2),
                    WM_MBUTTONUP => (3, 4),
                    WM_MOUSEWHEEL | WM_MOUSEHWHEEL => (4, 0),
                    _ => (1, 0),
                };
                if kind == 2 {
                    state.buttons.set(state.buttons.get() | button);
                    let _ = SetFocus(Some(hwnd));
                    SetCapture(hwnd);
                }
                if kind == 3 {
                    state.buttons.set(state.buttons.get() & !button);
                }
                let amount = ((w.0 >> 16) & 0xffff) as i16 as f32 / 120.;
                let (dx, dy) = if wheel {
                    if msg == WM_MOUSEHWHEEL {
                        (amount, 0.)
                    } else {
                        (0., amount)
                    }
                } else {
                    (x - state.last.get().0, y - state.last.get().1)
                };
                state.last.set((x, y));
                push(state, hwnd, kind, button, x, y, dx, dy);
                if kind == 3 && state.buttons.get() == 0 && GetCapture() == hwnd {
                    let _ = ReleaseCapture();
                }
                return LRESULT(0);
            }
            WM_ERASEBKGND => return LRESULT(1),
            _ => {}
        }
    }
    DefWindowProcW(hwnd, msg, w, l)
}
struct Window(HWND);
impl Drop for Window {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
unsafe fn window(parent: usize, state: &WindowState) -> Result<Window, String> {
    let instance = GetModuleHandleW(None).map_err(err)?;
    let class = wide("LocusGpuRenderSurface");
    RegisterClassW(&WNDCLASSW {
        lpfnWndProc: Some(wndproc),
        hInstance: instance.into(),
        lpszClassName: PCWSTR(class.as_ptr()),
        hCursor: LoadCursorW(None, IDC_ARROW).map_err(err)?,
        ..Default::default()
    });
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        PCWSTR(class.as_ptr()),
        PCWSTR(class.as_ptr()),
        WS_CHILD | WS_CLIPSIBLINGS,
        0,
        0,
        1,
        1,
        Some(HWND(parent as *mut _)),
        None,
        Some(instance.into()),
        Some(state as *const _ as _),
    )
    .map_err(err)?;
    Ok(Window(hwnd))
}
unsafe fn set_layout(hwnd: HWND, layout: &Layout) -> Result<(), String> {
    let r = layout.rect;
    SetWindowPos(
        hwnd,
        Some(HWND_TOP),
        r.x,
        r.y,
        r.width.max(1) as i32,
        r.height.max(1) as i32,
        SWP_NOACTIVATE,
    )
    .map_err(err)?;
    let clip = layout.clip;
    let region = CreateRectRgn(
        clip.x - r.x,
        clip.y - r.y,
        clip.x - r.x + clip.width as i32,
        clip.y - r.y + clip.height as i32,
    );
    if region.is_invalid() {
        return Err("Cannot create surface clip".into());
    }
    for cut in &layout.occluders {
        let hole = CreateRectRgn(
            cut.x - r.x,
            cut.y - r.y,
            cut.x - r.x + cut.width as i32,
            cut.y - r.y + cut.height as i32,
        );
        CombineRgn(Some(region), Some(region), Some(hole), RGN_DIFF);
        let _ = DeleteObject(hole.into());
    }
    if SetWindowRgn(hwnd, Some(region), true) == 0 {
        let _ = DeleteObject(region.into());
        return Err("Cannot apply surface clip".into());
    }
    let _ = ShowWindow(
        hwnd,
        if layout.visible && r.width > 0 && r.height > 0 && clip.width > 0 && clip.height > 0 {
            SW_SHOWNOACTIVATE
        } else {
            SW_HIDE
        },
    );
    Ok(())
}

struct Slot {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
}
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    swap: IDXGISwapChain1,
    adapter: u64,
    generation: u64,
    shared: Shared<GenerationHeader>,
    slots: Vec<Slot>,
    last_frame: u64,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
}
impl Gpu {
    unsafe fn open(id: &str, number: u64, hwnd: HWND) -> Result<Self, String> {
        let shared: Shared<GenerationHeader> = Shared::open(&generation_name(id, number))?;
        let h = shared.get();
        if h.magic.load(ACQUIRE) != MAGIC {
            return Err("Invalid frame generation".into());
        }
        let width = h.width.load(RELAXED) as u32;
        let height = h.height.load(RELAXED) as u32;
        let format = DXGI_FORMAT(h.format.load(RELAXED) as i32);
        if width == 0
            || height == 0
            || width > MAX_SIZE
            || height > MAX_SIZE
            || ![DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM].contains(&format)
        {
            return Err("Invalid output texture descriptor".into());
        }
        let factory: IDXGIFactory2 = CreateDXGIFactory1().map_err(err)?;
        let adapter_id = h.adapter.load(RELAXED);
        let mut index = 0;
        let adapter = loop {
            let adapter = factory
                .EnumAdapters1(index)
                .map_err(|_| "Unity GPU adapter is unavailable")?;
            if luid_bits(adapter.GetDesc1().map_err(err)?.AdapterLuid) == adapter_id {
                break adapter;
            }
            index += 1;
        };
        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(err)?;
        let device = device.ok_or("No GPU device")?;
        let context = context.ok_or("No GPU context")?;
        let slots = Self::slots(&device, id, number)?;
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Flags: DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT.0 as u32,
            ..Default::default()
        };
        let swap = factory
            .CreateSwapChainForHwnd(&device, hwnd, &desc, None, None)
            .map_err(err)?;
        swap.cast::<IDXGISwapChain2>()
            .map_err(err)?
            .SetMaximumFrameLatency(1)
            .map_err(err)?;
        factory
            .MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER)
            .map_err(err)?;
        Ok(Self {
            device,
            context,
            swap,
            adapter: adapter_id,
            generation: number,
            shared,
            slots,
            last_frame: 0,
            width,
            height,
            format,
        })
    }
    unsafe fn slots(device: &ID3D11Device, id: &str, number: u64) -> Result<Vec<Slot>, String> {
        let device: ID3D11Device1 = device.cast().map_err(err)?;
        let mut slots = Vec::new();
        for i in 0..SLOT_COUNT {
            let name = texture_name(id, number, i);
            let texture: ID3D11Texture2D = device
                .OpenSharedResourceByName(
                    PCWSTR(name.as_ptr()),
                    DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                )
                .map_err(err)?;
            slots.push(Slot {
                mutex: texture.cast().map_err(err)?,
                texture,
            });
        }
        Ok(slots)
    }
    unsafe fn adopt(&mut self, id: &str, number: u64) -> Result<(), String> {
        let shared: Shared<GenerationHeader> = Shared::open(&generation_name(id, number))?;
        let h = shared.get();
        let width = h.width.load(RELAXED) as u32;
        let height = h.height.load(RELAXED) as u32;
        let format = DXGI_FORMAT(h.format.load(RELAXED) as i32);
        if h.magic.load(ACQUIRE) != MAGIC
            || h.adapter.load(RELAXED) != self.adapter
            || width == 0
            || height == 0
            || width > MAX_SIZE
            || height > MAX_SIZE
            || ![DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM].contains(&format)
        {
            return Err(
                "Output adapter or descriptor changed incompatibly; recreate the output".into(),
            );
        }
        let slots = Self::slots(&self.device, id, number)?;
        self.context.ClearState();
        self.context.Flush();
        self.swap
            .ResizeBuffers(
                2,
                width,
                height,
                format,
                DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT,
            )
            .map_err(err)?;
        self.slots = slots;
        self.shared = shared;
        self.width = width;
        self.height = height;
        self.format = format;
        self.generation = number;
        self.last_frame = 0;
        Ok(())
    }
    unsafe fn present(&mut self, stats: &mut Stats) -> Result<Option<(u64, u64)>, String> {
        let mut selected: Option<(usize, u64)> = None;
        for (index, slot) in self.slots.iter().enumerate() {
            if !acquire(&slot.mutex, 1)? {
                continue;
            }
            let seq = self.shared.get().frames[index].sequence.load(ACQUIRE);
            if seq <= self.last_frame || selected.is_some_and(|(_, old)| old >= seq) {
                slot.mutex.ReleaseSync(0).map_err(err)?;
                stats.stale_frames += 1;
                continue;
            }
            if let Some((old, _)) = selected {
                self.slots[old].mutex.ReleaseSync(0).map_err(err)?;
                stats.stale_frames += 1;
            }
            selected = Some((index, seq));
        }
        let Some((index, seq)) = selected else {
            return Ok(None);
        };
        let slot = &self.slots[index];
        let back: Result<ID3D11Texture2D, _> = self.swap.GetBuffer(0);
        let copied = match back {
            Ok(back) => {
                self.context.CopyResource(&back, &slot.texture);
                Ok(())
            }
            Err(e) => Err(err(e)),
        };
        let frame = &self.shared.get().frames[index];
        let input = frame.input_sequence.load(RELAXED);
        let input_qpc = frame.input_qpc.load(RELAXED);
        // Snapshot metadata while we still own this slot. The producer may
        // overwrite it as soon as key 0 is released.
        slot.mutex.ReleaseSync(0).map_err(err)?;
        copied?;
        self.context.Flush();
        let time = qpc();
        let result = self.swap.Present(1, DXGI_PRESENT(0));
        if result.is_err() {
            return Err(format!("GPU Present failed: {:#x}", result.0));
        }
        self.last_frame = seq;
        stats.frames += 1;
        stats.generation = self.generation;
        stats.width = self.width;
        stats.height = self.height;
        stats.last_present_qpc = time;
        stats.state = "ready".into();
        Ok(Some((
            input,
            if input_qpc > 0 {
                time.saturating_sub(input_qpc)
            } else {
                0
            },
        )))
    }
}
unsafe fn run(
    id: &str,
    parent: usize,
    connection: Arc<Connection>,
    control: &Arc<Mutex<Control>>,
    stats: &Arc<Mutex<Stats>>,
    stop: &Arc<AtomicBool>,
    wake: &Arc<Handle>,
) -> Result<(), String> {
    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let mut state = Box::new(WindowState {
        connection: connection.clone(),
        stop: stop.clone(),
        buttons: Cell::new(0),
        last: Cell::new((0., 0.)),
    });
    let window = window(parent, &mut state)?;
    let h = connection.header();
    let mut gpu: Option<Gpu> = None;
    let mut revision = 0;
    let mut layout = Layout::default();
    let mut last_input = 0;
    let mut latencies = VecDeque::new();
    let frequency = frequency();
    let mut current_stats = Stats {
        state: "waiting".into(),
        ..Default::default()
    };
    while !stop.load(ACQUIRE) && IsWindow(Some(HWND(parent as *mut _))).as_bool() {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if h.closed.load(ACQUIRE) != 0 {
            return Err("Unity output closed or reloaded".into());
        }
        // Never hold a shared lock across HWND calls or Present: DXGI/Win32 may
        // synchronously need the parent window's message-pump thread, which can
        // itself be reading status or sending a layout update.
        let (next_layout, next_revision, touched) = {
            let control = control.lock().map_err(err)?;
            (control.layout.clone(), control.revision, control.touched)
        };
        if touched.elapsed() > Duration::from_secs(15) {
            return Err("Surface owner stopped renewing its lease".into());
        }
        if next_revision != revision {
            layout = next_layout;
            revision = next_revision;
            set_layout(window.0, &layout)?;
            h.requested_width.store(layout.rect.width as u64, RELAXED);
            h.requested_height.store(layout.rect.height as u64, RELAXED);
            h.visible.store(u64::from(layout.visible), RELEASE);
            h.frame_request.fetch_add(1, RELEASE);
            connection.wake_unity();
            if !layout.visible {
                cancel(&mut state, window.0);
            }
        }
        h.consumer_heartbeat.store(qpc(), RELEASE);
        let generation = h.generation.load(ACQUIRE);
        if generation != 0 && gpu.as_ref().map(|g| g.generation) != Some(generation) {
            // A publish can replace the announced generation while it is opening.
            let result = if let Some(gpu) = gpu.as_mut() {
                gpu.adopt(id, generation)
            } else {
                Gpu::open(id, generation, window.0).map(|new| gpu = Some(new))
            };
            if let Err(error) = result {
                if h.generation.load(ACQUIRE) == generation {
                    return Err(error);
                }
            } else {
                h.consumer_generation.store(generation, RELEASE);
            }
        }
        if layout.visible && IsWindowVisible(window.0).as_bool() {
            if let Some(gpu) = gpu.as_mut() {
                current_stats.inputs = h.next_input_sequence.load(RELAXED);
                if let Some((input, delay)) = gpu.present(&mut current_stats)? {
                    if input != 0 && input != last_input && delay != 0 {
                        last_input = input;
                        latencies.push_back(delay as f64 * 1000. / frequency);
                        if latencies.len() > 512 {
                            latencies.pop_front();
                        }
                        let mut sorted = latencies.iter().copied().collect::<Vec<_>>();
                        sorted.sort_by(f64::total_cmp);
                        current_stats.input_to_present_p95_ms =
                            Some(sorted[((sorted.len() - 1) as f64 * 0.95).ceil() as usize]);
                    }
                }
            }
        }
        *stats.lock().map_err(err)? = current_stats.clone();
        let handles = [connection.frame_event.0, wake.0];
        MsgWaitForMultipleObjectsEx(Some(&handles), 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    }
    // Window is destroyed before its userdata allocation goes out of scope.
    drop(gpu);
    drop(window);
    drop(state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_host_geometry() {
        let mut layout = Layout::default();
        layout.rect.width = 20000;
        assert!(validate_layout(&layout).is_err());
        layout.rect.width = 640;
        assert!(validate_layout(&layout).is_ok());
    }
}
