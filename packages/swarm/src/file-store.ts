import {
  open,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertSwarmRunId,
  replaySwarmRun,
  validateSwarmRunEvent,
  type SwarmRunCreateConfiguration,
  type SwarmRunEvent,
  type SwarmRunTarget,
  type SwarmRunUpdateEvent,
} from "./contracts.js";
import {
  cloneEvent,
  SwarmRunAlreadyExistsError,
  SwarmRunNotFoundError,
  type SwarmRunEventStore,
} from "./store.js";
/** Atomic replacement journals: a failed append cannot expose half an event. */
export class FileSwarmRunEventStore implements SwarmRunEventStore {
  private readonly directory: string;
  private readonly ready: Promise<void>;
  private static readonly queues = new Map<string, Promise<void>>();
  constructor(directory: string) {
    if (!path.isAbsolute(directory))
      throw new TypeError("Swarm event directory must be an absolute path.");
    this.directory = path.resolve(directory);
    this.ready = mkdir(this.directory, { recursive: true }).then(
      () => undefined,
    );
  }
  async create(
    runId: string,
    objective: string,
    scope: string,
    targetRef?: string,
    targetHead?: string,
    targets?: readonly SwarmRunTarget[],
    configuration?: SwarmRunCreateConfiguration,
  ): Promise<void> {
    await this.ready;
    const event = validateSwarmRunEvent({
      type: "run.created",
      protocolVersion: 2,
      runId,
      objective,
      scope,
      ...(targetRef === undefined ? {} : { targetRef }),
      ...(targetHead === undefined ? {} : { targetHead }),
      ...(targets === undefined ? {} : { targets }),
      ...configuration,
    });
    let file;
    try {
      file = await open(this.runPath(runId), "wx");
      await file.writeFile(`${JSON.stringify(event)}\n`);
      await file.sync();
    } catch (error) {
      if (code(error) === "EEXIST") throw new SwarmRunAlreadyExistsError(runId);
      throw error;
    } finally {
      await file?.close();
    }
  }
  async append(runId: string, event: SwarmRunUpdateEvent): Promise<void> {
    await this.ready;
    const target = this.runPath(runId);
    const previous =
      FileSwarmRunEventStore.queues.get(target) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    FileSwarmRunEventStore.queues.set(target, pending);
    await previous;
    // The lock records its process owner so a restart can recover a dead owner.
    let lock;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      lock = await acquireLock(`${target}.lock`);
      const current = await this.read(runId);
      if (replaySwarmRun(current).legacyReadOnly)
        throw new Error("Legacy runs are read-only.");
      const events = [...current, validateSwarmRunEvent(event)];
      replaySwarmRun(events);
      const file = await open(temporary, "wx");
      try {
        await file.writeFile(
          events.map((item) => JSON.stringify(item)).join("\n") + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      try {
        await rm(temporary, { force: true });
        if (lock) {
          await lock.release();
        }
      } finally {
        release();
        if (FileSwarmRunEventStore.queues.get(target) === pending)
          FileSwarmRunEventStore.queues.delete(target);
      }
    }
  }
  async read(runId: string): Promise<readonly SwarmRunEvent[]> {
    await this.ready;
    let text: string;
    try {
      text = await readFile(this.runPath(runId), "utf8");
    } catch (error) {
      if (code(error) === "ENOENT") throw new SwarmRunNotFoundError(runId);
      throw error;
    }
    const events = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    if (replaySwarmRun(events).runId !== runId)
      throw new Error("Swarm journal identity mismatch.");
    return events.map((event) => cloneEvent(event as SwarmRunEvent));
  }
  async list(): Promise<readonly string[]> {
    await this.ready;
    return Object.freeze(
      (await readdir(this.directory, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith("run-") &&
            entry.name.endsWith(".jsonl"),
        )
        .map((entry) => decodeURIComponent(entry.name.slice(4, -6)))
        .sort(),
    );
  }
  private runPath(runId: string): string {
    assertSwarmRunId(runId);
    return path.join(this.directory, `run-${encodeURIComponent(runId)}.jsonl`);
  }
}
function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

interface JournalLockOwner {
  readonly pid: number;
  readonly token: string;
}
interface JournalLock {
  release(): Promise<void>;
}

/** Atomic linking makes it impossible to observe a partially written lock owner. */
async function createLock(filePath: string): Promise<JournalLock> {
  const owner: JournalLockOwner = { pid: process.pid, token: randomUUID() };
  const preparedPath = `${filePath}.prepared-${owner.token}`;
  const prepared = await open(preparedPath, "wx");
  try {
    await prepared.writeFile(JSON.stringify(owner));
    await prepared.sync();
    await prepared.close();
    await link(preparedPath, filePath);
  } catch (error) {
    await prepared.close().catch(() => undefined);
    throw error;
  } finally {
    await rm(preparedPath, { force: true });
  }
  return {
    async release() {
      // A live owner is never reclaimed, but verify the token before cleanup so
      // external replacement cannot cause us to remove somebody else's lock.
      const current = await readLockOwner(filePath);
      if (current?.token === owner.token) await rm(filePath);
    },
  };
}

async function readLockOwner(
  filePath: string,
): Promise<JournalLockOwner | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw new Error(
      "Swarm journal lock has no valid owner; refusing unsafe recovery.",
      { cause: error },
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("pid" in raw) ||
    !("token" in raw) ||
    typeof raw.pid !== "number" ||
    !Number.isSafeInteger(raw.pid) ||
    raw.pid <= 0 ||
    typeof raw.token !== "string" ||
    !raw.token
  )
    throw new Error("Invalid journal lock owner.");
  return { pid: raw.pid, token: raw.token };
}

function requireDeadOwner(owner: JournalLockOwner): void {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (code(error) === "ESRCH") return;
    throw error;
  }
  throw new Error(
    "Swarm journal is locked by a live process; retry the append.",
  );
}

async function acquireLock(
  filePath: string,
  recoveryDepth = 0,
): Promise<JournalLock> {
  try {
    return await createLock(filePath);
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  const owner = await readLockOwner(filePath);
  if (!owner) return createLock(filePath);
  requireDeadOwner(owner);
  // A second reclaimer must not rename a newly acquired lock after observing a
  // stale owner. Serialize reclaimers, then re-read the authoritative owner.
  // Recovery locks use this same crash-safe protocol. Repeated crashes during
  // recovery are bounded and fail closed rather than growing paths indefinitely.
  if (recoveryDepth >= 8)
    throw new Error("Journal lock recovery depth exhausted.");
  const recovery = await acquireLock(`${filePath}.recovery`, recoveryDepth + 1);
  try {
    const current = await readLockOwner(filePath);
    if (current) {
      requireDeadOwner(current);
      const quarantine = `${filePath}.dead-${randomUUID()}`;
      await rename(filePath, quarantine);
      await rm(quarantine);
    }
    return await createLock(filePath);
  } finally {
    await recovery.release();
  }
}
