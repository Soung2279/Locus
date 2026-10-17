use std::{
    cell::UnsafeCell,
    sync::atomic::{AtomicU64, Ordering},
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Foundation::*,
        Graphics::Dxgi::IDXGIKeyedMutex,
        System::{Memory::*, Performance::*, Threading::*},
    },
};

pub const VERSION: u64 = 1;
pub const MAGIC: u64 = 0x4c47505500000000 | VERSION;
pub const SLOT_COUNT: usize = 3;
pub const INPUT_CAPACITY: usize = 256;
pub const MAX_SIZE: u32 = 4096;
pub const RELAXED: Ordering = Ordering::Relaxed;
pub const ACQUIRE: Ordering = Ordering::Acquire;
pub const RELEASE: Ordering = Ordering::Release;

// FFI event layout: 64 bytes, stable across Unity managed and native x64 code.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct InputEvent {
    pub sequence: u64,
    pub timestamp: u64,
    pub kind: u32, // 1 move, 2 down, 3 up, 4 wheel, 5 key down, 6 key up, 7 cancel, 8 focus
    pub buttons: u32,
    pub modifiers: u32, // 1 shift, 2 ctrl, 4 alt
    pub key: u32,
    pub x: f32, // normalized, top-left origin; can leave [0,1] while captured
    pub y: f32,
    pub dx: f32, // wheel x or normalized pointer delta
    pub dy: f32,
    pub width: u32, // physical surface size at event time
    pub height: u32,
    pub reserved: u64,
}

#[repr(C, align(64))]
pub struct InputQueue {
    write: AtomicU64,
    read: AtomicU64,
    overflow: AtomicU64,
    slots: [UnsafeCell<InputEvent>; INPUT_CAPACITY],
}
// Exactly one native window thread writes; exactly one Unity main thread reads.
unsafe impl Sync for InputQueue {}
impl Default for InputQueue {
    fn default() -> Self {
        Self {
            write: AtomicU64::new(0),
            read: AtomicU64::new(0),
            overflow: AtomicU64::new(0),
            slots: std::array::from_fn(|_| UnsafeCell::new(InputEvent::default())),
        }
    }
}
impl InputQueue {
    pub fn push(&self, event: InputEvent) {
        let write = self.write.load(RELAXED);
        if write.wrapping_sub(self.read.load(ACQUIRE)) >= INPUT_CAPACITY as u64 {
            self.overflow.store(1, RELEASE);
            return;
        }
        unsafe {
            *self.slots[write as usize % INPUT_CAPACITY].get() = event;
        }
        self.write.store(write.wrapping_add(1), RELEASE);
    }
    pub fn pop(&self) -> Option<InputEvent> {
        if self.overflow.swap(0, Ordering::AcqRel) != 0 {
            self.read.store(self.write.load(ACQUIRE), RELEASE);
            return Some(InputEvent {
                kind: 7,
                timestamp: qpc(),
                ..Default::default()
            });
        }
        let read = self.read.load(RELAXED);
        if read == self.write.load(ACQUIRE) {
            return None;
        }
        let event = unsafe { *self.slots[read as usize % INPUT_CAPACITY].get() };
        self.read.store(read.wrapping_add(1), RELEASE);
        Some(event)
    }
}

#[repr(C)]
#[derive(Default)]
pub struct Frame {
    pub sequence: AtomicU64,
    pub input_sequence: AtomicU64,
    pub input_qpc: AtomicU64,
    pub render_qpc: AtomicU64,
}
#[repr(C, align(64))]
#[derive(Default)]
pub struct Header {
    pub magic: AtomicU64,
    pub closed: AtomicU64,
    pub generation: AtomicU64,
    pub consumer_generation: AtomicU64,
    pub requested_width: AtomicU64,
    pub requested_height: AtomicU64,
    pub visible: AtomicU64,
    pub attached: AtomicU64,
    pub frame_request: AtomicU64,
    pub consumer_heartbeat: AtomicU64,
    pub published: AtomicU64,
    pub dropped: AtomicU64,
    pub errors: AtomicU64,
    pub next_input_sequence: AtomicU64,
    pub last_input_sequence: AtomicU64,
    pub last_input_qpc: AtomicU64,
    pub input: InputQueue,
}
#[repr(C, align(64))]
#[derive(Default)]
pub struct GenerationHeader {
    pub magic: AtomicU64,
    pub width: AtomicU64,
    pub height: AtomicU64,
    pub format: AtomicU64,
    pub adapter: AtomicU64,
    pub frames: [Frame; SLOT_COUNT],
}

pub struct Handle(pub HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub struct Shared<T> {
    _handle: Handle,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    _type: std::marker::PhantomData<T>,
}
unsafe impl<T: Sync> Send for Shared<T> {}
unsafe impl<T: Sync> Sync for Shared<T> {}
impl<T> Shared<T> {
    pub fn create(name: &str) -> Result<Self, String> {
        unsafe {
            let name = wide(name);
            let handle = Handle(
                CreateFileMappingW(
                    INVALID_HANDLE_VALUE,
                    None,
                    PAGE_READWRITE,
                    0,
                    std::mem::size_of::<T>() as u32,
                    PCWSTR(name.as_ptr()),
                )
                .map_err(err)?,
            );
            if GetLastError() == ERROR_ALREADY_EXISTS {
                return Err("Output already exists".into());
            }
            Self::map(handle)
        }
    }
    pub fn open(name: &str) -> Result<Self, String> {
        unsafe {
            let name = wide(name);
            Self::map(Handle(
                OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name.as_ptr()))
                    .map_err(err)?,
            ))
        }
    }
    unsafe fn map(handle: Handle) -> Result<Self, String> {
        let view = MapViewOfFile(
            handle.0,
            FILE_MAP_ALL_ACCESS,
            0,
            0,
            std::mem::size_of::<T>(),
        );
        if view.Value.is_null() {
            return Err("Cannot map GPU output metadata".into());
        }
        Ok(Self {
            _handle: handle,
            view,
            _type: std::marker::PhantomData,
        })
    }
    pub fn get(&self) -> &T {
        unsafe { &*self.view.Value.cast() }
    }
}
impl<T> Drop for Shared<T> {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(self.view);
        }
    }
}

pub struct Connection {
    pub shared: Shared<Header>,
    pub input_event: Handle,
    pub frame_event: Handle,
}
impl Connection {
    pub fn new(id: &str, create: bool) -> Result<Self, String> {
        validate_id(id)?;
        let name = format!("Local\\LocusRender_{id}");
        let shared = if create {
            Shared::create(&name)?
        } else {
            Shared::open(&name)?
        };
        let input_event = event(&format!("{name}_input"))?;
        let frame_event = event(&format!("{name}_frame"))?;
        let result = Self {
            shared,
            input_event,
            frame_event,
        };
        if create {
            result.header().magic.store(MAGIC, RELEASE);
        } else if result.header().magic.load(ACQUIRE) != MAGIC {
            return Err("GPU transport version mismatch".into());
        }
        Ok(result)
    }
    pub fn header(&self) -> &Header {
        self.shared.get()
    }
    pub fn wake_unity(&self) {
        unsafe {
            let _ = SetEvent(self.input_event.0);
        }
    }
    pub fn wake_surface(&self) {
        unsafe {
            let _ = SetEvent(self.frame_event.0);
        }
    }
    pub fn close(&self) {
        self.header().closed.store(1, RELEASE);
        self.wake_unity();
        self.wake_surface();
    }
}
pub fn event(name: &str) -> Result<Handle, String> {
    unsafe {
        let name = wide(name);
        Ok(Handle(
            CreateEventW(None, false, false, PCWSTR(name.as_ptr())).map_err(err)?,
        ))
    }
}
pub fn generation_name(id: &str, generation: u64) -> String {
    format!("Local\\LocusRender_{id}_g{generation}")
}
pub fn texture_name(id: &str, generation: u64, slot: usize) -> Vec<u16> {
    wide(&format!("{}_t{slot}", generation_name(id, generation)))
}
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
    {
        return Err("Invalid output id".into());
    }
    Ok(())
}
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub fn qpc() -> u64 {
    unsafe {
        let mut n = 0;
        let _ = QueryPerformanceCounter(&mut n);
        n as u64
    }
}
pub fn frequency() -> f64 {
    unsafe {
        let mut n = 0;
        let _ = QueryPerformanceFrequency(&mut n);
        n as f64
    }
}
pub fn luid_bits(luid: LUID) -> u64 {
    ((luid.HighPart as u32 as u64) << 32) | luid.LowPart as u64
}
pub unsafe fn acquire(mutex: &IDXGIKeyedMutex, key: u64) -> Result<bool, String> {
    match (mutex.vtable().AcquireSync)(mutex.as_raw(), key, 0).0 {
        0 => Ok(true),
        0x102 => Ok(false),
        result => Err(format!(
            "Shared texture synchronization failed: {result:#x}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overflow_cancels_drag_and_recovers() {
        let queue = InputQueue::default();
        for i in 0..=INPUT_CAPACITY {
            queue.push(InputEvent {
                sequence: i as u64,
                kind: if i == 0 { 2 } else { 1 },
                buttons: 1,
                ..Default::default()
            });
        }
        assert_eq!(queue.pop().unwrap().kind, 7);
        assert!(queue.pop().is_none());
        queue.push(InputEvent {
            kind: 2,
            sequence: 999,
            ..Default::default()
        });
        assert_eq!(queue.pop().unwrap().sequence, 999);
    }
    #[test]
    fn fifo_and_ffi_layout() {
        assert_eq!(std::mem::size_of::<InputEvent>(), 64);
        let queue = InputQueue::default();
        for kind in [2, 1, 1, 3] {
            queue.push(InputEvent {
                kind,
                ..Default::default()
            });
        }
        assert_eq!(
            (0..4)
                .map(|_| queue.pop().unwrap().kind)
                .collect::<Vec<_>>(),
            vec![2, 1, 1, 3]
        );
    }
    #[test]
    fn names_are_scoped_and_validated() {
        assert!(validate_id("../../window").is_err());
        assert!(validate_id("01234567-89ab-cdef-0123-456789abcdef").is_ok());
    }
}
