import assert from "node:assert/strict";
import test from "node:test";
import { withRemoteSlot } from "./remote-task-queue.js";

test("remote tasks on one computer serialize while another computer remains available", async () => {
  const order: string[] = []; let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = withRemoteSlot("PC.EXAMPLE.LOCAL", async () => { order.push("first"); await hold; });
  const second = withRemoteSlot("pc.example.local", async () => { order.push("second"); });
  await withRemoteSlot("other.example.local", async () => { order.push("other"); });
  assert.deepEqual(order, ["first", "other"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "other", "second"]);
});
test("timed-out waiters never execute and cannot let later requests overtake the active task", async () => {
  let release!: () => void; let calls = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = withRemoteSlot("timeout.example.local", async () => { await hold; });
  await assert.rejects(withRemoteSlot("timeout.example.local", async () => { calls++; }, 5), /did not start/);
  const next = withRemoteSlot("timeout.example.local", async () => { calls++; });
  await Promise.resolve(); assert.equal(calls, 0);
  release(); await Promise.all([first, next]); assert.equal(calls, 1);
  await assert.rejects(withRemoteSlot("timeout.example.local", async () => { throw new Error("failed task"); }));
  await withRemoteSlot("timeout.example.local", async () => { calls++; }); assert.equal(calls, 2);
});
