/** Atomic, versioned stores shared by the Node server and Worker API. */
export function initialState() {
  return { schemaVersion: 1, users: {}, sessions: {}, rooms: {}, queue: [], history: [], limits: {} };
}

export const createInitialState = initialState;

export function createMemoryStore(seed = initialState()) {
  let snapshot = { version: 0, state: structuredClone(seed) };
  return {
    async load() { return structuredClone(snapshot); },
    async commit(version, state) {
      if (version !== snapshot.version) return false;
      snapshot = { version: version + 1, state: structuredClone(state) };
      return true;
    },
  };
}
