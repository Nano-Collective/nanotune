import { execa } from "execa";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "ava";
import { getDataLockPath, withDataLock } from "./data-lock.js";

const ORIG_CWD = process.cwd();
const TEST_DIR = join(ORIG_CWD, ".test-data-lock-spec");
const LOCK_MODULE = pathToFileURL(join(ORIG_CWD, "src", "lib", "data-lock.ts")).href;

// Serial because the lock is process-global state: run concurrently, these
// share one depth counter and one lock path, and every test but the first
// blocks waiting for a holder that is the test sitting next to it.
test.serial("runs the body and returns its value", (t) => {
  t.is(withDataLock(() => 42), 42);
});

test.serial("creates the lock while held and removes it afterwards", (t) => {
  let held = false;
  withDataLock(() => {
    held = existsSync(getDataLockPath());
  });
  t.true(held);
  t.false(existsSync(getDataLockPath()));
});

test.serial("a nested call does not wait on the lock it already holds", (t) => {
  const result = withDataLock(() => withDataLock(() => withDataLock(() => "deep")));
  t.is(result, "deep");
  t.false(existsSync(getDataLockPath()));
});

test.serial("releases the lock when the body throws", (t) => {
  t.throws(() => withDataLock(() => {
    throw new Error("boom");
  }), { message: "boom" });
  t.false(existsSync(getDataLockPath()));
});

test.serial("records the current process as the owner while held", (t) => {
  withDataLock(() => {
    const owner = JSON.parse(
      readFileSync(join(getDataLockPath(), "owner.json"), "utf-8"),
    );
    t.is(owner.pid, process.pid);
    t.is(owner.host, hostname());
  });
});

test.serial("rejects an async body, which would interleave two transactions", (t) => {
  t.throws(() => withDataLock(async () => 1), { message: /async function/ });
  t.false(existsSync(getDataLockPath()));
});

test.serial("is re-entrant again after the outermost call throws", (t) => {
  t.throws(() => withDataLock(() => {
    throw new Error("boom");
  }));
  // A depth counter left raised here would make the next caller wait on a lock
  // nobody holds, and it would only surface much later in another command.
  t.is(withDataLock(() => "ok", { timeoutMs: 1_000 }), "ok");
});

test.serial("waits for a live holder and takes the lock once it goes", async (t) => {
  // A real child, not a timer: withDataLock sleeps with Atomics.wait, which
  // blocks the thread, so anything this process scheduled to release the lock
  // would never run.
  const holder = execa(process.execPath, ["--import=tsx", "--input-type=module", "-e", `
process.chdir(${JSON.stringify(TEST_DIR)});
const {withDataLock} = await import(${JSON.stringify(LOCK_MODULE)});
withDataLock(() => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
});
`], { reject: false });

  const appeared = Date.now();
  while (!existsSync(getDataLockPath()) && Date.now() - appeared < 10_000) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  t.true(existsSync(getDataLockPath()), "the child never took the lock");

  const started = Date.now();
  t.is(withDataLock(() => "acquired", { timeoutMs: 10_000 }), "acquired");
  const waited = Date.now() - started;

  await holder;
  t.true(waited >= 50, `only waited ${waited}ms, so it took a lock nobody was holding`);
  t.false(existsSync(getDataLockPath()));
});

test.serial("takes over a lock left behind by a process that is gone", async (t) => {
  // A pid that has exited is what SIGKILL leaves behind: the `finally` that
  // would have removed the lock never runs. spawnSync rather than execa,
  // because execa's settled result carries no pid.
  const { pid } = spawnSync(process.execPath, ["-e", "0"]);
  mkdirSync(getDataLockPath(), { recursive: true });
  writeFileSync(
    join(getDataLockPath(), "owner.json"),
    JSON.stringify({ pid, host: hostname(), since: Date.now() }),
  );

  t.is(withDataLock(() => "reclaimed", { timeoutMs: 10_000 }), "reclaimed");
  t.false(existsSync(getDataLockPath()));
});

test.serial("leaves a lock held by another host alone", (t) => {
  writeOwner({ pid: process.pid, host: "some-other-machine" });

  const error = t.throws(() => withDataLock(() => "stolen", { timeoutMs: 150 }));
  t.regex(error!.message, /some-other-machine/);
  t.true(existsSync(getDataLockPath()));
});

test.serial("leaves a lock with no readable owner alone", (t) => {
  mkdirSync(getDataLockPath(), { recursive: true });

  const error = t.throws(() => withDataLock(() => "stolen", { timeoutMs: 150 }));
  t.regex(error!.message, /unidentified/);
  t.true(existsSync(getDataLockPath()));
});

test.serial("takes over a lock with no readable owner once it is old enough to be abandoned", (t) => {
  mkdirSync(getDataLockPath(), { recursive: true });
  const long_ago = new Date(Date.now() - 120_000);
  utimesSync(getDataLockPath(), long_ago, long_ago);

  t.is(withDataLock(() => "reclaimed", { timeoutMs: 10_000 }), "reclaimed");
  t.false(existsSync(getDataLockPath()));
});

test.serial("names the holder and the path to remove when it gives up", (t) => {
  writeOwner({ pid: process.pid, host: hostname() });

  const error = t.throws(() => withDataLock(() => "x", { timeoutMs: 120 }));
  t.regex(error!.message, /Nothing was written/);
  t.regex(error!.message, new RegExp(escapeForRegExp(getDataLockPath())));
});

test.beforeEach(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(join(TEST_DIR, ".nanotune"), { recursive: true });
  process.chdir(TEST_DIR);
});

test.afterEach.always(() => {
  process.chdir(ORIG_CWD);
  rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 3 });
});

function writeOwner(owner: Record<string, unknown>): void {
  mkdirSync(getDataLockPath(), { recursive: true });
  writeFileSync(
    join(getDataLockPath(), "owner.json"),
    JSON.stringify({ since: Date.now(), ...owner }),
  );
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
