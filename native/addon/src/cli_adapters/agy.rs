use crate::host_api::*;

fn native(p: L<'_>) -> Result<L<'_>> {
    p.get(c"host")?.get(c"getNative")?.call_plain(&[])
}

fn decode<'a>(p: L<'a>, args: &mut [L<'a>]) -> Result<L<'a>> {
    if !object(args[0])? || args[0].nullish()? {
        return array(p);
    }
    let addon = native(p)?;
    if !addon.equals(p.get(c"decoderAddon")?)? {
        let decoder = addon.get(c"RustAgyStreamDecoder")?.construct(&[])?;
        p.set(c"decoder", decoder)?;
        p.set(c"decoderAddon", addon)?;
    }
    let raw = call(
        p.get(c"decoder")?,
        c"decode",
        &[json_call(p, c"stringify", args[0])?],
    )?;
    if raw.truthy()? {
        json_call(p, c"parse", raw)
    } else {
        array(p)
    }
}

pub(super) fn create<'a>(host: L<'a>, options: L<'a>) -> Result<L<'a>> {
    let cmd = options.get(c"cmd")?;
    let quote = function(host, "quoteAgyArgument", 1, 1, |_, a| {
        super::print_common::quote(a[0])
    })?;
    let p = fields(
        host,
        &[
            ("host", host),
            ("cmd", cmd),
            ("quote", quote),
            ("decoderAddon", null(host)?),
        ],
    )?;
    let name = text(p, "agy")?;
    fields(
        p,
        &[
            ("name", name),
            ("label", host.get(c"displayNameOf")?.call_plain(&[name])?),
            ("cmd", cmd),
            ("needsAsyncSessionIdCapture", flag(p, false)?),
            (
                "createCompletionTracker",
                function(p, "createCompletionTracker", 0, 0, |p, _| {
                    p.get(c"host")?
                        .get(c"createProtocolCompletionTracker")?
                        .call_plain(&[text(p, "agy")?])
                })?,
            ),
            (
                "buildTerminalCmd",
                function(p, "buildTerminalCmd", 0, 1, |p, a| {
                    let host = p.get(c"host")?;
                    call(
                        native(p)?,
                        c"agyTerminal",
                        &[
                            p.get(c"cmd")?,
                            default_object(a[0])?,
                            host.get(c"supportsEffort")?,
                            p.get(c"quote")?,
                        ],
                    )
                })?,
            ),
            (
                "buildInvocation",
                function(p, "buildInvocation", 1, 1, |p, a| {
                    let addon = native(p)?;
                    call(
                        addon,
                        c"agyHostInvocation",
                        &[
                            addon,
                            p.get(c"cmd")?,
                            a[0],
                            p.get(c"host")?.get(c"messageComposer")?,
                        ],
                    )
                })?,
            ),
            ("decodeEvent", function(p, "decodeEvent", 1, 1, decode)?),
        ],
    )
}
