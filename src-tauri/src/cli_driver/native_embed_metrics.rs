use super::*;

#[cfg(target_os = "windows")]
fn process_sample(pid: u32) -> Result<Value, String> {
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        System::Threading::{
            GetProcessHandleCount, GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION,
            PROCESS_VM_READ,
        },
    };
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        size: u32,
        faults: u32,
        peak_working: usize,
        working: usize,
        peak_paged: usize,
        paged: usize,
        peak_nonpaged: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private: usize,
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(process: isize, counters: *mut Counters, size: u32) -> i32;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            .map_err(|e| e.to_string())?;
        let mut counters = Counters::default();
        let size = std::mem::size_of::<Counters>() as u32;
        counters.size = size;
        let mut handles = 0;
        let memory = GetProcessMemoryInfo(handle.0 as isize, &mut counters, size);
        let count = GetProcessHandleCount(handle, &mut handles);
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let times = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        if memory == 0 || count.is_err() || times.is_err() {
            return Err(format!("Cannot measure process {pid}"));
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| e.to_string())?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut threads = 0;
        let mut found = Thread32First(snapshot, &mut entry).is_ok();
        while found {
            if entry.th32OwnerProcessID == pid {
                threads += 1;
            }
            found = Thread32Next(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        let ticks = |v: FILETIME| (u64::from(v.dwHighDateTime) << 32) | u64::from(v.dwLowDateTime);
        Ok(
            json!({"pid":pid,"bytes":counters.private,"handles":handles,"threads":threads,"cpuMs":(ticks(kernel)+ticks(user))/10000}),
        )
    }
}
#[cfg(not(target_os = "windows"))]
fn process_sample(_pid: u32) -> Result<Value, String> {
    Err("Windows required".into())
}
pub(super) async fn capture(app: &AppHandle) -> Result<Value, String> {
    let diagnostic = host::diagnostics(app).await?;
    let mut samples = Vec::new();
    let mut bytes = 0u64;
    let mut handles = 0u64;
    for process in diagnostic["processes"]
        .as_array()
        .ok_or("Missing browser process list")?
    {
        let sample = process_sample(process["pid"].as_u64().ok_or("Missing process id")? as u32)?;
        bytes += sample["bytes"].as_u64().unwrap_or(0);
        handles += sample["handles"].as_u64().unwrap_or(0);
        samples.push(sample);
    }
    Ok(
        json!({"locus":process_sample(std::process::id())?,"browserBytes":bytes,"browserHandles":handles,"browserProcesses":samples,"diagnostics":diagnostic}),
    )
}

pub(super) async fn gpu(resources: &Value) -> Value {
    #[cfg(target_os = "windows")]
    {
        let mut pids = vec![std::process::id().to_string()];
        if let Some(processes) = resources["browserProcesses"].as_array() {
            pids.extend(
                processes
                    .iter()
                    .filter_map(|p| p["pid"].as_u64())
                    .map(|p| p.to_string()),
            );
        }
        // Only numeric PIDs from this Environment enter the command. Never inspect
        // or terminate another Locus instance. GPU engine sums are not total GPU %.
        let command = format!(
            r#"$ErrorActionPreference='Stop'; $owned=@({}); $items=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object {{ $_.Name -match '^pid_(\d+)_' -and $owned -contains [int]$Matches[1] }} | Select-Object Name,UtilizationPercentage); ConvertTo-Json -Compress -Depth 3 -InputObject $items"#,
            pids.join(",")
        );
        let mut process = tokio::process::Command::new("powershell.exe");
        process
            .args(["-NoProfile", "-Command", &command])
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        let output = process.output();
        match tokio::time::timeout(Duration::from_secs(10), output).await {
            Ok(Ok(output)) if output.status.success() => {
                if let Ok(engines) = serde_json::from_slice::<Value>(&output.stdout) {
                    return json!({"available":true,"engines":engines});
                }
            }
            _ => {}
        }
    }
    json!({"available":false,"reason":"GPU performance counters unavailable"})
}
