#![deny(unsafe_op_in_unsafe_fn)]
#![cfg_attr(windows, feature(windows_process_extensions_raw_attribute))]

use std::io::{self, PipeReader, PipeWriter};
use std::process::{Child, Command};

/// Starts Chromium with private anonymous pipes; never creates a TCP listener.
pub fn spawn(command: &mut Command) -> io::Result<(Child, PipeReader, PipeWriter)> {
    platform::spawn(command)
}

/// Kills the dedicated process tree and reaps its leader before pipe threads join.
pub fn terminate(child: &mut Child) {
    platform::terminate(child);
    let _ = child.kill();
    let _ = child.wait();
}

/// Creates a profile accessible only to its owner (and Windows SYSTEM).
pub fn create_private_directory(path: &std::path::Path) -> io::Result<()> {
    platform::create_private_directory(path)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;

    pub fn create_private_directory(path: &std::path::Path) -> io::Result<()> {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }

    pub fn spawn(command: &mut Command) -> io::Result<(Child, PipeReader, PipeWriter)> {
        let (child_read, parent_write) = io::pipe()?;
        let (parent_read, child_write) = io::pipe()?;
        // Move sources above 4 so either dup2 cannot overwrite the other source.
        let duplicate = |fd| {
            // SAFETY: fd is borrowed and live; a successful fcntl returns a fresh owned fd.
            let new_fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 5) };
            if new_fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: ownership of the fresh descriptor is transferred exactly once.
            Ok(unsafe { OwnedFd::from_raw_fd(new_fd) })
        };
        let input = duplicate(child_read.as_raw_fd())?;
        let output = duplicate(child_write.as_raw_fd())?;
        command.arg("--remote-debugging-pipe");
        // SAFETY: the post-fork closure performs only async-signal-safe syscalls. The
        // sources stay owned by this command until spawn returns, and dup2 clears
        // CLOEXEC on exactly Chromium's read fd 3 and write fd 4.
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, 0) != 0
                    || libc::dup2(input.as_raw_fd(), 3) < 0
                    || libc::dup2(output.as_raw_fd(), 4) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        Ok((child, parent_read, parent_write))
    }

    pub fn terminate(child: &mut Child) {
        if let Ok(id) = i32::try_from(child.id()) {
            // SAFETY: spawn established a dedicated process group whose id is the
            // still-owned child's pid. Negative pid targets only that browser tree.
            unsafe { libc::kill(-id, libc::SIGKILL) };
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::{CommandExt, ProcThreadAttributeList};
    use std::sync::{Mutex, OnceLock};

    pub fn create_private_directory(path: &std::path::Path) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
        // Protected DACL: owner and SYSTEM only, inherited by profile children.
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)\0"
            .encode_utf16()
            .collect();
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: valid NUL-terminated SDDL and writable output pointer. The API
        // allocates the descriptor; it remains live through CreateDirectoryW.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        // SAFETY: path is NUL-terminated and descriptor/attributes are valid until
        // this synchronous call returns; LocalFree releases exactly that allocation.
        let created = unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) };
        let result = if created == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        };
        unsafe { LocalFree(descriptor) };
        result
    }
    use windows_sys::Win32::Foundation::{DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, GetCurrentProcess};

    static JOBS: OnceLock<Mutex<HashMap<u32, OwnedHandle>>> = OnceLock::new();

    pub fn spawn(command: &mut Command) -> io::Result<(Child, PipeReader, PipeWriter)> {
        let (child_read, parent_write) = io::pipe()?;
        let (parent_read, child_write) = io::pipe()?;
        let duplicate = |handle| {
            let mut result: HANDLE = std::ptr::null_mut();
            // SAFETY: both process handles are current; the borrowed source remains
            // live and DuplicateHandle returns one new inheritable owned handle.
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    handle,
                    GetCurrentProcess(),
                    &mut result,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: this is a fresh successfully duplicated handle.
            Ok(unsafe { OwnedHandle::from_raw_handle(result) })
        };
        let input = duplicate(child_read.as_raw_handle())?;
        let output = duplicate(child_write.as_raw_handle())?;
        // SAFETY: no security attributes or name are borrowed by CreateJobObjectW.
        let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw_job.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the new job handle has exactly one owner.
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: correctly sized initialized job limit structure; job remains live.
        if unsafe {
            SetInformationJobObject(
                raw_job,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let handles = [input.as_raw_handle(), output.as_raw_handle()];
        let jobs = [job.as_raw_handle()];
        // SAFETY: both arrays and all handles outlive attribute construction and
        // spawn. HANDLE_LIST inherits only the two pipe endpoints. JOB_LIST puts
        // the child in its kill-on-close job atomically, before any browser code runs.
        let attrs = unsafe {
            ProcThreadAttributeList::build()
                .raw_attribute(
                    0x0002_0002,
                    handles.as_ptr().cast::<std::ffi::c_void>(),
                    std::mem::size_of_val(&handles),
                )
                .raw_attribute(
                    0x0002_000d,
                    jobs.as_ptr().cast::<std::ffi::c_void>(),
                    std::mem::size_of_val(&jobs),
                )
                .finish()?
        };
        command
            .arg("--remote-debugging-pipe")
            .arg(format!(
                "--remote-debugging-io-pipes={},{}",
                handles[0] as usize, handles[1] as usize
            ))
            .creation_flags(CREATE_NO_WINDOW);
        let mut registry = JOBS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| io::Error::other("browser job registry unavailable"))?;
        if registry.len() >= 16 {
            return Err(io::Error::other("browser process limit"));
        }
        let child = command.spawn_with_attributes(&attrs)?;
        registry.insert(child.id(), job);
        Ok((child, parent_read, parent_write))
    }

    pub fn terminate(child: &mut Child) {
        if let Some(registry) = JOBS.get() {
            // Closing the last job handle terminates the browser and descendants.
            if let Ok(mut jobs) = registry.lock() {
                jobs.remove(&child.id());
            }
        }
    }
}
