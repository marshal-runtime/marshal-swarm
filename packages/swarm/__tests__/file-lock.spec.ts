import { describe, expect, it } from "vitest";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { FileSwarmRunEventStore } from "../src/file-store.js";
const execute = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "swarm-locks-"));
  const store = new FileSwarmRunEventStore(directory);
  await store.create("r", "Build", "repo");
  await store.append("r", {
    type: "task.added",
    task: {
      taskId: "root",
      role: "planner",
      objective: "Build",
      scope: "repo",
    },
  });
  await store.append("r", { type: "task.started", taskId: "root" });
  return { directory, store };
}
const artifact = (uri: string) => ({
  type: "task.artifact" as const,
  taskId: "root",
  artifact: { uri, kind: "plan" as const, summary: "Decision" },
});
describe("atomic journal locks", () => {
  it("ignores a crashed prepared owner without exposing an empty lock target", async () => {
    const { directory, store } = await fixture();
    try {
      const orphan = path.join(directory, "run-r.jsonl.lock.prepared-crashed");
      await writeFile(
        orphan,
        JSON.stringify({ pid: 2147483647, token: "crashed" }),
      );
      await expect(
        access(path.join(directory, "run-r.jsonl.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await store.append("r", artifact("/tmp/plan.md"));
      expect(await readdir(directory)).toEqual(
        expect.arrayContaining([
          "run-r.jsonl",
          "run-r.jsonl.lock.prepared-crashed",
        ]),
      );
      expect(
        (await readdir(directory)).filter((file) =>
          file.includes(".prepared-"),
        ),
      ).toEqual(["run-r.jsonl.lock.prepared-crashed"]);
      await expect(
        access(path.join(directory, "run-r.jsonl.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("serializes two store instances without lost events", async () => {
    const { directory, store } = await fixture();
    try {
      const second = new FileSwarmRunEventStore(directory);
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? second : store).append("r", artifact(`/tmp/plan-${i}.md`)),
        ),
      );
      expect(await store.read("r")).toHaveLength(15);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("two processes reclaim one dead lock without removing each other’s new owner", async () => {
    const { directory, store } = await fixture();
    try {
      await writeFile(
        path.join(directory, "run-r.jsonl.lock"),
        JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
      );
      const source = `const {FileSwarmRunEventStore}=require(process.argv[1]); const store=new FileSwarmRunEventStore(process.argv[2]); (async()=>{for(let n=0;n<8;n++){for(let attempt=0;;attempt++){try{await store.append('r',{type:'task.artifact',taskId:'root',artifact:{uri:'/tmp/'+process.argv[3]+'-'+n,kind:'plan',summary:'Decision'}});break;}catch(error){if(attempt>=100||!/locked|EEXIST|ENOENT/.test(String(error)))throw error;await new Promise(resolve=>setTimeout(resolve,2));}}}})().catch(error=>{console.error(error);process.exitCode=1});`;
      const bundle = path.join(process.cwd(), "dist", "index.cjs");
      await Promise.all(
        ["a", "b"].map((id) =>
          execute(process.execPath, ["-e", source, bundle, directory, id]),
        ),
      );
      expect(await store.read("r")).toHaveLength(19);
      expect(
        (await readdir(directory)).filter((file) => file.includes(".lock")),
      ).toEqual([]);
      expect(
        JSON.parse(
          (await readFile(path.join(directory, "run-r.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .at(-1)!,
        ),
      ).toMatchObject({ type: "task.artifact" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
