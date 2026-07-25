'use strict';

const path = require('path');

const DEFAULT_ZCODE_ENGINE = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

function zcodeEngineCandidates({ isWindows = process.platform === 'win32', homeDir } = {}) {
  if (isWindows) return [];
  return [
    DEFAULT_ZCODE_ENGINE,
    homeDir ? path.join(homeDir, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs') : null,
  ].filter(Boolean);
}

module.exports = { DEFAULT_ZCODE_ENGINE, zcodeEngineCandidates };
