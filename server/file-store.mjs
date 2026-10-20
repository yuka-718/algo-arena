import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { initialState } from '../shared/store.js';

/** One server process owns this store. Each committed snapshot is atomically renamed. */
export async function createFileStore(path) {
  await mkdir(dirname(path), { recursive: true });
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, 'utf8'));
    if (!Number.isSafeInteger(snapshot.version) || !snapshot.state?.users) throw new Error('Invalid arena data file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    snapshot = { version: 0, state: initialState() };
  }
  let pending = Promise.resolve();
  return {
    async load() { await pending; return structuredClone(snapshot); },
    commit(version, state) {
      const commit = pending.then(async () => {
        if (version !== snapshot.version) return false;
        const next = { version: version + 1, state: structuredClone(state) };
        const temp = `${path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
        await rename(temp, path);
        snapshot = next;
        return true;
      });
      pending = commit.catch(() => {});
      return commit;
    },
  };
}
