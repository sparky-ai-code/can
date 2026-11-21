// Paged snapshots. A can's file tree crosses the VM boundary a page at a time, never whole. Saving used to encode
// every file as base64 inside the VM and send one message holding all of it, so a tree of a few tens of MB pushed
// the VM past its heap cap while it built the copies. Now the VM lists the tree (VFS.snapshotRecords), the host asks
// for it page by page, and the host writes the saved file. Restores run the other way. The saved file keeps its
// format (can-snapshot v1 with a can-vfs v1 tree), so cans saved before this change still load.
//
// Records: { segs, type, mode, mtime, ctime, birthtime, data | target }, in pre-order. A wire record is
// { segs, node }, where node is the saved form of one node with no children (a folder's children are records of
// their own). Both sides use the same records, so a page never holds more than PAGE_BYTES of file data.
import { decodeNode } from '../kernel/vfs.js';

/** Raw file bytes per page. Each page is one IPC message, so this bounds the copies made for it. */
export const PAGE_BYTES = 2 * 1024 * 1024;
/** Records per page, whatever their size. */
export const MAX_RECORDS = 1000;

/** The saved form of one record, without children. Field order matches VFS.serialize. */
export function encodeRecord(rec) {
  const meta = { type: rec.type, mode: rec.mode, mtime: rec.mtime, ctime: rec.ctime, birthtime: rec.birthtime };
  if (rec.type === 'file') return { ...meta, data: rec.data.toString('base64') };
  if (rec.type === 'symlink') return { ...meta, target: rec.target };
  return { ...meta, entries: {} };
}

/**
 * VM side. The page of wire records that starts at index `from`, stopping before PAGE_BYTES of file data (at least
 * one record is always sent). `next` is the index of the following page, or null after the last record.
 */
export function takePage(records, from) {
  const out = [];
  let bytes = 0;
  let i = from;
  while (i < records.length && out.length < MAX_RECORDS) {
    const rec = records[i];
    const size = rec.type === 'file' ? rec.data.length : 0;
    if (out.length > 0 && bytes + size > PAGE_BYTES) break;
    out.push({ segs: rec.segs, node: encodeRecord(rec) });
    bytes += size;
    i += 1;
  }
  return { records: out, next: i < records.length ? i : null };
}

/** Looks up the saved folder at `segs` under an encoded root, by walking own properties (safe for any name). */
function encodedAt(root, segs) {
  let node = root;
  for (const seg of segs) {
    const d = Object.getOwnPropertyDescriptor(node.entries, seg);
    if (!d) throw new Error(`snapshot page refers to a missing folder: ${segs.join('/')}`);
    node = d.value;
  }
  return node;
}

/**
 * Host side. Adds one page of wire records to the saved-form tree being built. Returns the root. Records must arrive
 * in pre-order, as takePage sends them.
 */
export function attachEncoded(root, records) {
  let top = root;
  for (const { segs, node } of records) {
    if (segs.length === 0) {
      top = node;
      continue;
    }
    const parent = encodedAt(top, segs.slice(0, -1));
    Object.defineProperty(parent.entries, segs[segs.length - 1], {
      value: node, enumerable: true, writable: true, configurable: true,
    });
  }
  return top;
}

/** Host side. The pre-order wire records of a saved-form tree (the inverse of attachEncoded), for a paged restore. */
export function flattenEncoded(root) {
  const out = [];
  const walk = (node, segs) => {
    if (node.type === 'dir') {
      out.push({ segs, node: { ...node, entries: {} } });
      for (const [name, child] of Object.entries(node.entries ?? {})) walk(child, [...segs, name]);
    } else {
      out.push({ segs, node });
    }
  };
  walk(root, []);
  return out;
}

/** Host side. Groups wire records into pages of at most PAGE_BYTES raw file data (base64 is 4/3 of that). */
export function pagesFor(records) {
  const budget = Math.ceil((PAGE_BYTES * 4) / 3);
  const pages = [];
  let page = [];
  let bytes = 0;
  for (const rec of records) {
    const size = typeof rec.node.data === 'string' ? rec.node.data.length : 0;
    if (page.length > 0 && (bytes + size > budget || page.length >= MAX_RECORDS)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(rec);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/**
 * VM side. Adds one page of wire records to the tree being restored. Returns the root (a decoded tree whose folders
 * hold Maps). The first record is the root folder.
 */
export function attachDecoded(root, records) {
  let top = root;
  for (const { segs, node } of records) {
    const decoded = decodeNode(node);
    if (segs.length === 0) {
      top = decoded;
      continue;
    }
    let parent = top;
    for (const seg of segs.slice(0, -1)) {
      const next = parent.entries.get(seg);
      if (!next) throw new Error(`snapshot page refers to a missing folder: ${segs.join('/')}`);
      parent = next;
    }
    parent.entries.set(segs[segs.length - 1], decoded);
  }
  return top;
}
