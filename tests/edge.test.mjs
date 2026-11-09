// The gates and recovery paths the main lifecycle doesn't reach, each against its own throwaway repo.
// Run: node --test tests/
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { SWARM, TWO_UNITS, definedGoal, makeRepo, plannedGoal, pyTest } from "./harness.mjs";

describe("approve gates", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("plan", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    assert.match(r.sh("$S lint G-1"), /plan ok/);
  });
  test("from the wrong branch", () => {
    assert.match(r.sh("git checkout -q -b other && $S approve G-1 ask"), /approve from main, not other/);
    r.sh("git checkout -q main && git branch -q -D other");
  });
  test("with a dirty tree", () => {
    r.write("src/stray.py", "x = 1\n");
    assert.match(r.sh("$S approve G-1 ask"), /tree not clean: src\/stray\.py/);
    fs.rmSync(r.at("src/stray.py"));
  });
  test("with a red suite", () => {
    r.write("tests/test_red.py", pyTest("red", "calc import add", "self.assertEqual(add(1, 1), 3)"));
    r.sh("git add -A && git commit -qm red");
    assert.match(r.sh("$S approve G-1 ask"), /the suite is red on base/);
    r.sh("git rm -q tests/test_red.py && git commit -qm green");
  });
  test("with a setup that fails, or leaves files git would see", () => {
    const contract = ".swarm/G-1/contract.md";
    r.edit(contract, "setup:\n", "setup: exit 4\n");
    assert.match(r.sh("$S approve G-1 ask"), /setup failed/);
    r.edit(contract, "setup: exit 4\n", "setup: touch made-by-setup\n");
    assert.match(r.sh("$S approve G-1 ask"), /setup leaves files git doesn't ignore; gitignore them: made-by-setup/);
    r.edit(contract, "setup: touch made-by-setup\n", "setup:\n");
  });
  test("when swarm/<goal> already exists", () => {
    assert.match(r.sh("git branch swarm/G-1 && $S approve G-1 ask"), /swarm\/G-1 already exists/);
    r.sh("git branch -q -D swarm/G-1");
  });
  test("with a folder as a scope entry", () => {
    r.edit(".swarm/G-1/plan.md", "| src/mul.py |", "| src |");
    assert.match(r.sh("$S lint G-1"), /U-002: scope src is a folder, and a scope matches files; write src\/\*\*/);
    r.edit(".swarm/G-1/plan.md", "| src |", "| src/mul.py |");
  });
  test("refused attempts left no swarm branch, then approve works", () => {
    assert.equal(r.sh("git branch --list 'swarm/*'").trim(), "");
    assert.match(r.sh("$S approve G-1 ask"), /on swarm\/G-1/);
  });
});

describe("define guards and the fail-first baseline", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("approved", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    assert.match(r.sh("$S approve G-1 ask"), /on swarm\/G-1/);
  });
  test("define without a holdout leaves the goal undefined, and a no-op holdout is refused", () => {
    r.write("tests/test_sub.py", pyTest("sub", "calc import sub", "self.assertEqual(sub(5, 3), 2)"));
    assert.match(r.sh("$S define G-1 'holdout=true'"), /passes whatever the code does/);
    assert.match(r.sh("$S define G-1 'U-001=PYTHONPATH=src python3 -m unittest tests.test_sub -q' 'U-002=false'"), /not defined yet/);
    assert.match(r.sh("$S next G-1"), /row 4 define/);
  });
  test("an examiner edit to a product file is refused", () => {
    r.write("src/calc.py", "def add(a, b):\n    return a + b + 0\n");
    assert.match(r.sh("$S define G-1 'U-001=true'"), /changed product or state files: src\/calc\.py/);
    r.sh("git checkout -q -- src/calc.py");
  });
  test("a pipe in a check, and an unknown unit, are refused before anything is written", () => {
    assert.match(r.sh("$S define G-1 'U-001=a | b'"), /can't contain '\|'/);
    assert.match(r.sh("$S define G-1 'U-009=true'"), /no unit U-009/);
    assert.doesNotMatch(r.read(".swarm/G-1/plan.md"), /\| a \/ b \|/);
  });
  test("a check that already passes blocks the baseline", () => {
    r.write("tests/test_mul.py", pyTest("mul", "mul import mul", "self.assertEqual(mul(2, 3), 6)"));
    assert.match(r.sh("$S define G-1 'U-001=true' 'U-002=PYTHONPATH=src python3 -m unittest tests.test_mul -q' " +
      "'holdout=PYTHONPATH=src python3 -m unittest tests.test_calc -q'"), /checks recorded/);
    const output = r.sh("$S baseline G-1; echo exit=$?");
    assert.match(output, /"passing_before_work": \[\s*"U-001"\s*\]/);
    assert.match(output, /exit=1/);
    assert.match(r.sh("$S next G-1"), /row 5 baseline/);
  });
  test("the examiner's brief names the unit to strengthen", () => {
    assert.match(r.sh("$S brief G-1 examiner"), /Strengthen: U-001/);
  });
  test("passing again makes the unit stuck, and the independent unit carries on", () => {
    r.sh("$S baseline G-1");
    assert.match(r.read(".swarm/G-1/plan.md"), /\| U-001 \|.*\| stuck \|/);
    assert.match(r.sh("$S next G-1"), /row 8 implement: U-002/);
  });
});

describe("the unit loop's failure paths", () => {
  const r = makeRepo();
  after(r.cleanup);
  const S = (cmd) => r.sh(`$S ${cmd}`);
  test("approved, defined, baselined", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    S("approve G-1 ask");
    assert.match(definedGoal(r), /checks recorded/);
    assert.match(S("baseline G-1"), /"passing_before_work": \[\]/);
  });
  test("STOP blocks a lease", () => {
    r.write(".swarm/STOP", "");
    assert.match(S("lease G-1 U-001"), /STOP is present/);
    assert.match(S("next G-1"), /row 0 stop/);
    fs.rmSync(r.at(".swarm/STOP"));
  });
  test("a report needs its text", () => {
    S("lease G-1 U-001");
    assert.match(S("report G-1 U-001 escalated"), /give the one question/);
    assert.match(S("report G-1 U-001 gave_up"), /say why/);
  });
  test("a failing check revises the unit", () => {
    S("lease G-1 U-001");
    r.work("G-1", "U-001", "printf '\\ndef sub(a, b):\\n    return a + b\\n' >> src/calc.py");
    S("report G-1 U-001 produced wrong");
    assert.match(S("check G-1 U-001"), /"check": "fail"/);
    assert.match(r.read(".swarm/G-1/plan.md"), /\| U-001 \|.*\| planned \| 1 \|/);
  });
  test("an untracked file a verifier leaves is named, and blocks its verdict", () => {
    S("lease G-1 U-002");
    r.work("G-1", "U-002", "printf 'def mul(a, b):\\n    return a * b\\n' > src/mul.py");
    S("report G-1 U-002 produced mul");
    S("check G-1 U-002");
    r.write("src/scratch.py", "x = 1\n");
    assert.match(S("review G-1 U-002 pass ok"), /remove these untracked files by hand: src\/scratch\.py/);
    assert.match(S("review G-1 U-002 pass ok"), /verifier changed the tree/);
    fs.rmSync(r.at("src/scratch.py"));
    assert.match(S("review G-1 U-002 pass ok"), /review pass/);
  });
  test("a merge that breaks a check rolls back to the recorded sha", () => {
    r.edit("tests/test_mul.py", "mul(2, 3), 6", "mul(2, 3), 7");
    r.sh("git commit -qam 'a change on the swarm branch that breaks U-002'");
    const before = r.sh("git rev-parse HEAD").trim();
    assert.match(S("merge G-1 U-002"), /after merge these checks fail: U-002/);
    assert.equal(r.sh("git rev-parse HEAD").trim().length, 40);
    assert.match(r.sh(`git log --format=%H -1 ${before}..HEAD -- src/mul.py | wc -l`), /^\s*0$/m, "no merge left on the branch");
    assert.match(r.read(".swarm/G-1/plan.md"), /\| U-002 \|.*\| planned \| 1 \|/);
    r.edit("tests/test_mul.py", "mul(2, 3), 7", "mul(2, 3), 6");
    r.sh("git commit -qam 'restore the test'");
  });
  test("rescope can't overlap an open unit", () => {
    assert.match(S("rescope G-1 U-001 src/mul.py widen"), /overlaps open units: U-002/);
  });
  test("a merge conflict makes the unit stuck and leaves a clean tree", () => {
    S("lease G-1 U-002");
    r.work("G-1", "U-002", "printf 'def mul(a, b):\\n    return a * b\\n' > src/mul.py");
    S("report G-1 U-002 produced mul");
    r.write("src/mul.py", "def mul(a, b):\n    return b * a\n");
    r.sh("git add src/mul.py && git commit -qm 'a conflicting change on the swarm branch'");
    S("check G-1 U-002");
    S("review G-1 U-002 pass ok");
    assert.match(S("merge G-1 U-002"), /produced -> stuck/);
    assert.equal(r.sh("git status --porcelain --untracked-files=no").trim(), "");
    assert.ok(!fs.existsSync(r.at(".git/MERGE_HEAD")), "the merge was aborted");
  });
});

describe("auto mode drops stuck units without the orchestrator", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("a unit that escalates under auto is dropped by next, with the unit it blocks", () => {
    plannedGoal(r, { rows: [TWO_UNITS[0], TWO_UNITS[1].replace("| src/mul.py | - |", "| src/mul.py | U-001 |")] });
    r.sh("$S approve G-1 auto");
    definedGoal(r);
    r.sh("$S baseline G-1 && $S lease G-1 U-001 && $S report G-1 U-001 escalated 'which sign?'");
    assert.match(r.sh("$S peek G-1"), /row 9 auto-drop: U-001 \(stuck: question: which sign\?\) U-002 \(blocked by U-001\)/);
    const output = r.sh("$S next G-1");
    assert.match(output, /U-001: stuck -> dropped[\s\S]*U-002: planned -> dropped[\s\S]*row 10 integrate/);
    assert.match(r.read(".swarm/G-1/plan.md"), /\| U-001 \|.*\| dropped \| 0 \| auto: question: which sign\? \|/);
  });
});

describe("abandon", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("needs a reason, then keeps swarm/<goal> and removes the rest", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    r.sh("$S approve G-1 ask");
    definedGoal(r);
    r.sh("$S baseline G-1 && $S lease G-1 U-001");
    const worktree = r.tree("G-1", "U-001");
    const holdout = /HOLDOUT: (.+)/.exec(r.sh("$S brief G-1 examiner"))?.[1] ?? "";
    assert.match(r.sh("$S abandon G-1"), /needs a reason/);
    assert.match(r.sh("$S abandon G-1 wrong approach"), /abandoned[\s\S]*checked out main/);
    assert.equal(r.sh("git branch --show-current").trim(), "main");
    assert.ok(!fs.existsSync(worktree) && !fs.existsSync(holdout), "the worktree and the holdout are gone");
    assert.equal(r.sh("git branch --list 'unit/G-1/*'").trim(), "");
    assert.match(r.sh("git show swarm/G-1:.swarm/G-1/contract.md"), /goal: abandoned: wrong approach/);
    assert.match(r.sh("git checkout -q swarm/G-1 && $S peek G-1; git checkout -q main"), /row 15 done: the human abandoned this goal/);
  });
  test("from base, the goal's commands point to its branch instead of planning it again", () => {
    assert.match(r.sh("$S next G-1"), /state lives on swarm\/G-1; check it out first/);
    assert.match(r.sh("$S new G-1"), /state lives on swarm\/G-1; check it out first/);
  });
});

describe("the close can't be skipped", () => {
  const r = makeRepo();
  after(r.cleanup);
  const S = (cmd) => r.sh(`$S ${cmd}`);
  const finish = (uid, change) => {
    S(`lease G-1 ${uid}`);
    r.work("G-1", uid, change);
    return S(`report G-1 ${uid} produced done && $S check G-1 ${uid} && $S review G-1 ${uid} pass ok && $S merge G-1 ${uid}`);
  };
  test("integrated, with every criterion waived", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    S("approve G-1 ask");
    definedGoal(r);
    S("baseline G-1");
    finish("U-001", "printf '\\ndef sub(a, b):\\n    return a - b\\n' >> src/calc.py");
    assert.match(finish("U-002", "printf 'def mul(a, b):\\n    return a * b\\n' > src/mul.py"), /U-002: produced -> merged/);
    assert.match(S("integrate G-1"), /"suite": "pass"/);
    S("waive G-1 C1 'shown by the unit test' && $S waive G-1 C2 'shown by the unit test'");
  });
  test("nothing skips the whole review", () => {
    assert.match(S("stage G-1 whole-review skip"), /stage is one of learned, finding/);
    assert.match(S("waive G-1 whole nothing blocks"), /`whole-blocking` hasn't happened yet/);
    assert.match(S("stage G-1 learned"), /`whole-review` hasn't happened yet/);
    assert.match(S("handoff G-1"), /hand-off runs only at row `handoff`; the goal is at row 12 `whole-review`/);
  });
  test("a blocking verdict can't be replaced by a second verifier", () => {
    assert.match(S("review G-1 whole fail 'src/mul.py:1: duplicate helper'"), /whole review: fail/);
    assert.match(S("review G-1 whole pass 'looks fine'"), /only at row `whole-review`; the goal is at row 12 `add-fix`/);
  });
  test("a fix unit's scope can't be a folder", () => {
    assert.match(S("add-fix G-1 dedupe src"), /scope src is a folder/);
  });
  test("after a reopen, waivers still settle the criteria, so the whole review can run", () => {
    assert.match(S("add-fix G-1 dedupe src/dedupe.py"), /added F-1/);
    finish("F-1", "printf 'Y = 2\\n' > src/dedupe.py");
    S("integrate G-1");
    assert.match(S("next G-1"), /row 12 whole-review/);
    assert.match(S("review G-1 whole pass 'fits together'"), /whole review: pass/);
  });
});

describe("rows that wait don't count toward the bounds", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("resuming at the approve question many times never trips no-progress", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    for (let i = 0; i < 4; i++) r.sh("$S next G-1");
    assert.match(r.sh("$S next G-1"), /row 3 approve/);
  });
});

describe("token budget and the lock", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("approved, defined, baselined, with a budget of 100 tokens", () => {
    plannedGoal(r, { rows: TWO_UNITS, header: "token_budget: 100" });
    r.sh("$S approve G-1 ask");
    definedGoal(r);
    assert.match(r.sh("$S baseline G-1"), /"passing_before_work": \[\]/);
  });
  test("a spent budget blocks a lease and stops the loop", () => {
    r.sh("$S tokens G-1 examiner define 150");
    assert.match(r.sh("$S lease G-1 U-001"), /token budget spent: 150 of 100/);
    assert.match(r.sh("$S next G-1"), /row 1 stop: token budget spent/);
  });
  test("a live owner's lock is never taken", () => {
    const owner = spawn("sleep", ["30"]);
    fs.writeFileSync(r.at(".swarm/.lock"), `${owner.pid}@${os.hostname()}`);
    assert.match(r.sh("$S tokens G-1 W-1 implement 1", { ZERG_LOCK_TIMEOUT_S: "1" }), new RegExp(`${owner.pid}@.* held \\.swarm/\\.lock for 1 seconds`));
    assert.equal(fs.readFileSync(r.at(".swarm/.lock"), "utf8"), `${owner.pid}@${os.hostname()}`, "the owner's lock is untouched");
    owner.kill();
    fs.rmSync(r.at(".swarm/.lock"));
  });
  test("an old lock from another host is taken, a fresh one is not", () => {
    const lock = r.at(".swarm/.lock");
    fs.writeFileSync(lock, "4242@another-host");
    assert.match(r.sh("$S tokens G-1 W-2 implement 1", { ZERG_LOCK_TIMEOUT_S: "1" }), /4242@another-host\) held/);
    const old = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(r.sh("$S tokens G-1 W-3 implement 1"), "");
    assert.ok(!fs.existsSync(lock));
  });
});

describe("user layer and stage validation", () => {
  const r = makeRepo();
  after(r.cleanup);
  test("config refuses an unknown key and a no-progress window below 2", () => {
    assert.match(r.sh("$S config bogus 3"), /config takes one of/);
    assert.match(r.sh("$S config no_progress 1"), /no_progress needs 2 or more/);
    assert.match(r.sh("$S config lease_minutes 30"), /lease_minutes = 30/);
    assert.match(r.sh("$S home"), /lease_minutes=30/);
  });
  test("dismiss archives a proposal", () => {
    fs.mkdirSync(r.HOME, { recursive: true });
    fs.writeFileSync(path.join(r.HOME, "inbox.md"), "# inbox\n\n## repo G-1 (2026-11-08)\n\n### P1. x (add)\ny\n");
    assert.match(r.sh("$S dismiss repo/G-1/P1 project-specific"), /dismissed/);
    assert.match(r.sh("$S inbox"), /inbox is empty/);
    assert.match(fs.readFileSync(path.join(r.HOME, "archive.md"), "utf8"), /repo\/G-1\/P1: dismissed/);
  });
  test("tokens, stage, waive, and handoff refuse what they can't use", () => {
    plannedGoal(r, { rows: TWO_UNITS });
    r.sh("$S approve G-1 ask");
    assert.match(r.sh("$S tokens G-1 W-1 implement lots"), /whole number/);
    assert.match(r.sh("$S stage G-1 nonsense"), /stage is one of/);
    assert.match(r.sh("$S stage G-1 learned"), /`whole-review` hasn't happened yet/);
    assert.match(r.sh("$S waive G-1 C9 because"), /no criterion C9/);
    assert.match(r.sh("$S handoff G-1"), /hand-off runs only at row `handoff`/);
  });
});
