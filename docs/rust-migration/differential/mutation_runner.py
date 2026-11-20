#!/usr/bin/env python3
"""Shared runner for the kernel mutation suites in this directory.

A differential that is green proves nothing until every rule it claims to pin
is shown to be load-bearing: break the rule, and the corpus test must go red.
Each suite lists variants -- the unmodified source plus one source per broken
rule -- and this runner executes them in an isolated copy of the workspace.

Three things the older, hand-copied runners did not guard, and this one does:

* A variant that FAILS TO COMPILE is not evidence. `cargo test` exits non-zero
  for a syntax error exactly as it does for a failing assertion, so a runner
  that only checks the exit code reports a typo as a "detected mutation". Here
  a variant counts as detected only when the test binary ran and a test
  FAILED; a compile error aborts the suite so the batch can be fixed and
  re-run. A baseline that does not pass aborts for the same reason.
* A filter that matches no tests also exits 0. The baseline must report at
  least `min_tests` passing tests, so a renamed module cannot turn the suite
  into a vacuous pass.
* A mutation that does not change the source is a bug in the suite, not a
  survivor. `Mutator.apply` requires its target to occur exactly once in the
  production half of the file (test code is never mutated).

Variants a corpus cannot distinguish are NOT listed as mutations; the suite
documents them in comments instead, so the coverage claimed is the coverage
that exists.
"""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
DIFFERENTIAL = ROOT / "docs/rust-migration/differential"
TEST_MARKER = "#[cfg(test)]\nmod tests {"


class Mutator:
    """Applies string replacements to the production half of a kernel."""

    def __init__(self, source):
        if TEST_MARKER not in source:
            raise SystemExit("kernel has no `#[cfg(test)] mod tests {` marker")
        self.head, self.tail = source.split(TEST_MARKER, 1)

    def apply(self, old, new, label):
        count = self.head.count(old)
        if count != 1:
            raise SystemExit(
                f"{label}: the target must occur exactly once in production code, found {count}\n"
                f"target: {old!r}")
        if old == new:
            raise SystemExit(f"{label}: the replacement is identical to the target")
        return self.head.replace(old, new, 1) + TEST_MARKER + self.tail


def _repoint(source, corpus_file):
    """Point the kernel's test at the frozen corpus instead of the temp copy."""
    pattern = re.compile(
        r'concat!\(\s*env!\("CARGO_MANIFEST_DIR"\),\s*"/\.\./\.\./docs/rust-migration/differential/'
        + re.escape(corpus_file) + r'"\s*,?\s*\)')
    absolute = f'"{DIFFERENTIAL / corpus_file}"'
    patched, count = pattern.subn(lambda _m: absolute, source)
    if count != 1:
        raise SystemExit(f"could not repoint the corpus path for {corpus_file} (matched {count})")
    return patched


def _summarise(output):
    """(compiled, ran, passed, failed, failing test names) from cargo output."""
    # Only cargo's own "could not compile" line marks a build failure. A bare
    # `^error:` match is wrong: when a test FAILS, cargo ends with
    # `error: test failed, to rerun pass ...`, which would make every detected
    # mutation look like a compile error and abort the batch.
    compile_error = "could not compile" in output
    results = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed", output)
    passed = sum(int(p) for p, _ in results)
    failed = sum(int(f) for _, f in results)
    names = re.findall(r"^test (\S+) \.\.\. FAILED$", output, re.M)
    return (not compile_error), bool(results), passed, failed, names


def run_suite(kernel, corpus_file, test_filter, variants, min_tests, tag):
    """`variants` is [(name, source, should_pass)]; the first must be the baseline."""
    only = set(sys.argv[1:])
    kernel_path = ROOT / kernel
    kernel_name = kernel_path.name
    with tempfile.TemporaryDirectory(prefix=f"multicc-{tag}-mutations-") as tmp:
        tmp = Path(tmp)
        workspace = tmp / "native"
        workspace.mkdir()
        shutil.copytree(ROOT / "native/core", workspace / "core")
        shutil.copytree(ROOT / "native/cpr", workspace / "cpr")
        # Other kernels in this crate read their own frozen corpora through
        # relative paths, so the copy carries the same docs tree.
        corpora = tmp / "docs/rust-migration/differential"
        corpora.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(DIFFERENTIAL, corpora)
        # The crate's tests also read the frozen oracles and fixtures that live
        # under tests/ (`include_bytes!`/`include_str!` through ../../tests/...:
        # chat_replay_buffer.rs pins its corpus to the oracle's bytes, and the
        # auto-provider and gateway kernels read tests/fixtures). A workspace
        # without them does not compile at all -- which the compile guard below
        # reports as an aborted batch rather than a detection, and which is
        # how a missing copy was found here. Copy exactly what is read.
        for sub in ("tests/helpers", "tests/fixtures"):
            source_dir = ROOT / sub
            if source_dir.is_dir():
                target = tmp / sub
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(source_dir, target)
        (workspace / "Cargo.toml").write_text('[workspace]\nmembers=["core"]\nresolver="2"\n')
        shutil.copy2(ROOT / "native/Cargo.lock", workspace / "Cargo.lock")
        env = dict(os.environ, CARGO_TARGET_DIR=str(tmp / "target"))

        detected = 0
        mutants = 0
        for name, source, should_pass in variants:
            if only and name not in only and name != "baseline":
                continue
            if not should_pass:
                mutants += 1
            patched = _repoint(source, corpus_file)
            (workspace / "core" / "src" / kernel_name).write_text(patched)
            run = subprocess.run(
                ["cargo", "test", "--offline", "--manifest-path", str(workspace / "Cargo.toml"),
                 "-p", "multicc-core", "--lib", test_filter],
                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
            compiled, ran, passed, failed, names = _summarise(run.stdout)
            if not compiled:
                raise SystemExit(
                    f"{name}: DID NOT COMPILE -- this is not evidence either way. Fix the variant "
                    f"and re-run the batch.\n{run.stdout[-3000:]}")
            if should_pass:
                if run.returncode != 0 or failed or passed < min_tests:
                    raise SystemExit(
                        f"{name}: the baseline must pass with at least {min_tests} tests "
                        f"(passed={passed} failed={failed} exit={run.returncode})\n{run.stdout[-4000:]}")
                print(f"{name}: passed ({passed} tests)", flush=True)
                continue
            if run.returncode == 0 or not ran or not failed:
                raise SystemExit(
                    f"{name}: SURVIVED -- the corpus did not notice this broken rule "
                    f"(exit={run.returncode} passed={passed} failed={failed})\n{run.stdout[-3000:]}")
            detected += 1
            print(f"{name}: mutation detected by {', '.join(n.split('::')[-1] for n in names)}",
                  flush=True)
        print(f"{tag}: {detected}/{mutants} mutations detected", flush=True)
