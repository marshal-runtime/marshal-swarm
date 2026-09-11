import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { SwarmEvidenceReadResult, SwarmTranscriptReadInput } from "./services.js";

import type { SwarmRun } from "./contracts.js";

const MAX_BYTES = 1024 * 1024;
/** Reads only references attached to the requested task in authoritative persisted state. */
export async function readSwarmEvidenceFile(
  run: SwarmRun,
  input: { readonly taskId: string; readonly uri: string; readonly offset?: number },
  resolveTranscript?: (input: SwarmTranscriptReadInput) => Promise<SwarmEvidenceReadResult>,
): Promise<SwarmEvidenceReadResult> {
  const task = run.tasks.find((candidate) => candidate.taskId === input.taskId);
  if (
    !task ||
    !(
      task.artifactRefs?.some((ref) => ref.uri === input.uri) ||
      task.executions?.some((execution) => execution.transcriptRef === input.uri)
    )
  ) {
    throw new Error("File is not evidence for this task.");
  }
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
    throw new Error("Invalid evidence file offset.");
  const transcripts = task.executions?.filter((execution) => execution.transcriptRef === input.uri) ?? [];
  if (transcripts.length) {
    const sessionIds = new Set(transcripts.map((execution) => execution.sessionId));
    const sessionId = transcripts[0]?.sessionId;
    if (!sessionId || sessionIds.size !== 1)
      throw new Error("Transcript evidence requires an unambiguous persisted execution sessionId.");
    if (!resolveTranscript)
      throw new Error("Transcript reader service is unavailable; raw transcript storage cannot be read.");
    return resolveTranscript({ sessionId, uri: input.uri,
      ...(input.offset === undefined ? {} : { offset: input.offset }) });
  }
  const path = input.uri.startsWith("file:") ? fileURLToPath(input.uri) : input.uri;
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Evidence must reference an absolute local file.");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Evidence must reference a regular file.");
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size)
      throw new Error("Invalid evidence file offset.");
    const buffer = Buffer.alloc(Math.min(stat.size - offset, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const end = offset + bytesRead < stat.size ? utf8Boundary(buffer, bytesRead) : bytesRead;
    const nextOffset = offset + end;
    return {
      uri: input.uri,
      text: buffer.subarray(0, end).toString("utf8"),
      truncated: nextOffset < stat.size,
      ...(nextOffset < stat.size ? { nextOffset } : {}),
    };
  } finally {
    await handle.close();
  }
}

function utf8Boundary(buffer: Buffer, length: number): number {
  let start = length - 1;
  while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return length;
  const first = buffer[start]!;
  const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return length - start < width ? start : length;
}
