import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function validBundleDirectory(directory) {
  return fs.existsSync(path.join(directory, '.complete'))
    && fs.existsSync(path.join(directory, 'index.html'));
}

export async function ensureBundleCache({
  cacheDirectory,
  build,
  pollMilliseconds = 250,
  staleLockMilliseconds = 10 * 60_000,
} = {}) {
  const lockDirectory = `${cacheDirectory}.lock`;
  fs.mkdirSync(path.dirname(cacheDirectory), { recursive: true });
  let waitedForLock = false;
  for (;;) {
    if (validBundleDirectory(cacheDirectory)) {
      return { serveUrl: cacheDirectory, cacheHit: true, waitedForLock };
    }
    try {
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      waitedForLock = true;
      let lockAge = 0;
      try {
        lockAge = Date.now() - fs.statSync(lockDirectory).mtimeMs;
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (lockAge > staleLockMilliseconds) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      await wait(pollMilliseconds);
      continue;
    }

    const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (validBundleDirectory(cacheDirectory)) {
        return { serveUrl: cacheDirectory, cacheHit: true, waitedForLock };
      }
      await build(temporaryDirectory);
      if (!fs.existsSync(path.join(temporaryDirectory, 'index.html'))) {
        throw new Error('Remotion bundle did not produce index.html');
      }
      fs.writeFileSync(path.join(temporaryDirectory, '.complete'), `${new Date().toISOString()}\n`);
      if (fs.existsSync(cacheDirectory)) fs.rmSync(cacheDirectory, { recursive: true, force: true });
      fs.renameSync(temporaryDirectory, cacheDirectory);
      return { serveUrl: cacheDirectory, cacheHit: false, waitedForLock };
    } finally {
      if (fs.existsSync(temporaryDirectory)) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  }
}
