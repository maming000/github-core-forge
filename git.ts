// Pure-Node git primitives: object hashing, commit/tree/tag encoding, packfile read/write
// (including OFS_DELTA / REF_DELTA), pkt-line framing and sideband chunking. No git binary,
// no wall clock, no randomness — every byte is a pure function of its inputs.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Minimal object access the graph helpers need; the store implements this. */
export interface ObjectReader {
  get(oid: string): GitObject | undefined;
}

export interface ObjectWriter extends ObjectReader {
  put(type: GitObjectType, data: Buffer): string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id git computes for `<type> <size>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Compare tree entry names the way git does: a directory name compares as if suffixed '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Encode a tree object from entries (sorted git-style). Returns the raw object bytes. */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** Encode a commit object. `epoch` is seconds; the identity lines are deterministic. */
export function buildCommitData(tree: string, parents: readonly string[], message: string, epoch: number, name: string, email: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  const ident = `${name} <${email}> ${epoch} +0000`;
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Encode an annotated tag object. */
export function buildTagData(target: string, type: GitObjectType, tag: string, message: string, epoch: number, name: string, email: string): Buffer {
  const ident = `${name} <${email}> ${epoch} +0000`;
  return Buffer.from(`object ${target}\ntype ${type}\ntag ${tag}\ntagger ${ident}\n\n${message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

/** Flatten a tree (recursively) to path -> {mode, oid} for blobs only. */
export function flattenTree(store: ObjectReader, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, pathPrefix: string): void => {
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = pathPrefix === '' ? entry.name : `${pathPrefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/**
 * Build (and store) the tree objects for a flat path map; returns the root tree oid.
 * Missing intermediate directories are created; empty directories are not represented.
 */
export function buildTreeFromFlat(store: ObjectWriter, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTreeData(entries));
  };
  return build(root);
}

/** True when `anc` is an ancestor of (or equal to) `desc`, following parent links. */
export function isAncestor(store: ObjectReader, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === anc) return true;
      stack.push(parent);
    }
  }
  return false;
}

/**
 * Walk commit generations from `tips`. When `depth` is null every ancestor is included;
 * otherwise only generations 0..depth-1 are included (generation 0 = the tips). Commits in
 * `stopAt` are not expanded (their ancestors are not walked) and are not included.
 * Returns the included commit oids and the boundary oids (the deepest included generation).
 */
export function walkCommits(
  store: ObjectReader,
  tips: readonly string[],
  depth: number | null,
  stopAt: ReadonlySet<string> = new Set(),
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let frontier: string[] = [];
  for (const tip of tips) {
    if (tip === ZERO_OID || stopAt.has(tip)) continue;
    const obj = store.get(tip);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!stopAt.has(target)) frontier.push(target);
      continue;
    }
    if (obj.type === 'commit') frontier.push(tip);
  }
  let generation = 0;
  while (frontier.length > 0) {
    if (depth !== null && generation >= depth) break;
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid) || stopAt.has(oid)) continue;
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      included.add(oid);
      if (depth !== null && generation === depth - 1) boundary.add(oid);
      for (const parent of parseCommit(obj.data).parents) {
        if (!included.has(parent) && !stopAt.has(parent)) next.push(parent);
      }
    }
    frontier = next;
    generation += 1;
  }
  return { included, boundary };
}

/** All objects reachable from a set of commits: the commits, their trees (recursive) and blobs. */
export function objectsForCommits(store: ObjectReader, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTree = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = store.get(oid);
    if (obj === undefined) return;
    out.set(oid, obj);
    if (obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) addTree(entry.oid);
  };
  for (const oid of commits) {
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = store.get(target);
      if (targetObj !== undefined) {
        out.set(target, targetObj);
        if (targetObj.type === 'commit') {
          const info = parseCommit(targetObj.data);
          addTree(info.tree);
        }
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    addTree(parseCommit(obj.data).tree);
  }
  return out;
}

/** The full ancestor commit set of `tips` (every generation), as oids. */
export function ancestorCommitSet(store: ObjectReader, tips: readonly string[]): Set<string> {
  return walkCommits(store, tips, null).included;
}

// ---------------------------------------------------------------------------------------------
// packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a plain (no-delta) version-2 packfile from objects; trailer is SHA-1 over the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      bytes.push(next);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const out: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (written !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Adler-32, the checksum a zlib stream ends with (big-endian, the last four stream bytes). */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the object whose zlib stream starts at `offset` and find the stream's end.
 * inflateSync ignores trailing bytes, so one inflate of the tail yields the object; its
 * Adler-32 then marks the stream's end in the compressed bytes (a match is verified by a
 * second inflate, so a coincidental match inside the deflate data cannot fool it). The
 * verified inflate's output is returned, so the caller never inflates the same stream twice.
 */
function inflateObject(pack: Buffer, offset: number, inflatedSize: number): { end: number; data: Buffer } {
  const data = inflateSync(pack.subarray(offset));
  if (data.length !== inflatedSize) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  let from = offset + 2;
  for (;;) {
    const at = pack.indexOf(needle, from);
    if (at < 0) throw new Error('cannot locate the end of a pack object stream');
    const end = at + 4;
    try {
      const check = inflateSync(pack.subarray(offset, end));
      if (check.length === inflatedSize) return { end, data: check };
    } catch {
      // A coincidental Adler-32 inside the deflate data: keep scanning.
    }
    from = at + 1;
  }
}

interface PackEntry {
  offset: number;
  typeCode: number;
  size: number;
  dataOffset: number;
  dataEnd: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA. Bases resolve from
 * earlier entries in the pack first, then from `resolveBase` (the repo's object store).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: the offset is a negative varint relative to this entry's start.
      byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const dataOffset = offset;
    const { end: dataEnd, data } = inflateObject(pack, dataOffset, size);
    offset = dataEnd;
    entries.push({ offset: start, typeCode, size, dataOffset, dataEnd, data, baseOffset, baseOid });
  }
  const resolve = (entry: PackEntry, seen: Set<number>): GitObject => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (seen.has(entry.offset)) throw new Error('delta cycle in packfile');
    seen.add(entry.offset);
    const inflated = entry.data;
    let result: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = entries.find((candidate) => candidate.offset === entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in packfile');
        base = resolve(baseEntry, seen);
      } else if (entry.baseOid !== undefined) {
        base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
        if (base === undefined) {
          for (const candidate of entries) {
            if (candidate.typeCode === 6 || candidate.typeCode === 7) continue;
            const candidateObj = resolve(candidate, new Set(seen));
            if (hashObject(candidateObj.type, candidateObj.data) === entry.baseOid) {
              base = candidateObj;
              break;
            }
          }
        }
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      }
      if (base === undefined) throw new Error('delta has no base');
      result = { type: base.type, data: applyDelta(base.data, inflated) };
    } else {
      const type = PACK_TYPES[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      result = { type, data: inflated };
    }
    const oid = hashObject(result.type, result.data);
    objects.set(oid, result);
    byOffset.set(entry.offset, result);
    return result;
  };
  for (const entry of entries) resolve(entry, new Set());
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines

/** Encode one pkt-line (`<4-hex length><payload>`). Payloads over 65516 bytes are the caller's job. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode pkt-lines from the start of `buf`. Stops at the first flush/delim or at the end of the
 * framed region; `rest` is the bytes after the terminating control packet (the raw pack in a
 * receive-pack request, or trailing bytes the caller owns).
 */
export function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Encode a sideband pkt-line: band byte + data, chunked so no pkt-line exceeds 65520 bytes. */
export function sidebandChunks(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  if (data.length === 0) {
    out.push(pktLine(Buffer.concat([Buffer.from([band]), Buffer.alloc(0)])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += maxData) {
    const chunk = data.subarray(offset, offset + maxData);
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}
