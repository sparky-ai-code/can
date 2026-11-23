// Stub for bun:sqlite, which exists only under Bun. The server uses node:sqlite under Node, which a can provides.
export class Database {
  constructor() { throw new Error('bun:sqlite is not available under Node (use node:sqlite)'); }
}
