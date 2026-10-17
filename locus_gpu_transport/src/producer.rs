use crate::protocol::*;
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::*,
        Graphics::{
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
        System::Threading::*,
    },
};

struct Slot {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    _handle: Handle,
}
struct Generation {
    number: u64,
    source: ID3D11Texture2D,
    context: ID3D11DeviceContext,
    shared: Shared<GenerationHeader>,
    slots: Vec<Slot>,
}
struct Output {
    id: String,
    connection: Connection,
    generation: Mutex<Option<Arc<Generation>>>,
    previous: Mutex<Option<Arc<Generation>>>,
    next_generation: AtomicU64,
    pending: AtomicU64,
    sequence: AtomicU64,
}
struct Packet {
    owner: Arc<Output>,
    generation: Arc<Generation>,
    sequence: u64,
    input: u64,
    input_qpc: u64,
}
impl Drop for Packet {
    fn drop(&mut self) {
        self.owner.pending.fetch_sub(1, Ordering::AcqRel);
    }
}
struct Registry {
    outputs: HashMap<u64, Arc<Output>>,
    packets: HashMap<usize, Packet>,
}
fn registry() -> &'static Mutex<Registry> {
    static STATE: OnceLock<Mutex<Registry>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(Registry {
            outputs: HashMap::new(),
            packets: HashMap::new(),
        })
    })
}
fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, RELAXED)
}
fn get(handle: u64) -> Result<Arc<Output>, String> {
    registry()
        .lock()
        .map_err(err)?
        .outputs
        .get(&handle)
        .cloned()
        .ok_or_else(|| "Output is closed or belongs to an old domain".into())
}

pub fn create(id: &str) -> Result<u64, String> {
    let mut registry = registry().lock().map_err(err)?;
    if registry.outputs.len() >= 16 {
        return Err("At most 16 GPU outputs can be open in one Unity process".into());
    }
    let output = Arc::new(Output {
        id: id.into(),
        connection: Connection::new(id, true)?,
        generation: Mutex::new(None),
        previous: Mutex::new(None),
        next_generation: AtomicU64::new(1),
        pending: AtomicU64::new(0),
        sequence: AtomicU64::new(1),
    });
    output
        .connection
        .header()
        .consumer_heartbeat
        .store(qpc(), RELEASE);
    let handle = next_id();
    registry.outputs.insert(handle, output);
    Ok(handle)
}

// Called on Unity main thread when the managed source object changes. D3D11
// device creation is thread-safe; its immediate context is used only in callback.
pub unsafe fn bind(handle: u64, texture: *mut c_void) -> Result<(), String> {
    let owner = get(handle)?;
    if owner.connection.header().closed.load(ACQUIRE) != 0 {
        return Err("Output is closed".into());
    }
    let source: ID3D11Texture2D = ID3D11Resource::from_raw_borrowed(&texture)
        .ok_or("Null RenderTexture native resource")?
        .cast()
        .map_err(err)?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    source.GetDesc(&mut desc);
    if desc.Width == 0
        || desc.Height == 0
        || desc.Width > MAX_SIZE
        || desc.Height > MAX_SIZE
        || desc.ArraySize != 1
        || desc.MipLevels != 1
        || desc.SampleDesc.Count != 1
    {
        return Err("Publish requires a created 2D, single-sample, single-mip texture of 1..4096 pixels per dimension".into());
    }
    let format=match desc.Format {
        DXGI_FORMAT_R8G8B8A8_UNORM|DXGI_FORMAT_R8G8B8A8_TYPELESS|DXGI_FORMAT_R8G8B8A8_UNORM_SRGB=>DXGI_FORMAT_R8G8B8A8_UNORM,
        DXGI_FORMAT_B8G8R8A8_UNORM|DXGI_FORMAT_B8G8R8A8_TYPELESS|DXGI_FORMAT_B8G8R8A8_UNORM_SRGB=>DXGI_FORMAT_B8G8R8A8_UNORM,
        _=>return Err("Publish requires RGBA8 or BGRA8. Resolve/tonemap into an SDR output texture in the View before publishing.".into())
    };
    let device = source.GetDevice().map_err(err)?;
    let adapter = device
        .cast::<IDXGIDevice>()
        .map_err(err)?
        .GetAdapter()
        .map_err(err)?
        .GetDesc()
        .map_err(err)?;
    let number = owner.next_generation.fetch_add(1, RELAXED);
    let shared: Shared<GenerationHeader> = Shared::create(&generation_name(&owner.id, number))?;
    desc.Format = format;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.CPUAccessFlags = 0;
    desc.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
    desc.MiscFlags =
        (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
    let mut slots = Vec::new();
    for index in 0..SLOT_COUNT {
        let mut value = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut value))
            .map_err(err)?;
        let texture = value.ok_or("No shared texture")?;
        let name = texture_name(&owner.id, number, index);
        let handle = texture
            .cast::<IDXGIResource1>()
            .map_err(err)?
            .CreateSharedHandle(
                None,
                DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                PCWSTR(name.as_ptr()),
            )
            .map_err(err)?;
        slots.push(Slot {
            mutex: texture.cast().map_err(err)?,
            texture,
            _handle: Handle(handle),
        });
    }
    let h = shared.get();
    h.width.store(desc.Width as u64, RELAXED);
    h.height.store(desc.Height as u64, RELAXED);
    h.format.store(format.0 as u64, RELAXED);
    h.adapter.store(luid_bits(adapter.AdapterLuid), RELAXED);
    h.magic.store(MAGIC, RELEASE);
    let generation = Arc::new(Generation {
        number,
        source,
        context: device.GetImmediateContext().map_err(err)?,
        shared,
        slots,
    });
    // Retain the announced source, including across several binds before a
    // render callback. A newly attaching consumer must still be able to open it.
    let mut current = owner.generation.lock().map_err(err)?;
    if let Some(old) = current.replace(generation) {
        if owner.connection.header().generation.load(ACQUIRE) == old.number {
            *owner.previous.lock().map_err(err)? = Some(old);
        }
    }
    // Announced by the first completed render callback, not by bind: the old
    // frame remains displayable until the new texture actually contains a frame.
    Ok(())
}

pub fn enqueue(handle: u64) -> Result<usize, String> {
    let owner = get(handle)?;
    let h = owner.connection.header();
    if h.closed.load(ACQUIRE) != 0 {
        return Err("Output is closed".into());
    }
    if h.attached.load(ACQUIRE) == 0 || h.visible.load(ACQUIRE) == 0 {
        return Ok(0);
    }
    let generation = owner
        .generation
        .lock()
        .map_err(err)?
        .clone()
        .ok_or("Bind a RenderTexture before publishing")?;
    if owner.pending.fetch_add(1, Ordering::AcqRel) >= 2 {
        owner.pending.fetch_sub(1, Ordering::AcqRel);
        h.dropped.fetch_add(1, RELAXED);
        return Ok(0);
    }
    let sequence = owner.sequence.fetch_add(1, RELAXED);
    let input = h.last_input_sequence.load(ACQUIRE);
    let input_qpc = h.last_input_qpc.load(RELAXED);
    let token = next_id() as usize;
    let packet = Packet {
        owner,
        generation,
        sequence,
        input,
        input_qpc,
    };
    registry()
        .lock()
        .map_err(err)?
        .packets
        .insert(token, packet);
    Ok(token)
}

pub type RenderCallback = unsafe extern "system" fn(i32, *mut c_void);
pub fn callback() -> RenderCallback {
    render
}
unsafe extern "system" fn render(_: i32, token: *mut c_void) {
    // Event data is an opaque registry token, never a dereferenced pointer.
    // Close/domain reload can retire packets before Unity dispatches the event.
    let packet = match registry().lock() {
        Ok(mut r) => r.packets.remove(&(token as usize)),
        Err(_) => None,
    };
    if let Some(packet) = packet {
        if copy_frame(&packet).is_err() {
            packet
                .owner
                .connection
                .header()
                .errors
                .fetch_add(1, RELAXED);
        }
    }
}
unsafe fn copy_frame(packet: &Packet) -> Result<(), String> {
    let owner = &packet.owner;
    let h = owner.connection.header();
    let generation = &packet.generation;
    if h.closed.load(ACQUIRE) != 0 {
        return Ok(());
    }
    // Stale queued commands must not switch the consumer back to an old source.
    let current = owner.generation.lock().map_err(err)?;
    if current.as_ref().map(|g| g.number) != Some(generation.number) {
        return Ok(());
    }
    for (index, slot) in generation.slots.iter().enumerate() {
        if !acquire(&slot.mutex, 0)? {
            continue;
        }
        generation
            .context
            .CopyResource(&slot.texture, &generation.source);
        let frame = &generation.shared.get().frames[index];
        frame.input_sequence.store(packet.input, RELAXED);
        frame.input_qpc.store(packet.input_qpc, RELAXED);
        frame.render_qpc.store(qpc(), RELAXED);
        frame.sequence.store(packet.sequence, RELEASE);
        slot.mutex.ReleaseSync(1).map_err(err)?;
        generation.context.Flush();
        h.generation.store(generation.number, RELEASE);
        h.published.fetch_add(1, RELAXED);
        owner.connection.wake_surface();
        return Ok(());
    }
    h.dropped.fetch_add(1, RELAXED);
    Ok(())
}
pub fn cancel_packet(token: usize) {
    if let Ok(mut r) = registry().lock() {
        r.packets.remove(&token);
    }
}
pub fn close(handle: u64) {
    if let Ok(mut r) = registry().lock() {
        if let Some(owner) = r.outputs.remove(&handle) {
            owner.connection.close();
            r.packets.retain(|_, p| !Arc::ptr_eq(&owner, &p.owner));
        }
    }
}
pub fn poll_input(handle: u64) -> Result<Option<InputEvent>, String> {
    let owner = get(handle)?;
    let h = owner.connection.header();
    Ok(h.input.pop())
}
pub fn acknowledge_input(handle: u64, sequence: u64, timestamp: u64) -> Result<(), String> {
    let owner = get(handle)?;
    if sequence != 0 {
        let h = owner.connection.header();
        h.last_input_qpc.store(timestamp, RELAXED);
        h.last_input_sequence.store(sequence, RELEASE);
    }
    Ok(())
}
pub fn wait(handle: u64, timeout: u32) -> bool {
    let Ok(owner) = get(handle) else {
        return false;
    };
    unsafe {
        WaitForSingleObject(owner.connection.input_event.0, timeout.min(1000)) == WAIT_OBJECT_0
    }
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
pub struct OutputState {
    pub closed: u64,
    pub attached: u64,
    pub visible: u64,
    pub width: u64,
    pub height: u64,
    pub frame_request: u64,
    pub published: u64,
    pub dropped: u64,
    pub errors: u64,
    pub pending: u64,
}
pub fn state(handle: u64) -> Result<OutputState, String> {
    let owner = get(handle)?;
    let h = owner.connection.header();
    // Also retire the producer if the desktop crashes (no host GC can run).
    if qpc().saturating_sub(h.consumer_heartbeat.load(ACQUIRE)) as f64 > 15.0 * frequency() {
        owner.connection.close();
    }
    Ok(OutputState {
        closed: h.closed.load(ACQUIRE),
        attached: h.attached.load(ACQUIRE),
        visible: h.visible.load(ACQUIRE),
        width: h.requested_width.load(ACQUIRE),
        height: h.requested_height.load(ACQUIRE),
        frame_request: h.frame_request.load(ACQUIRE),
        published: h.published.load(RELAXED),
        dropped: h.dropped.load(RELAXED),
        errors: h.errors.load(RELAXED),
        pending: owner.pending.load(RELAXED),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_ahead_does_not_mark_undelivered_input_as_rendered() {
        let id = format!("00000000-0000-4000-8000-{:012x}", next_id());
        let handle = create(&id).unwrap();
        let connection = Connection::new(&id, false).unwrap();
        connection.header().input.push(InputEvent {
            sequence: 1,
            timestamp: 10,
            kind: 1,
            ..Default::default()
        });
        connection.header().input.push(InputEvent {
            sequence: 2,
            timestamp: 20,
            kind: 3,
            ..Default::default()
        });
        assert_eq!(poll_input(handle).unwrap().unwrap().sequence, 1);
        assert_eq!(poll_input(handle).unwrap().unwrap().sequence, 2);
        assert_eq!(connection.header().last_input_sequence.load(ACQUIRE), 0);
        acknowledge_input(handle, 1, 10).unwrap();
        assert_eq!(connection.header().last_input_sequence.load(ACQUIRE), 1);
        close(handle);
    }

    #[test]
    fn host_heartbeat_keeps_unmounted_output_alive_and_crash_expires_it() {
        let id = format!("00000000-0000-4000-8000-{:012x}", next_id());
        let handle = create(&id).unwrap();
        let connection = Connection::new(&id, false).unwrap();
        let expired = qpc().saturating_sub((frequency() * 16.0) as u64);
        connection
            .header()
            .consumer_heartbeat
            .store(expired, RELEASE);
        crate::surface::touch_output(&id);
        assert_eq!(state(handle).unwrap().closed, 0);
        connection
            .header()
            .consumer_heartbeat
            .store(expired, RELEASE);
        assert_eq!(state(handle).unwrap().closed, 1);
        assert!(enqueue(handle).is_err());
        close(handle);
        assert!(state(handle).is_err());
    }
}
