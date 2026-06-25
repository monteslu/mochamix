/**
 * SQLite backend: a thin adapter over node-sqlite3-wasm presenting the small
 * subset of the better-sqlite3 API the rest of this package uses (.prepare().get/
 * all/run with spread params, .exec, .pragma, .transaction). Pure WASM — no native
 * addon, no node-gyp, no electron-rebuild: the same .wasm runs on every OS/ABI
 * (Node AND Electron) with zero build toolchain. (Replaces better-sqlite3, which
 * compiled from source under Electron's ABI.)
 *
 * Differences node-sqlite3-wasm vs better-sqlite3 that this adapter papers over:
 *   - statements take params as an array/object, not spread → we collect spread
 *     args and translate named (@x / $x / :x) binds.
 *   - no .pragma() helper → routed through run()/get() on a PRAGMA statement.
 *   - no .transaction(fn) helper → manual BEGIN/COMMIT/ROLLBACK.
 *   - statements should be finalized → we finalize after each call (these queries
 *     are not hot; correctness + no WASM leaks beats statement caching here).
 */

// node-sqlite3-wasm is a CommonJS module kept external in the (ESM) main bundle.
// Node's ESM loader exposes neither its named exports (`import { Database }`) nor
// its namespace (`import * as`) — both yield undefined / throw at load. A true CJS
// `require` via createRequire is the only form that resolves `.Database` at
// runtime (verified against the real Node ESM loader). esbuild already injects a
// createRequire in the ESM main bundle, so import.meta.url is valid here.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const nodeRequire = createRequire(import.meta.url);
const { Database: WasmDatabase } = nodeRequire('node-sqlite3-wasm') as typeof import('node-sqlite3-wasm');
type WasmDatabase = import('node-sqlite3-wasm').Database;

export type BindParams = unknown[] | Record<string, unknown>;
type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** A prepared statement shaped like better-sqlite3's. */
export class Statement {
  constructor(
    private readonly db: WasmDatabase,
    private readonly sql: string,
  ) {}

  private normalize(args: unknown[]): BindParams | undefined {
    if (args.length === 0) return undefined;
    // better-sqlite3 callers pass either spread positional args, or a single
    // object for named binds. Mirror both. better-sqlite3 accepts bare keys
    // (`{location}` for an `@location` placeholder); node-sqlite3-wasm wants the
    // key to include the sigil, so prefix bare keys with `@`.
    if (args.length === 1 && isPlainObject(args[0])) {
      const obj = args[0] as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[/^[@$:]/.test(k) ? k : `@${k}`] = v;
      }
      return out;
    }
    return args as unknown[];
  }

  get(...args: unknown[]): Row | undefined {
    const stmt = this.db.prepare(this.sql);
    try {
      const r = stmt.get(this.normalize(args) as never);
      return (r ?? undefined) as Row | undefined;
    } finally {
      stmt.finalize();
    }
  }

  all(...args: unknown[]): Row[] {
    const stmt = this.db.prepare(this.sql);
    try {
      return stmt.all(this.normalize(args) as never) as Row[];
    } finally {
      stmt.finalize();
    }
  }

  run(...args: unknown[]): RunResult {
    const stmt = this.db.prepare(this.sql);
    try {
      const r = stmt.run(this.normalize(args) as never);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    } finally {
      stmt.finalize();
    }
  }
}

/** better-sqlite3-shaped wrapper over a node-sqlite3-wasm Database. */
export class SqliteDb {
  readonly inner: WasmDatabase;

  constructor(path: string) {
    // node-sqlite3-wasm won't create the DB file if its parent dir is missing
    // (better-sqlite3 did). Ensure the directory exists first — matters on a
    // fresh machine before Electron's userData dir has been created. Also
    // normalize to an absolute path: the WASM module resolves relative paths
    // against process.cwd(), which is unreliable in a packaged app.
    const isMemory = path === ':memory:' || path.startsWith('file::memory:');
    const dbPath = isMemory ? path : resolve(path);
    if (!isMemory) {
      try {
        mkdirSync(dirname(dbPath), { recursive: true });
      } catch {
        /* dir already exists or path has no dir component */
      }
      // node-sqlite3-wasm locks via a `<db>.lock` DIRECTORY (mkdir mutex). If the
      // app crashed while open, that dir is orphaned and every future open throws
      // "database is locked". Electron is single-instance, so any lock present at
      // construction is stale — remove it.
      const lockDir = `${dbPath}.lock`;
      try {
        if (existsSync(lockDir) && statSync(lockDir).isDirectory()) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        /* best-effort */
      }
      // The WASM VFS doesn't support WAL; a leftover `-wal`/`-shm`/`-journal`
      // sidecar (from an earlier build that asked for WAL) makes the open fail with
      // "unable to open database file". They're disposable rollback artifacts —
      // remove any that exist before opening. (This was the real recurring DB bug.)
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    try {
      this.inner = new WasmDatabase(dbPath);
    } catch (e) {
      // Retry once after forcibly clearing the lock dir again (covers a lock that
      // reappeared, or a first-open that created it then failed mid-init).
      if (!isMemory) {
        try {
          rmSync(`${dbPath}.lock`, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        try {
          this.inner = new WasmDatabase(dbPath);
          return;
        } catch {
          /* fall through to the thrown error below */
        }
      }
      throw new Error(`SqliteDb: failed to open database at "${dbPath}": ${String(e)}`);
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this.inner, sql);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  /**
   * better-sqlite3 pragma(): `pragma('user_version', {simple:true})` returns the
   * scalar; `pragma('journal_mode = WAL')` just runs it.
   */
  pragma(source: string, opts?: { simple?: boolean }): unknown {
    const sql = `PRAGMA ${source}`;
    if (/=/.test(source)) {
      this.inner.run(sql);
      return undefined;
    }
    const stmt = this.inner.prepare(sql);
    try {
      const row = stmt.get() as Row | null;
      if (!row) return undefined;
      const val = Object.values(row)[0];
      return opts?.simple ? val : row;
    } finally {
      stmt.finalize();
    }
  }

  /** better-sqlite3 transaction(fn): returns a callable that wraps fn in a tx. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.inner.run('BEGIN');
      try {
        const out = fn(...args);
        this.inner.run('COMMIT');
        return out;
      } catch (e) {
        try {
          this.inner.run('ROLLBACK');
        } catch {
          /* already rolled back / not in tx */
        }
        throw e;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
