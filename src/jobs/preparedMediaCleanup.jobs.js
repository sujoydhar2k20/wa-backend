const fs = require('fs');
const path = require('path');
const os = require('os');
const { logger } = require('../utils/logger');

/**
 * Deletes converted media files that are no longer needed:
 *  - <upload dir>/prepared/*  kept so a retry does not convert again; removed on success, and here after 3 days
 *  - <tmp>/bjs-media/*        per-request temp files left behind by a crash (older than 6 hours)
 *  - <upload dir>/uploads/*.part  uploads that never completed (older than 1 day)
 * Never touches the original uploads.
 */
async function sweepDir(dir, maxAgeMs, only = null) {
  let removed = 0;
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.lstat(p);
      if (st.isFile() && (!only || only.test(name)) && now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(p);
        removed += 1;
      }
    } catch { /* gone already */ }
  }
  return removed;
}

module.exports = (agenda) => {
  agenda.define('cleanup-prepared-media', async () => {
    const { preparedDir } = require('../services/media/mediaPipeline');
    const a = await sweepDir(preparedDir(), 3 * 24 * 3600 * 1000);
    const b = await sweepDir(path.join(os.tmpdir(), 'bjs-media'), 6 * 3600 * 1000);
    // Interrupted uploads (multer writes "<name>.part" and renames it when complete).
    const { targetDir } = require('../middleware/mediaUpload.middleware');
    const c = await sweepDir(targetDir(), 24 * 3600 * 1000, /\.part$/);
    if (a || b || c) logger.info(`[media] cleanup removed ${a} prepared, ${b} temp and ${c} interrupted upload files`);
  });
};

module.exports.sweepDir = sweepDir;
