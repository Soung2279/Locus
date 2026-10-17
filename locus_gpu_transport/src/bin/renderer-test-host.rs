//! Isolated integration fixture; never linked into the desktop or Unity plugin.
#[cfg(windows)]
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows integration fixture");
}
#[cfg(windows)]
fn run() -> Result<(), String> {
    use locus_gpu_transport::{protocol::*, surface::*};
    use std::{
        io::Write,
        time::{Duration, Instant},
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::*,
            Graphics::Gdi::ClientToScreen,
            System::LibraryLoader::GetModuleHandleW,
            UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
        },
    };
    let args = std::env::args().collect::<Vec<_>>();
    let option = |name: &str| {
        args.windows(2)
            .find(|p| p[0] == name)
            .map(|p| p[1].clone())
            .ok_or(format!("Missing {name}"))
    };
    let id = option("--id")?;
    let second = option("--second-id")?;
    let out = std::path::PathBuf::from(option("--output")?);
    std::fs::create_dir_all(&out).map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(100);
    while Connection::new(&id, false).is_err() {
        if Instant::now() > deadline {
            return Err("Unity output handshake timeout".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    unsafe extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if m == WM_CLOSE {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(h, m, w, l)
    }
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).map_err(err)?;
        let mut old_cursor = POINT::default();
        GetCursorPos(&mut old_cursor).map_err(err)?;
        let old_foreground = GetForegroundWindow();
        let instance = GetModuleHandleW(None).map_err(err)?;
        let name = wide("Locus renderer SDK integration");
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(name.as_ptr()),
            ..Default::default()
        });
        let parent = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(name.as_ptr()),
            PCWSTR(name.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            60,
            60,
            1040,
            720,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(err)?;
        struct Cleanup {
            parent: HWND,
            cursor: POINT,
            foreground: HWND,
            ids: Vec<String>,
        }
        impl Drop for Cleanup {
            fn drop(&mut self) {
                unsafe {
                    let up = INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dwFlags: MOUSEEVENTF_LEFTUP,
                                ..Default::default()
                            },
                        },
                    };
                    SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
                    let _ = DestroyWindow(self.parent);
                    let _ = SetCursorPos(self.cursor.x, self.cursor.y);
                    let _ = SetForegroundWindow(self.foreground);
                }
                for id in &self.ids {
                    close_output(id);
                }
            }
        }
        let _cleanup = Cleanup {
            parent,
            cursor: old_cursor,
            foreground: old_foreground,
            ids: vec![id.clone(), second.clone()],
        };
        let _ = ShowWindow(parent, SW_SHOWNORMAL);
        let _ = SetForegroundWindow(parent);
        let mut layout = Layout {
            rect: Rect {
                x: 8,
                y: 8,
                width: 640,
                height: 480,
            },
            clip: Rect {
                x: 8,
                y: 8,
                width: 640,
                height: 480,
            },
            occluders: vec![],
            visible: true,
        };
        let surface = Surface::start(id.clone(), parent.0 as usize, layout.clone())?;
        let second_surface = Surface::start(
            second.clone(),
            parent.0 as usize,
            Layout {
                rect: Rect {
                    x: 660,
                    y: 8,
                    width: 300,
                    height: 240,
                },
                clip: Rect {
                    x: 660,
                    y: 8,
                    width: 300,
                    height: 240,
                },
                visible: true,
                ..Default::default()
            },
        )?;
        let started = Instant::now();
        let mut next = Instant::now();
        let mut sent = 0;
        let mut pressed = false;
        let mut resized = false;
        let mut hidden = false;
        let mut shown = false;
        let mut ended = false;
        let mut trace = std::fs::File::create(out.join("surface.ndjson")).map_err(err)?;
        while started.elapsed() < Duration::from_secs(14) {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    return Err("Fixture closed early".into());
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let elapsed = started.elapsed().as_secs_f64();
            if elapsed > 3. && elapsed < 7. && Instant::now() >= next {
                if !pressed {
                    SetWindowPos(
                        parent,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                    .map_err(err)?;
                    let _ = SetForegroundWindow(parent);
                    if GetForegroundWindow() != parent {
                        // The shell launch may not inherit foreground rights.
                        // Attach only for initial activation, before injecting.
                        let foreground_thread =
                            GetWindowThreadProcessId(GetForegroundWindow(), None);
                        let this_thread = windows::Win32::System::Threading::GetCurrentThreadId();
                        let attached = windows::Win32::System::Threading::AttachThreadInput(
                            this_thread,
                            foreground_thread,
                            true,
                        )
                        .as_bool();
                        let _ = SetForegroundWindow(parent);
                        let _ = SetActiveWindow(parent);
                        let _ = SetFocus(Some(parent));
                        if attached {
                            let _ = windows::Win32::System::Threading::AttachThreadInput(
                                this_thread,
                                foreground_thread,
                                false,
                            );
                        }
                        if GetForegroundWindow() != parent {
                            SwitchToThisWindow(parent, true);
                        }
                    }
                }
                if GetForegroundWindow() != parent {
                    return Err(format!(
                        "Input test lost its own foreground window: expected={:?}, actual={:?}",
                        parent,
                        GetForegroundWindow()
                    ));
                }
                let mut point = POINT {
                    x: 200 + (elapsed * 4.).sin().mul_add(120., 0.) as i32,
                    y: 200,
                };
                let _ = ClientToScreen(parent, &mut point);
                let x = (point.x - GetSystemMetrics(SM_XVIRTUALSCREEN)) * 65535
                    / (GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
                let y = (point.y - GetSystemMetrics(SM_YVIRTUALSCREEN)) * 65535
                    / (GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);
                let event = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: x,
                            dy: y,
                            dwFlags: MOUSEEVENTF_ABSOLUTE
                                | MOUSEEVENTF_VIRTUALDESK
                                | MOUSEEVENTF_MOVE
                                | if !pressed {
                                    MOUSEEVENTF_LEFTDOWN
                                } else {
                                    MOUSE_EVENT_FLAGS(0)
                                },
                            ..Default::default()
                        },
                    },
                };
                if SendInput(&[event], std::mem::size_of::<INPUT>() as i32) != 1 {
                    return Err("SendInput failed".into());
                }
                pressed = true;
                sent += 1;
                next = Instant::now() + Duration::from_micros(16667);
            }
            if elapsed > 7. && !ended {
                ended = true;
                let up = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dwFlags: MOUSEEVENTF_LEFTUP,
                            ..Default::default()
                        },
                    },
                };
                SendInput(&[up], std::mem::size_of::<INPUT>() as i32);
            }
            if elapsed > 8. && !resized {
                resized = true;
                layout.rect.width = 800;
                layout.rect.height = 540;
                layout.clip = layout.rect;
                layout.occluders = vec![Rect {
                    x: 360,
                    y: 60,
                    width: 90,
                    height: 100,
                }];
                surface.update(layout.clone())?;
            }
            if elapsed > 10. && !hidden {
                hidden = true;
                layout.visible = false;
                surface.update(layout.clone())?;
            }
            if elapsed > 11. && !shown {
                shown = true;
                layout.visible = true;
                surface.update(layout.clone())?;
            }
            let status = surface.status();
            let other = second_surface.status();
            if status.state == "failed" || other.state == "failed" {
                return Err(format!(
                    "GPU output failed: {:?} {:?}",
                    status.error, other.error
                ));
            }
            writeln!(
                trace,
                "{elapsed:.3} {} {} {} {} {}",
                status.frames, status.inputs, status.generation, status.width, status.height
            )
            .map_err(err)?;
            std::thread::sleep(Duration::from_millis(2));
        }
        let status = surface.status();
        let other = second_surface.status();
        // Windows and the SDK coalesce pointer moves. Validate sustained input
        // and rendered responses, not equality with the number of injections.
        let passed = status.frames > 100
            && other.frames > 100
            && status.inputs >= 100
            && sent >= 100
            && status.width == 800
            && status.height == 540
            && status.generation >= 2
            && status.input_to_present_p95_ms.is_some_and(|ms| ms < 33.4);
        let report=format!("{{\"passed\":{passed},\"frames\":{},\"secondFrames\":{},\"inputs\":{},\"sent\":{sent},\"generation\":{},\"width\":{},\"height\":{},\"inputToPresentP95Ms\":{},\"boundary\":\"WM input dispatch to first Present containing input; excludes hardware and scanout\"}}",status.frames,other.frames,status.inputs,status.generation,status.width,status.height,status.input_to_present_p95_ms.unwrap_or(-1.));
        std::fs::write(out.join("summary.json"), &report).map_err(err)?;
        println!("LOCUS_RENDER_TEST_JSON {report}");
        drop(second_surface);
        drop(surface);
        if !passed {
            return Err("GPU SDK acceptance failed".into());
        }
    }
    Ok(())
}
