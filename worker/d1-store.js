import { createInitialState } from '../shared/store.js';

async function encodeState(state) {
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).length < 131072) return json;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return `gzip:${btoa(binary)}`;
}
async function decodeState(value) {
  if (!value.startsWith('gzip:')) return JSON.parse(value);
  const binary = atob(value.slice(5));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export class D1Store {
  constructor(db) { this.db = db; }
  async load() {
    const row = await this.db.prepare('SELECT version, state FROM arena_state WHERE id = 1').first();
    return row ? {version: row.version, state: await decodeState(row.state)} : {version: 0, state: createInitialState()};
  }
  async commit(version, state) {
    const serialized = await encodeState(state);
    const statement = version === 0
      ? this.db.prepare('INSERT OR IGNORE INTO arena_state (id, version, state) VALUES (1, 1, ?)').bind(serialized)
      : this.db.prepare('UPDATE arena_state SET version = version + 1, state = ? WHERE id = 1 AND version = ?').bind(serialized, version);
    const result = await statement.run();
    return result.meta.changes === 1;
  }
}
