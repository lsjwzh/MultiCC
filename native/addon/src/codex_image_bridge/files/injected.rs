use super::*;

pub(super) fn signature(fs: L<'_>, file: L<'_>) -> Result<Option<&'static str>> {
    let buf = call(fs, c"readFileSync", &[file])?;
    let head = call(buf, c"subarray", &[num(fs, 0.)?, num(fs, 12.)?])?;
    let size = head.get(c"length")?.number()?.clamp(0., 12.) as u32;
    let mut bytes = Vec::with_capacity(size as usize);
    for i in 0..size {
        bytes.push(head.element(i)?.number()? as u8);
    }
    Ok(super::signature(&bytes))
}
pub(super) struct Adapter<'a> {
    pub p: L<'a>,
    pub fs: L<'a>,
}
impl<'a> Adapter<'a> {
    fn file(&self, path: &Path) -> Result<L<'a>> {
        text(self.p, &path.to_string_lossy())
    }
}
impl Files for Adapter<'_> {
    fn secure(&self, p: &Path, dir: bool) -> Result<()> {
        private(self.p, self.file(p)?, dir)
    }
    fn copy(&self, src: &Path, dest: &Path) -> Result<()> {
        call(
            self.fs,
            c"copyFileSync",
            &[self.file(src)?, self.file(dest)?],
        )?;
        Ok(())
    }
    fn real(&self, p: &Path) -> Result<PathBuf> {
        self.p
            .catch(|| path(call(self.fs, c"realpathSync", &[self.file(p)?])?))?
            .ok_or_else(|| napi::Error::from_reason("unreadable path"))
    }
    fn stat(&self, p: &Path) -> Result<Meta> {
        self.p
            .catch(|| {
                let s = call(self.fs, c"statSync", &[self.file(p)?])?;
                Ok(Meta {
                    regular: call(s, c"isFile", &[])?.truthy()?,
                    bytes: s.get(c"size")?.number()? as u64,
                    modified: s.get(c"mtimeMs")?.number()?,
                })
            })?
            .ok_or_else(|| napi::Error::from_reason("unreadable metadata"))
    }
    fn kind(&self, p: &Path) -> Result<Option<&'static str>> {
        Ok(self
            .p
            .catch(|| signature(self.fs, self.file(p)?))?
            .flatten())
    }
    fn entries(&self, p: &Path) -> Result<Vec<(PathBuf, Kind)>> {
        let mut rows = vec![];
        self.p.catch(|| {
            let entries = call(
                self.fs,
                c"readdirSync",
                &[
                    self.file(p)?,
                    fields(self.p, &[("withFileTypes", flag(self.p, true)?)])?,
                ],
            )?;
            entries.for_each(|e| {
                self.p.catch(|| {
                    let file = p.join(fold_string(e.get(c"name")?)?);
                    let kind = if call(e, c"isDirectory", &[])?.truthy()? {
                        Kind::Dir
                    } else if call(e, c"isFile", &[])?.truthy()? {
                        Kind::File
                    } else {
                        Kind::Other
                    };
                    rows.push((file, kind));
                    Ok(())
                })?;
                Ok(())
            })
        })?;
        Ok(rows)
    }
}
