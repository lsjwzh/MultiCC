'use strict';

const fs = require('fs');

let temporaryCounter = 0;

function createMemoFilePort({ fsImpl = fs } = {}) {
  return Object.freeze({
    readText(file) {
      return fsImpl.readFileSync(file, 'utf8');
    },
    stat(file) {
      return fsImpl.statSync(file);
    },
    exists(file) {
      return fsImpl.existsSync(file);
    },
    writeAtomic(file, text) {
      const temporary = `${file}.tmp.${process.pid}.${temporaryCounter++}`;
      try {
        fsImpl.writeFileSync(temporary, text, 'utf8');
        fsImpl.renameSync(temporary, file);
      } catch (error) {
        try { fsImpl.unlinkSync(temporary); } catch (_) {}
        throw error;
      }
    },
  });
}

module.exports = { createMemoFilePort };
