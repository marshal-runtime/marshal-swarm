import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi } from "vitest";

import type { SwarmRun } from "../src/contracts.js";
import { readSwarmEvidenceFile } from "../src/read-evidence-file.js";

describe("evidence file access", () => {
  it("never raw-reads a transcript even when the same URI is also an artifact", async () => {
    const uri = "/encrypted/transcript.json";
    const run = { tasks: [{ taskId: "task", artifactRefs: [{ uri }], executions: [{ transcriptRef: uri, sessionId: "persisted-session" }] }] } as unknown as SwarmRun;
    await expect(readSwarmEvidenceFile(run, { taskId: "task", uri })).rejects.toThrow("Transcript reader service is unavailable");
    const resolve = vi.fn().mockResolvedValue({ uri, text: "decoded", truncated: true, nextOffset: 200 });
    expect(await readSwarmEvidenceFile(run, { taskId: "task", uri, offset: 123 }, resolve)).toEqual({ uri, text: "decoded", truncated: true, nextOffset: 200 });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ sessionId: "persisted-session", uri, offset: 123 });
    await expect(readSwarmEvidenceFile(run, { taskId: "task", uri: "/unrecorded" }, resolve)).rejects.toThrow("not evidence");
    await expect(readSwarmEvidenceFile({ tasks: [{ taskId: "task", executions: [{ transcriptRef: uri }] }] } as unknown as SwarmRun, { taskId: "task", uri }, resolve)).rejects.toThrow("sessionId");
  });

  it("reads only the selected task’s persisted reference on demand and bounds large files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarm-evidence-"));
    try {
      const uri = join(directory, "artifact.txt");
      await writeFile(uri, "x".repeat(1024 * 1024 + 10));
      const run = {
        tasks: [{ taskId: "task", artifactRefs: [{ uri }] }],
      } as unknown as SwarmRun;
      await expect(readSwarmEvidenceFile(run, { taskId: "other", uri })).rejects.toThrow(
        "not evidence",
      );
      await expect(
        readSwarmEvidenceFile(run, { taskId: "task", uri: join(directory, "secret") }),
      ).rejects.toThrow("not evidence");
      const result = await readSwarmEvidenceFile(run, { taskId: "task", uri });
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBe(1024 * 1024);
      const next = await readSwarmEvidenceFile(run, {
        taskId: "task",
        uri,
        offset: result.nextOffset,
      });
      expect(next.text).toBe("x".repeat(10));
      expect(next.truncated).toBe(false);
      await writeFile(uri, "x".repeat(1024 * 1024 - 1) + "😀tail");
      const firstUnicode = await readSwarmEvidenceFile(run, { taskId: "task", uri });
      const restUnicode = await readSwarmEvidenceFile(run, {
        taskId: "task",
        uri,
        offset: firstUnicode.nextOffset,
      });
      expect(firstUnicode.text).toBe("x".repeat(1024 * 1024 - 1));
      expect(restUnicode.text).toBe("😀tail");

      await expect(readSwarmEvidenceFile(run, { taskId: "task", uri, offset: -1 })).rejects.toThrow(
        "offset",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
