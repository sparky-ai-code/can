// Stub for a can: @ff-labs/fff-node is a native addon. The file finder reports itself unavailable, which the
// server handles as a search index that cannot be created.
export class FileFinder {
  static create() { return { ok: false, error: 'fff-node is not available in a can (native addon)' }; }
}
export default { FileFinder };
