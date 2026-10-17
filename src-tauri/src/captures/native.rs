//! Native clipboard access also works while Unity owns keyboard focus.
use std::ffi::c_void;
type Handle = *mut c_void;
#[repr(C)]
struct BitmapInfo {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bits: u16,
    compression: u32,
    size_image: u32,
    xppm: i32,
    yppm: i32,
    used: u32,
    important: u32,
    colors: u32,
}
#[link(name = "user32")]
unsafe extern "system" {
    fn OpenClipboard(hwnd: Handle) -> i32;
    fn CloseClipboard() -> i32;
    fn EmptyClipboard() -> i32;
    fn SetClipboardData(format: u32, memory: Handle) -> Handle;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
    fn GlobalLock(memory: Handle) -> Handle;
    fn GlobalUnlock(memory: Handle) -> i32;
    fn GlobalFree(memory: Handle) -> Handle;
}
pub fn clipboard(width: u32, height: u32, rgba: &[u8], owner: isize) -> Result<(), String> {
    unsafe {
        if rgba.len() != width as usize * height as usize * 4 {
            return Err("Invalid screenshot pixels".into());
        }
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(owner as Handle) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return Err("Clipboard is busy".into());
        }
        let result = (|| {
            let memory = GlobalAlloc(0x0042, 40 + rgba.len());
            if memory.is_null() {
                return Err("Clipboard allocation failed".into());
            }
            let ptr = GlobalLock(memory) as *mut u8;
            if ptr.is_null() {
                GlobalFree(memory);
                return Err("Clipboard lock failed".into());
            }
            let info = BitmapInfo {
                size: 40,
                width: width as i32,
                height: -(height as i32),
                planes: 1,
                bits: 32,
                compression: 0,
                size_image: rgba.len() as u32,
                xppm: 0,
                yppm: 0,
                used: 0,
                important: 0,
                colors: 0,
            };
            std::ptr::copy_nonoverlapping(&info as *const _ as *const u8, ptr, 40);
            let output = std::slice::from_raw_parts_mut(ptr.add(40), rgba.len());
            for (input, pixel) in rgba.chunks_exact(4).zip(output.chunks_exact_mut(4)) {
                pixel.copy_from_slice(&[input[2], input[1], input[0], 255]);
            }
            GlobalUnlock(memory);
            if EmptyClipboard() == 0 || SetClipboardData(8, memory).is_null() {
                GlobalFree(memory);
                return Err("Clipboard image write failed".into());
            }
            Ok(())
        })();
        CloseClipboard();
        result
    }
}
