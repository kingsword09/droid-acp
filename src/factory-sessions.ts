import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface FactorySessionRecord {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  jsonlPath: string;
}

const DEFAULT_PAGE_SIZE = 50;
const HEADER_SCAN_BYTES = 8192;

function getFactoryDir(): string {
  return process.env.DROID_ACP_FACTORY_DIR ?? path.join(os.homedir(), ".factory");
}

function getFactorySessionsDir(): string {
  return path.join(getFactoryDir(), "sessions");
}

function encodeCwdToFactorySessionsDirName(cwd: string): string {
  // Droid stores sessions under ~/.factory/sessions/<cwd-with-path-separators-replaced-by-dashes>
  // Example: /Users/me/project -> -Users-me-project
  return cwd.replace(/[\\/]/g, "-");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readFactorySessionStart(
  jsonlPath: string,
): Promise<{ cwd: string | null; title: string | null } | null> {
  const handle = await fs.open(jsonlPath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.toString("utf8", 0, bytesRead);
    const firstLine = chunk.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as unknown;
    const obj = parsed as { type?: unknown; cwd?: unknown; title?: unknown };
    if (obj.type !== "session_start") return null;

    return {
      cwd: typeof obj.cwd === "string" ? obj.cwd : null,
      title: typeof obj.title === "string" ? obj.title : null,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function factorySessionHasMessages(jsonlPath: string): Promise<boolean> {
  const handle = await fs.open(jsonlPath, "r");
  try {
    const buffer = Buffer.alloc(HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return false;

    const chunk = buffer.toString("utf8", 0, bytesRead);
    const newlineIndex = chunk.indexOf("\n");
    if (newlineIndex === -1) {
      const stat = await handle.stat();
      return stat.size > bytesRead;
    }

    if (chunk.slice(newlineIndex + 1).trim().length > 0) return true;

    const stat = await handle.stat();
    return stat.size > newlineIndex + 1;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

export async function resolveFactorySessionJsonlPath(params: {
  sessionId: string;
  cwd: string;
}): Promise<string | null> {
  const sessionsDir = getFactorySessionsDir();
  const direct = path.join(
    sessionsDir,
    encodeCwdToFactorySessionsDirName(params.cwd),
    `${params.sessionId}.jsonl`,
  );
  if (await pathExists(direct)) return direct;

  // Fallback: scan all cwd directories (useful if the client passed a different cwd).
  let dirents: Array<{ name: string; isDirectory?: () => boolean }> = [];
  try {
    dirents = (await fs.readdir(sessionsDir, { withFileTypes: true })) as typeof dirents;
  } catch {
    return null;
  }

  for (const d of dirents) {
    if (typeof d.isDirectory === "function" && !d.isDirectory()) continue;
    const candidate = path.join(sessionsDir, d.name, `${params.sessionId}.jsonl`);
    if (await pathExists(candidate)) return candidate;
  }

  return null;
}

export async function listFactorySessions(params: {
  cwd?: string | null;
  cursor?: string | null;
  preferredCwd?: string | null;
  pageSize?: number;
  includeEmpty?: boolean;
}): Promise<{ sessions: FactorySessionRecord[]; nextCursor: string | null }> {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const sessionsDir = getFactorySessionsDir();
  const cwdFilter = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null;
  const preferredCwd =
    typeof params.preferredCwd === "string" && params.preferredCwd.length > 0
      ? params.preferredCwd
      : null;
  const includeEmpty = params.includeEmpty === true;

  const scanDirs: string[] = [];
  if (cwdFilter) {
    scanDirs.push(path.join(sessionsDir, encodeCwdToFactorySessionsDirName(cwdFilter)));
  } else {
    try {
      const dirents = await fs.readdir(sessionsDir, { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        scanDirs.push(path.join(sessionsDir, d.name));
      }
    } catch {
      return { sessions: [], nextCursor: null };
    }
  }

  const records: FactorySessionRecord[] = [];
  for (const dir of scanDirs) {
    if (!(await pathExists(dir))) continue;

    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      const jsonlPath = path.join(dir, entry);

      let updatedAt: string | null = null;
      try {
        const stat = await fs.stat(jsonlPath);
        updatedAt = stat.mtime.toISOString();
      } catch {}

      const header = await readFactorySessionStart(jsonlPath);
      const cwd = header?.cwd ?? cwdFilter ?? "";
      if (cwd.length === 0) continue;
      if (cwdFilter && cwd !== cwdFilter) continue;
      if (!includeEmpty && !(await factorySessionHasMessages(jsonlPath))) continue;

      records.push({
        sessionId,
        cwd,
        title: header?.title ?? null,
        updatedAt,
        jsonlPath,
      });
    }
  }

  records.sort((a, b) => {
    const aPreferred = preferredCwd !== null && a.cwd === preferredCwd;
    const bPreferred = preferredCwd !== null && b.cwd === preferredCwd;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;

    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return bTime - aTime;
  });

  const offset = (() => {
    if (typeof params.cursor !== "string" || params.cursor.length === 0) return 0;
    const parsed = Number.parseInt(params.cursor, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  })();

  const sessions = records.slice(offset, offset + pageSize);
  const nextCursor = offset + pageSize < records.length ? String(offset + pageSize) : null;

  return { sessions, nextCursor };
}

export async function* streamFactorySessionJsonl(jsonlPath: string): AsyncGenerator<unknown> {
  const stream = createReadStream(jsonlPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
  }
}
