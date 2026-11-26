use super::*;

pub(super) fn id<'e>(h: L<'e>, prefix: L<'e>) -> Result<L<'e>> {
    let prefix = if prefix.undefined()? {
        text(h, "repo")?
    } else {
        prefix
    };
    let millis = call(now(h)?, c"toString", &[num(h, 36.)?])?;
    let bytes = call(h, c"randomBytes", &[num(h, 6.)?])?;
    call(
        text(h, "")?,
        c"concat",
        &[
            prefix,
            text(h, "_")?,
            millis,
            text(h, "_")?,
            call(bytes, c"toString", &[text(h, "hex")?])?,
        ],
    )
}

fn ancestor<'e>(h: L<'e>, input: L<'e>) -> Result<L<'e>> {
    let path = h.get(c"path")?;
    let fs = h.get(c"fs")?;
    let input = if input.truthy()? {
        input
    } else {
        call(h.get(c"process")?, c"cwd", &[])?
    };
    let mut current = call(path, c"resolve", &[input])?;
    while !call(fs, c"existsSync", &[current])?.truthy()? {
        let parent = call(path, c"dirname", &[current])?;
        if parent.equals(current)? {
            break;
        }
        current = parent;
    }
    Ok(current)
}

pub(super) fn key<'e>(h: L<'e>, input: L<'e>) -> Result<L<'e>> {
    let fs = h.get(c"fs")?;
    let path = h.get(c"path")?;
    let original = ancestor(h, input)?;
    let mut dir = original;
    if fs.catch(|| call(call(fs, c"statSync", &[dir])?, c"isDirectory", &[])?.truthy())?
        == Some(false)
    {
        dir = call(path, c"dirname", &[dir])?;
    }
    loop {
        let dot = call(path, c"join", &[dir, text(h, ".git")?])?;
        let found = fs
            .catch(|| -> Result<Option<L<'e>>> {
                let stat = call(fs, c"statSync", &[dot])?;
                if call(stat, c"isDirectory", &[])?.truthy()? {
                    return Ok(Some(call(fs, c"realpathSync", &[dot])?));
                }
                if !call(stat, c"isFile", &[])?.truthy()? {
                    return Ok(None);
                }
                let content = call(fs, c"readFileSync", &[dot, text(h, "utf8")?])?
                    .coerce_string()?
                    .to_string_lossy();
                let line = content.lines().next().unwrap_or("");
                let Some((label, rest)) = line.split_once(':') else {
                    return Ok(None);
                };
                let target = rest.trim_start();
                if !label.eq_ignore_ascii_case("gitdir") || target.is_empty() {
                    return Ok(None);
                }
                let git_dir = call(path, c"resolve", &[dir, text(h, target)?])?;
                let sep = path.get(c"sep")?;
                let marker = call(sep, c"concat", &[text(h, "worktrees")?, sep])?;
                let pos = call(git_dir, c"lastIndexOf", &[marker])?;
                let common = if pos.number()? >= 0. {
                    call(git_dir, c"slice", &[num(h, 0.)?, pos])?
                } else {
                    git_dir
                };
                Ok(Some(call(fs, c"realpathSync", &[common])?))
            })?
            .flatten();
        if let Some(value) = found {
            return Ok(value);
        }
        let parent = call(path, c"dirname", &[dir])?;
        if parent.equals(dir)? {
            break;
        }
        dir = parent;
    }
    if let Some(real) = fs.catch(|| call(fs, c"realpathSync", &[ancestor(h, input)?]))? {
        return Ok(real);
    }
    let input = if input.truthy()? {
        input
    } else {
        call(h.get(c"process")?, c"cwd", &[])?
    };
    call(path, c"resolve", &[input])
}
