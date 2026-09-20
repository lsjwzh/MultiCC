'use strict';

// Minimal streaming ZIP writer, used to ship the Windows portable bundle.
//
// Why not `tar -a` / `Compress-Archive` / a dependency:
//   - GNU tar cannot write zip at all, and the tar that answers to `tar` differs
//     between Git Bash, macOS and Linux — so a cross-arch Windows build would
//     work on one runner and fail on another;
//   - the bundle holds >10k files, which rules out src/session/handoff-zip.js's
//     in-memory writer (it caps entries and total bytes on purpose);
//   - PowerShell's Compress-Archive is one more thing to keep working at a
//     distance, and it changes nothing about what the user gets.
//
// Entries stream to disk one file at a time: peak memory is the largest single
// file, not the archive. Method 0 (store) and 8 (deflate) only, zip32, UTF-8
// names — the subset src/session/handoff-zip.js's reader accepts, which is what
// the round-trip test exercises.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { crc32 } = require('../src/session/handoff-zip');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const MAX_ENTRIES = 0xffff;              // zip32 entry count field
const MAX_ARCHIVE_BYTES = 0xfffffffe;     // zip32 offset field
const MAX_NAME_BYTES = 240;

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function normalizeEntryName(name) {
  if (typeof name !== 'string' || !name.length) throw new Error('zip entry name must be a non-empty string');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new Error(`zip entry name too long (>${MAX_NAME_BYTES}B): ${name.slice(0, 60)}`);
  }
  if (name.includes('\\') || name.includes('\0')) throw new Error(`unsafe zip entry name: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`absolute zip entry name: ${name}`);
  for (const part of name.split('/')) {
    if (part === '..') throw new Error(`path traversal in zip entry name: ${name}`);
  }
  return name.endsWith('/') ? name : name;
}

// Sorted and recursive: two runs of the same bundle must produce the same
// ordering, otherwise nothing downstream (hashes, diffs) is comparable.
function collectEntries(rootDir, { logger = console } = {}) {
  const entries = [];
  const walk = dir => {
    const children = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let files = 0;
    for (const child of children) {
      const full = path.join(dir, child.name);
      const name = path.relative(rootDir, full).split(path.sep).join('/');
      if (child.isDirectory()) {
        const nested = walk(path.join(dir, child.name));
        if (!nested) entries.push({ name: `${name}/`, file: null, empty: true });
        files += 1;
      } else if (child.isFile()) {
        entries.push({ name, file: full });
        files += 1;
      } else {
        // Symlinks would be resolved by the extractor on the other end and can
        // point anywhere; the bundle never needs one.
        logger.log(`[zip-archive] skipping non-regular file: ${name}`);
      }
    }
    return files;
  };
  walk(rootDir);
  return entries;
}

function compressEntry(data) {
  const deflated = zlib.deflateRawSync(data, { level: 6 });
  return deflated.length >= data.length ? { method: 0, body: data } : { method: 8, body: deflated };
}

function writeLocalHeader(fd, { nameBuf, method, time, date, crc, storedBytes, rawBytes }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(SIG_LOCAL, 0);
  header.writeUInt16LE(20, 4);          // version needed
  header.writeUInt16LE(FLAG_UTF8, 6);   // UTF-8 names
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(storedBytes, 18);
  header.writeUInt32LE(rawBytes, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);          // extra field length
  fs.writeSync(fd, header);
  fs.writeSync(fd, nameBuf);
  return 30 + nameBuf.length;
}

function centralHeader({ nameBuf, method, time, date, crc, storedBytes, rawBytes, offset, isDir }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(SIG_CENTRAL, 0);
  header.writeUInt16LE(20, 4);          // version made by
  header.writeUInt16LE(20, 6);          // version needed
  header.writeUInt16LE(FLAG_UTF8, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(storedBytes, 20);
  header.writeUInt32LE(rawBytes, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(0, 30);          // extra
  header.writeUInt16LE(0, 32);          // comment
  header.writeUInt16LE(0, 34);          // disk start
  header.writeUInt16LE(0, 36);          // internal attributes
  // unix mode 0644/0755-in-a-zip is meaningless to Windows; keep the DOS
  // attribute bit so directory entries look like directories everywhere.
  header.writeUInt32LE(isDir ? 0x10 : 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuf]);
}

// rootDir → out (a .zip written in place). Returns { entries, bytes, sha256less }.
function createZipArchive({ rootDir, out, logger = console, stamp = new Date() } = {}) {
  if (!rootDir || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`zip root is not a directory: ${rootDir}`);
  }
  const entries = collectEntries(rootDir, { logger });
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`too many zip entries (${entries.length} > ${MAX_ENTRIES})`);
  }
  const rootName = path.basename(path.resolve(rootDir));
  const { time, date } = dosDateTime(stamp);
  fs.rmSync(out, { force: true });
  const fd = fs.openSync(out, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = normalizeEntryName(`${rootName}/${entry.name}`);
      const nameBuf = Buffer.from(name, 'utf8');
      // The central directory points back at this local header, so remember
      // where it starts before anything is written.
      const entryOffset = offset;
      if (entry.empty) {
        const { time: t, date: d } = dosDateTime(stamp);
        offset += writeLocalHeader(fd, {
          nameBuf, method: 0, time: t, date: d, crc: 0, storedBytes: 0, rawBytes: 0,
        });
        central.push(centralHeader({
          nameBuf, method: 0, time: t, date: d, crc: 0, storedBytes: 0, rawBytes: 0,
          offset: entryOffset, isDir: true,
        }));
        continue;
      }
      const data = fs.readFileSync(entry.file);
      const { method, body } = compressEntry(data);
      const crc = crc32(data);
      const stat = fs.statSync(entry.file);
      const { time: t, date: d } = dosDateTime(stat.mtime || stamp);
      offset += writeLocalHeader(fd, {
        nameBuf, method, time: t, date: d, crc, storedBytes: body.length, rawBytes: data.length,
      });
      fs.writeSync(fd, body);
      offset += body.length;
      central.push(centralHeader({
        nameBuf, method, time: t, date: d, crc, storedBytes: body.length, rawBytes: data.length,
        offset: entryOffset, isDir: false,
      }));
      if (offset > MAX_ARCHIVE_BYTES) {
        throw new Error('zip32 offset limit exceeded — the bundle is larger than 4 GB');
      }
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeSync(fd, centralBuf);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
  return { entries: entries.length, bytes: fs.statSync(out).size };
}

module.exports = {
  MAX_ENTRIES,
  collectEntries,
  createZipArchive,
  normalizeEntryName,
};
