// Full zerg lifecycle on a throwaway repo, with the roles simulated by shell commands.
// Run: node --test tests/   (steps run in order; a failed step names what it expected)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SWARM = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "zerg", "scripts", "swarm.mjs");
const TOP = fs.mkdtempSync(path.join(os.tmpdir(), "zerg-e2e-"));
const T = path.join(TOP, "repo");
const HOME = path.join(TOP, "home");
fs.mkdirSync(T);
const env = { ...process.env, ZERG_HOME: HOME };
after(() => fs.rmSync(TOP, { recursive: true, force: true }));

/** Runs a shell command in the repo; `$S` is the swarm script. Returns stdout and stderr together. */
function sh(command) {
  const proc = spawnSync(command.replaceAll("$S", `node "${SWARM}"`), { shell: true, cwd: T, env, encoding: "utf8" });
  return (proc.stdout ?? "") + (proc.stderr ?? "");
}

/** A step: run the command, and its output must match the pattern. */
function step(name, command, pattern) {
  test(name, () => {
    const output = sh(command);
    assert.match(output, pattern, `${command}\n---\n${output}`);
  });
}

/** A simulated worker: change files inside the worktree `lease` made, then commit. */
const work = (unit, change) => sh(`cd .swarm/.work/G-1/${unit} && ${change} && git add -A && git commit -qm ${unit}`);

const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(T, file)), { recursive: true });
  fs.writeFileSync(path.join(T, file), text);
};
const edit = (file, from, to) => write(file, fs.readFileSync(path.join(T, file), "utf8").replace(from, to));
const pyTest = (name, imports, body) => `import unittest\nfrom ${imports}\nclass T(unittest.TestCase):\n    def test_${name}(self): ${body}\n`;

test("set up a repo with a green suite", () => {
  sh("git init -q -b main");
  assert.match(sh("$S new G-1"), /no commits/);
  write("src/calc.py", "def add(a, b):\n    return a + b\n");
  write("tests/test_calc.py", pyTest("add", "calc import add", "self.assertEqual(add(1, 2), 3)"));
  sh("git add -A && git commit -qm init");
});
step("a detached HEAD is refused", "git checkout -q --detach && $S new G-1; git checkout -q main", /HEAD is detached/);

step("next before a goal", "$S next G-1", /row 2 scope/);

test("scope and plan", () => {
  sh("$S new G-1");
  edit(".swarm/G-1/contract.md", "<title>", "add sub and mul");
  edit(".swarm/G-1/contract.md", "<command that runs the full suite>", "PYTHONPATH=src python3 -m unittest discover -s tests -q");
  edit(".swarm/G-1/contract.md", "- C1: an observable result a test or command can show", "- C1: sub(5, 3) returns 2\n- C2: mul(2, 3) returns 6");
  edit(".swarm/G-1/plan.md", "| U-001 | one sentence | path/a.py | - | C1 | | planned | 0 | |", "| U-001 | add sub | src/calc.py | - | C1 | | planned | 0 | |");
  edit(".swarm/G-1/plan.md", "| U-002 | one sentence | path/b.py | U-001 | C1, C2 | | planned | 0 | |", "| U-002 | add mul | src/mul.py | U-001 | C2 | | planned | 0 | |");
});

test("a grep criterion with shell operators is refused", () => {
  edit(".swarm/G-1/contract.md", "- C2: mul(2, 3) returns 6", "- C2: mul(2, 3) returns 6\n- C3: `grep -rn x src; touch pwned`");
  assert.match(sh("$S lint G-1"), /C3: a grep criterion must be one plain grep command/);
  assert.ok(!fs.existsSync(path.join(T, "pwned")), "lint must never run the criterion through a shell");
  edit(".swarm/G-1/contract.md", "\n- C3: `grep -rn x src; touch pwned`", "");
});
step("lint passes", "$S lint G-1", /plan ok/);
step("summary for approval", "$S summary G-1", /U-002 {2}add mul/);
step("approve resumes on a half-made swarm branch", "git checkout -q -b swarm/G-1 && $S approve G-1 ask", /on swarm\/G-1/);
step("infrastructure commit", "git log --oneline", /infrastructure: ignore swarm state/);

let HOLDOUT = "";
test("only the examiner's brief names the holdout, and it lives outside the repo", () => {
  HOLDOUT = /HOLDOUT: (.+)/.exec(sh("$S brief G-1 examiner"))?.[1] ?? "";
  assert.ok(HOLDOUT.startsWith(HOME) && !HOLDOUT.startsWith(T), HOLDOUT);
  assert.doesNotMatch(sh("$S brief G-1 worker U-001") + sh("$S brief G-1 verifier U-001"), /HOLDOUT/);
});

test("examiner writes tests", () => {
  write("tests/test_sub.py", pyTest("sub", "calc import sub", "self.assertEqual(sub(5, 3), 2)"));
  write("tests/test_mul.py", pyTest("mul", "mul import mul", "self.assertEqual(mul(2, 3), 6)"));
  fs.writeFileSync(path.join(HOLDOUT, "test_h.py"), pyTest("add_unchanged", "calc import add", "self.assertEqual(add(-1, 1), 0)"));
});

const DEFINE = "$S define G-1 'U-001=PYTHONPATH=src python3 -m unittest tests.test_sub -q' 'U-002=PYTHONPATH=src python3 -m unittest tests.test_mul -q' " +
  "\"holdout=PYTHONPATH=src python3 -m unittest discover -s '$HOLDOUT' -q\" 'finding:U-001=keep add unchanged'";
test("define refuses to commit a secret, and writes nothing", () => {
  write(".env", "TOKEN=x\n");
  assert.match(sh(DEFINE.replace("$HOLDOUT", HOLDOUT)), /look like secrets: \.env/);
  fs.rmSync(path.join(T, ".env"));
  assert.doesNotMatch(sh("cat .swarm/G-1/log.md"), /examiner-finding/);
});
test("examiner defines checks", () => assert.match(sh(DEFINE.replace("$HOLDOUT", HOLDOUT)), /checks recorded/));
step("the examiner's files are recorded", "grep '| test-files |' .swarm/G-1/log.md", /tests\/test_mul\.py, tests\/test_sub\.py|tests\/test_sub\.py, tests\/test_mul\.py/);
step("holdout command is not in the contract", "git show HEAD:.swarm/G-1/contract.md | grep -c '^holdout'", /^0$/m);
test("holdout command lives outside the repo", () => {
  assert.match(fs.readFileSync(path.join(HOLDOUT, "command"), "utf8"), /discover -s/);
  assert.match(sh("git ls-files | grep -c holdout || true"), /^0$/m);
});
step("an open finding blocks baseline", "$S baseline G-1", /not routed/);
step("next says amend", "$S next G-1", /row 4 amend: U-001/);
step("amend", "$S amend G-1 U-001 keep add unchanged", /task amended/);
step("baseline: all checks fail first", "$S baseline G-1", /"passing_before_work": \[\]/);
step("only U-001 is ready", "$S lease G-1 U-002", /not ready/);
step("lease makes a worktree", "$S lease G-1 U-001", /worktree .*\/\.swarm\/\.work\/G-1\/U-001/);
step("a live lease makes next wait", "$S next G-1", /row 7 wait: U-001 still leased/);
step("a lease whose worktree is gone is an orphan", "git worktree remove --force .swarm/.work/G-1/U-001 && $S next G-1", /row 7 orphans: U-001/);
step("the orphan goes back to planned", "$S move G-1 U-001 planned 'lease lost'", /leased -> planned/);
step("and is leased again", "$S lease G-1 U-001", /worktree/);
test("answer refuses a unit that isn't stuck, and leaves the contract alone", () => {
  assert.match(sh("$S answer G-1 U-002 decide"), /not stuck/);
  assert.match(sh("grep -c 'U-002: decide' .swarm/G-1/contract.md"), /^0$/m);
});
step("rescope works on a planned unit", "$S rescope G-1 U-002 src/mul.py 'examiner finding needs it'", /U-002: scope src\/mul\.py/);
step("brief names the role file", "$S brief G-1 worker U-001", /references\/worker\.md/);

test("a path-traversal unit id is refused and nothing is deleted", () => {
  assert.match(sh("$S report G-1 ../../.. gave_up x"), /unit id must look like U-001/);
  assert.match(sh("git rev-parse --is-inside-work-tree"), /true/);
});
test("ZERG_HOME inside the repo is refused", () => {
  const inside = spawnSync("node", [SWARM, "brief", "G-1", "examiner"], { cwd: T, env: { ...env, ZERG_HOME: path.join(T, "home") }, encoding: "utf8" });
  assert.match(inside.stderr, /is inside this repo/);
});
step("a bad goal id is refused", "$S next ../x", /goal id must look like/);
step("a report from a worktree with no commits keeps the worktree",
  "$S report G-1 U-001 produced nothing; true", /no commits/);
test("worker U-001", () => work("U-001", "printf '\\ndef sub(a, b):\\n    return a - b\\n' >> src/calc.py"));
step("worker reports from inside its worktree", "cd .swarm/.work/G-1/U-001 && $S report G-1 U-001 produced 'sub added'", /leased -> produced/);
step("a stale second report changes nothing", "$S report G-1 U-001 produced again", /is produced, not leased/);
step("move can't skip the gates", "$S move G-1 U-001 merged skip", /move only handles/);
step("worktree removed after report", "ls .swarm/.work/G-1 | wc -l", /^\s*0$/m);
step("next says check", "$S next G-1", /row 6 check: U-001/);
step("check passes", "$S check G-1 U-001", /"ok": true/);
step("merge refused before review", "$S merge G-1 U-001", /passed by a verifier/);
step("a verifier write is restored", "echo '# scribble' >> src/calc.py && $S review G-1 U-001 pass looks right", /verifier changed the tree/);
step("tree clean again", "git status --porcelain -- src | wc -l", /^\s*0$/m);
step("a verifier edit to state files is caught too", "echo forged >> .swarm/G-1/log.md && $S review G-1 U-001 pass looks right",
  /verifier changed the tree \(\.swarm\/G-1\/log\.md\)/);
step("the forged line is gone and the restore is committed", "grep -c forged .swarm/G-1/log.md; git status --porcelain | wc -l", /^0\n\s*0$/m);
step("review pass", "$S review G-1 U-001 pass looks right", /review pass/);
step("next says merge", "$S next G-1", /row 6 merge: U-001/);
step("merge", "$S merge G-1 U-001", /produced -> merged/);

test("worker U-002 strays out of scope", () => {
  sh("$S lease G-1 U-002");
  work("U-002", "printf 'def mul(a, b):\\n    return a * b\\n' > src/mul.py && echo '# x' >> tests/test_calc.py");
  sh("$S report G-1 U-002 produced mul");
});
step("a scope violation revises", "$S check G-1 U-002", /outside scope: tests\/test_calc\.py/);

test("worker U-002 again", () => {
  sh("$S lease G-1 U-002");
  work("U-002", "printf 'def mul(a, b):\\n    return a * b\\n' > src/mul.py");
  sh("$S report G-1 U-002 produced mul && $S check G-1 U-002");
});
step("a review fail revises", "$S review G-1 U-002 fail 'src/mul.py:1: no docstring'", /revision 2 -> planned/);

test("worker U-002 a third time", () => {
  sh("$S lease G-1 U-002");
  work("U-002", "printf 'def mul(a, b):\\n    \"\"\"Multiply.\"\"\"\\n    return a * b\\n' > src/mul.py");
  sh("$S report G-1 U-002 produced mul && $S check G-1 U-002 && $S review G-1 U-002 pass ok");
});
step("merge recovers when a crash left the unit merged already",
  "git merge -q --no-ff --no-edit unit/G-1/U-002 && $S merge G-1 U-002", /produced -> merged/);

test("a failing holdout fails integration", () => {
  fs.writeFileSync(path.join(HOLDOUT, "test_fail.py"), pyTest("fails", "calc import add", "self.assertEqual(add(1, 1), 3)"));
  const output = sh("$S integrate G-1");
  assert.match(output, /"holdout": "fail"/);
  assert.doesNotMatch(output, /test_fail|add\(1, 1\)/, "integrate never prints holdout details");
});
step("a failed integration is a goal-level question", "$S next G-1", /row 9 interrupt: goal: integration failed/);
step("the human reopens with a fix unit", "$S reopen G-1 tidy src/util.py 'integration failed'", /added F-1/);
step("the decision is in the contract", "grep -c 'goal: reopened' .swarm/G-1/contract.md", /^1$/m);
step("the fix unit is ready", "$S next G-1", /row 8 implement: F-1/);

test("worker F-1 edits the examiner's tests", () => {
  sh("$S lease G-1 F-1");
  work("F-1", "printf 'X = 1\\n' > src/util.py && echo '# weaker' >> tests/test_mul.py");
  sh("$S report G-1 F-1 produced tidy");
});
step("touching the examiner's tests is refused", "$S check G-1 F-1", /changes the examiner's tests: tests\/test_mul\.py/);

test("worker F-1", () => {
  sh("$S lease G-1 F-1");
  work("F-1", "printf 'X = 1\\n' > src/util.py");
  sh("$S report G-1 F-1 produced tidy && $S check G-1 F-1 && $S review G-1 F-1 pass ok && $S merge G-1 F-1");
  fs.rmSync(path.join(HOLDOUT, "test_fail.py"));
});
step("integrate again after the fix", "$S next G-1", /row 10 integrate/);
step("integrate", "$S integrate G-1", /"suite": "pass"/);
step("whole review fails", "$S review G-1 whole fail 'duplicate helper'", /whole review: fail/);
step("next says add-fix", "$S next G-1", /row 11 add-fix/);
step("add-fix adds the orchestrator's one fix", "$S add-fix G-1 dedupe src/dedupe.py", /added F-2/);
test("worker F-2", () => {
  sh("$S lease G-1 F-2");
  work("F-2", "printf 'Y = 2\\n' > src/dedupe.py");
  sh("$S report G-1 F-2 produced dedupe && $S check G-1 F-2 && $S review G-1 F-2 pass ok && $S merge G-1 F-2");
});
step("integrate after F-2", "$S integrate G-1", /"suite": "pass"/);
step("the whole review blocks again", "$S review G-1 whole fail 'still duplicated'", /whole review: fail/);
step("a second block is a goal-level question", "$S next G-1", /row 9 interrupt: goal: the whole review is blocking again/);
step("add-fix runs only once", "$S add-fix G-1 again src/again.py", /runs once per goal/);
step("the human waives the whole review", "$S waive G-1 whole 'duplication accepted for now'", /whole: waived/);
step("prove C1", "$S prove G-1 C1 \"PYTHONPATH=src python3 -c 'from calc import sub; assert sub(5, 3) == 2'\" && tail -1 .swarm/G-1/log.md", /\| proof \|/);
step("a failing proof is refused", "$S prove G-1 C2 false", /not proven/);
step("waive needs a reason", "$S waive G-1 C2", /needs a reason/);
step("the human waives C2", "$S waive G-1 C2 'covered by the integration suite' && tail -1 .swarm/G-1/log.md", /\| proved \|/);

test("the lock keeps all 10 parallel writes", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve) =>
    spawn("node", [SWARM, "tokens", "G-1", `W-${i}`, "implement", "100"], { cwd: T, env }).on("exit", resolve))));
  assert.match(sh("grep -c '| tokens |' .swarm/G-1/log.md"), /^10$/m);
});

test("a lock left by a dead process is taken over", () => {
  fs.writeFileSync(path.join(T, ".swarm", ".lock"), `999999@${os.hostname()}`);
  assert.equal(sh("$S tokens G-1 W-dead implement 1"), "");
  assert.ok(!fs.existsSync(path.join(T, ".swarm", ".lock")));
});
test("state commits ignore the user's commit hooks", () => {
  const hooks = path.join(T, ".git", "hooks");
  for (const hook of ["pre-commit", "commit-msg"]) fs.writeFileSync(path.join(hooks, hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(sh("$S tokens G-1 W-hooked implement 1 && git status --porcelain .swarm | wc -l").trim(), "0");
  for (const hook of ["pre-commit", "commit-msg"]) fs.rmSync(path.join(hooks, hook));
});

step("next says learn", "$S next G-1", /row 13 learn/);
test("write learn.md", () => write(".swarm/G-1/learn.md",
  "# Learn\n\n## zerg\n\n### P1. demo zerg rule (add)\nlog.md:3\n\n## project\n\n### P2. demo project rule (add)\nlog.md:4\n"));
step("learn routes both lanes", "$S stage G-1 learned", /zerg -> .*inbox\.md/);
step("the project lesson is committed", "git show swarm/G-1:.swarm/LEARNINGS.md", /demo project rule/);
step("the inbox lists the zerg lesson", "$S inbox", /\/G-1\/P1/);
step("accept into rules", `$S accept repo/G-1/P1 keep`, /rules\.md/);
step("handoff shows the waiver", "$S handoff G-1", /C2: WAIVED: covered by the integration suite[\s\S]*checked out main/);
step("no leftover worktrees", "git worktree list | wc -l", /^\s*1$/m);
step("state lives on the branch only", "$S status G-1", /check it out first/);
