//! `/bin` and `/usr/bin`: one executable file per command. A command that arrives after the
//! boot ([`crate::Shell::install`]) is listed from the start, as an empty file, and an `open`
//! of it waits until it is there, so what runs it starts late instead of failing.

use std::any::Any;
use std::future::poll_fn;
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};

use async_trait::async_trait;
use wasixv2::OwnedBuffer;
use wasixv2_vfs::{
    Attr, DirEntry, DirSink, Errno, FileType, Filesystem, FsInfo, FsResult, Handle, Node,
    OpenOptions, SetAttr, SharedContents, StatFs,
};

use crate::audio::attr;

/// `f_type` of `statfs`: "bins" in ASCII. No Linux filesystem uses it.
const BIN_MAGIC: u32 = 0x6269_6e73;
const ROOT_INO: u64 = 1;
const FIRST_INO: u64 = 2;

enum File {
    Loading,
    Ready(OwnedBuffer),
    /// Expected, but what arrived did not have it.
    Missing,
}

struct Slot {
    name: String,
    file: File,
    /// Something waits for it.
    wanted: bool,
}

#[derive(Default)]
struct State {
    slots: Vec<Slot>,
    wakers: Vec<Waker>,
}

#[derive(Clone, Default)]
pub struct BinFs(Arc<Mutex<State>>);

impl BinFs {
    /// The commands in order, of which the first keeps a name two share; one without bytes is
    /// still loading.
    pub fn new(commands: impl IntoIterator<Item = (String, Option<OwnedBuffer>)>) -> Self {
        let fs = Self::default();
        for (name, bytes) in commands {
            match bytes {
                Some(bytes) => {
                    fs.fill(&name, bytes);
                }
                None => fs.expect(&name),
            }
        }
        fs
    }

    fn expect(&self, name: &str) {
        let mut state = self.0.lock().unwrap();
        if !state.slots.iter().any(|s| s.name == name) {
            state.slots.push(Slot {
                name: name.into(),
                file: File::Loading,
                wanted: false,
            });
        }
    }

    /// The command `name` is `bytes`, unless it already has its bytes. Those waiting for it go
    /// on at the next [`BinFs::wake`].
    pub fn fill(&self, name: &str, bytes: OwnedBuffer) -> bool {
        let mut state = self.0.lock().unwrap();
        match state.slots.iter_mut().find(|s| s.name == name) {
            Some(Slot {
                file: File::Ready(_),
                ..
            }) => false,
            Some(slot) => {
                slot.file = File::Ready(bytes);
                true
            }
            None => {
                state.slots.push(Slot {
                    name: name.into(),
                    file: File::Ready(bytes),
                    wanted: false,
                });
                true
            }
        }
    }

    /// The command `name` will not come. False when it is there or was never expected.
    pub fn miss(&self, name: &str) -> bool {
        let mut state = self.0.lock().unwrap();
        match state.slots.iter_mut().find(|s| s.name == name) {
            Some(slot) if matches!(slot.file, File::Loading) => {
                slot.file = File::Missing;
                true
            }
            _ => false,
        }
    }

    pub fn wake(&self) {
        let wakers = std::mem::take(&mut self.0.lock().unwrap().wakers);
        for waker in wakers {
            waker.wake();
        }
    }

    /// The commands still loading that something waits for.
    pub fn waited_for(&self) -> Vec<String> {
        let state = self.0.lock().unwrap();
        let waited = |s: &&Slot| s.wanted && matches!(s.file, File::Loading);
        state.slots.iter().filter(waited).map(|s| s.name.clone()).collect()
    }

    async fn contents(&self, index: usize) -> FsResult<OwnedBuffer> {
        poll_fn(|cx| {
            let mut state = self.0.lock().unwrap();
            match &state.slots[index].file {
                File::Ready(bytes) => Poll::Ready(Ok(bytes.clone())),
                File::Missing => Poll::Ready(Err(Errno::ENOENT)),
                File::Loading => {
                    state.slots[index].wanted = true;
                    state.wakers.push(cx.waker().clone());
                    Poll::Pending
                }
            }
        })
        .await
    }
}

#[async_trait(?Send)]
impl Filesystem for BinFs {
    fn info(&self) -> FsInfo {
        FsInfo {
            name: "bin",
            magic: BIN_MAGIC,
            name_max: 255,
            read_only: true,
            dev: None,
            has_btime: false,
            stable: true,
        }
    }

    fn root(&self) -> Arc<dyn Node> {
        Arc::new(Root(self.clone()))
    }

    async fn statfs(&self) -> FsResult<StatFs> {
        Ok(StatFs {
            block_size: 4096,
            blocks: 0,
            blocks_free: 0,
            blocks_avail: 0,
            files: self.0.lock().unwrap().slots.len() as u64 + 1,
            files_free: 0,
            name_max: 255,
            fragment_size: 4096,
        })
    }
}

struct Root(BinFs);

#[async_trait(?Send)]
impl Node for Root {
    fn ino(&self) -> u64 {
        ROOT_INO
    }

    fn file_type(&self) -> FileType {
        FileType::Directory
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        Ok(attr(ROOT_INO, FileType::Directory, 0o755))
    }

    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        Err(Errno::EROFS)
    }

    async fn lookup(&self, name: &[u8]) -> FsResult<Arc<dyn Node>> {
        let state = self.0.0.lock().unwrap();
        let listed = |s: &Slot| s.name.as_bytes() == name && !matches!(s.file, File::Missing);
        let index = state.slots.iter().position(listed).ok_or(Errno::ENOENT)?;
        Ok(Arc::new(Command(self.0.clone(), index)))
    }

    async fn open(&self, _options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        Ok(Box::new(RootHandle(self.0.clone())))
    }
}

struct RootHandle(BinFs);

#[async_trait(?Send)]
impl Handle for RootHandle {
    async fn readdir(&self, cookie: u64, sink: &mut dyn DirSink) -> FsResult<()> {
        let state = self.0.0.lock().unwrap();
        let start = usize::try_from(cookie).unwrap_or(usize::MAX);
        for (i, slot) in state.slots.iter().enumerate().skip(start) {
            if matches!(slot.file, File::Missing) {
                continue;
            }
            let entry = DirEntry {
                name: slot.name.as_bytes(),
                ino: FIRST_INO + i as u64,
                file_type: FileType::Regular,
                next: i as u64 + 1,
            };
            if !sink.push(entry) {
                break;
            }
        }
        Ok(())
    }
}

struct Command(BinFs, usize);

#[async_trait(?Send)]
impl Node for Command {
    fn ino(&self) -> u64 {
        FIRST_INO + self.1 as u64
    }

    fn file_type(&self) -> FileType {
        FileType::Regular
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        let size = match &self.0.0.lock().unwrap().slots[self.1].file {
            File::Ready(bytes) => bytes.len() as u64,
            File::Loading => 0,
            File::Missing => return Err(Errno::ENOENT),
        };
        Ok(Attr {
            size,
            blocks: size.div_ceil(512),
            ..attr(self.ino(), FileType::Regular, 0o755)
        })
    }

    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        Err(Errno::EROFS)
    }

    async fn open(&self, options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        if options.write {
            return Err(Errno::EROFS);
        }
        Ok(Box::new(Contents(self.0.contents(self.1).await?)))
    }
}

struct Contents(OwnedBuffer);

#[async_trait(?Send)]
impl Handle for Contents {
    async fn read_at(&self, buf: &mut [u8], offset: u64) -> FsResult<usize> {
        let data = self.0.as_slice();
        let Some(rest) = usize::try_from(offset).ok().and_then(|o| data.get(o..)) else {
            return Ok(0);
        };
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        Ok(n)
    }

    async fn shared_contents(&self) -> Option<SharedContents> {
        Some(Arc::new(self.0.clone()))
    }
}
