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
/** A unit's worktree, read from its brief: it lives outside the repo, in ZERG_HOME. */
const tree = (unit) => /WORKTREE: (.+)/.exec(sh(`$S brief G-1 worker ${unit}`))?.[1] ?? "";
const work = (unit, change) => sh(`cd "${tree(unit)}" && ${change} && git add -A && git commit -qm ${unit}`);

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
  write(".gitignore", ".deps/\n");
  sh("git add -A && git commit -qm init");
});
step("a detached HEAD is refused", "git checkout -q --detach && $S new G-1; git checkout -q main", /HEAD is detached/);

step("next before a goal", "$S next G-1", /row 2 scope/);

test("scope and plan", () => {
  sh("$S new G-1");
  edit(".swarm/G-1/contract.md", "<title>", "add sub and mul");
  const file = path.join(T, ".swarm", "G-1", "contract.md");
  const filled = { Outcome: "calc has sub, and a new mul module multiplies.", Why: "Callers need both.",
    "Non-goals": "- No other operations.", Constraints: "- add keeps working, including for negatives.",
    "Escalate when": "- A change needs a file outside its unit's scope." };
  let text = fs.readFileSync(file, "utf8");
  for (const [name, body] of Object.entries(filled)) {
    text = text.replace(new RegExp(`(## ${name}\\n)[\\s\\S]*?(?=\\n## )`), `$1${body}\n`);
  }
  fs.writeFileSync(file, text);
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
test("lint reads a contract saved with CRLF", () => {
  const file = path.join(T, ".swarm", "G-1", "contract.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
  assert.match(sh("$S lint G-1"), /plan ok/);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
});
step("lint passes", "$S lint G-1", /plan ok/);
test("lint catches what a planner left from the template", () => {
  sh("$S new G-2");
  const output = sh("$S lint G-2");
  for (const expected of [/title is still a placeholder/, /## Outcome still has the template's example text/, /U-001: still the template's example row/]) {
    assert.match(output, expected);
  }
  fs.rmSync(path.join(T, ".swarm", "G-2"), { recursive: true });
});
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
step("amend takes the finding from the log", "$S amend G-1 U-001 && grep '^| U-001 ' .swarm/G-1/plan.md", /Also: keep add unchanged/);
step("amend with nothing open is refused", "$S amend G-1 U-001", /no open finding/);
step("baseline: all checks fail first", "$S baseline G-1", /"passing_before_work": \[\]/);
step("only U-001 is ready", "$S lease G-1 U-002", /not ready/);
test("setup runs in every new worktree, and a failing setup leases nothing", () => {
  edit(".swarm/G-1/contract.md", "setup:\n", "setup: exit 3\n");
  sh("git commit -qam 'test: failing setup'");
  assert.match(sh("$S lease G-1 U-001"), /setup failed in U-001's worktree, so nothing was leased/);
  assert.match(sh("grep -c '| U-001 | leased |' .swarm/G-1/log.md || true"), /^0$/m);
  edit(".swarm/G-1/contract.md", "setup: exit 3\n", "setup: mkdir -p .deps && touch .deps/ready && test -n \"$MAIN\"\n");
  sh("git commit -qam 'test: working setup'");
});
test("lease makes a worktree outside the repo", () => {
  const output = sh("$S lease G-1 U-001");
  assert.match(output, /leased U-001: worktree /);
  assert.ok(tree("U-001").startsWith(HOME), tree("U-001"));
  assert.ok(fs.existsSync(path.join(tree("U-001"), ".deps", "ready")), "setup ran in the worktree");
});
step("a live lease makes next wait", "$S next G-1", /row 7 wait: U-001 still leased/);
test("a lease whose worktree is gone is an orphan, and next reclaims it", () => {
  sh(`git worktree remove --force "${tree("U-001")}"`);
  assert.match(sh("$S peek G-1"), /row 7 orphans: U-001/);
  assert.match(sh("$S next G-1"), /U-001: leased -> planned[\s\S]*row 8 implement: U-001/);
  assert.doesNotMatch(sh("grep '^| U-001 ' .swarm/G-1/plan.md"), /lease lost/, "the note keeps the last failure for the next worker");
});
step("and is leased again", "$S lease G-1 U-001", /worktree/);
test("answer refuses a unit that isn't stuck, and leaves the contract alone", () => {
  assert.match(sh("$S answer G-1 U-002 decide"), /not stuck/);
  assert.match(sh("grep -c 'U-002: decide' .swarm/G-1/contract.md"), /^0$/m);
});
step("rescope works on a planned unit", "$S rescope G-1 U-002 src/mul.py 'examiner finding needs it'", /U-002: scope src\/mul\.py/);
step("brief names the role file", "$S brief G-1 worker U-001", /references\/worker\.md/);
step("brief quotes the script path", "$S brief G-1 worker U-001", /S: node ".*swarm\.mjs"/);
step("a verifier's brief has its own temp folder", "$S brief G-1 verifier U-001", /TMP: .*\/work\/.*\/G-1\/verify-/);
step("a unit verifier's brief names its diff", "$S brief G-1 verifier U-001", /DIFF: git diff swarm\/G-1\.\.\.unit\/G-1\/U-001/);
test("the whole verifier's diff starts after the infrastructure commit and leaves out .swarm", () => {
  const infra = sh("git log --format=%H --grep 'infrastructure:' -1").trim();
  assert.match(sh("$S brief G-1 verifier whole"), new RegExp(`DIFF: git diff ${infra} swarm/G-1 -- \\. ':\\(exclude\\)\\.swarm'`));
});

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
test("worker reports from inside its worktree", () => assert.match(sh(`cd "${tree("U-001")}" && $S report G-1 U-001 produced 'sub added'`), /leased -> produced/));
step("a stale second report changes nothing", "$S report G-1 U-001 produced again", /is produced, not leased/);
step("move can't skip the gates", "$S move G-1 U-001 merged skip", /move only handles/);
test("worktree removed after report", () => assert.ok(!fs.existsSync(tree("U-001"))));
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
step("next says prove, before the whole review", "$S next G-1", /row 11 prove: C1 C2/);
step("the whole review waits for the proofs", "$S review G-1 whole pass 'all fits'", /only at row `whole-review`; the goal is at row 11 `prove`/);
const PROVE_C1 = "$S prove G-1 C1 \"PYTHONPATH=src python3 -c 'from calc import sub; assert sub(5, 3) == 2'\"";
step("prove C1", `${PROVE_C1} && tail -1 .swarm/G-1/log.md`, /\| proof \|/);
step("a no-op proof is refused", "$S prove G-1 C2 'echo ok && true'", /proves nothing/);
step("a failing proof is refused", "$S prove G-1 C2 false", /not proven/);
step("a criterion with no command in the contract needs one", "$S prove G-1 C2", /gives it no command/);
step("waive needs a reason", "$S waive G-1 C2", /needs a reason/);
step("the human waives C2", "$S waive G-1 C2 'covered by the integration suite' && tail -1 .swarm/G-1/log.md", /\| proved \|/);
step("the whole verifier's brief lists what settled each criterion", "$S brief G-1 verifier whole",
  /Proofs:\n  C1: PYTHONPATH=src python3[^\n]*\n  C2: waived by the human: covered by the integration suite/);
step("a verdict needs a reason", "$S review G-1 whole fail", /needs its first blocking reason/);
step("a finding needs file:line", "$S stage G-1 finding 'duplicate helper'", /file:line/);
step("a finding with file:line is logged", "$S stage G-1 finding 'src/util.py:1: duplicate helper'", /G-1: finding/);
step("whole review fails", "$S review G-1 whole fail 'src/util.py:1: duplicate helper'", /whole review: fail/);
step("next says add-fix", "$S next G-1", /row 12 add-fix/);
step("add-fix adds the orchestrator's one fix", "$S add-fix G-1 dedupe src/dedupe.py", /added F-2/);
test("worker F-2", () => {
  sh("$S lease G-1 F-2");
  work("F-2", "printf 'Y = 2\\n' > src/dedupe.py");
  sh("$S report G-1 F-2 produced dedupe && $S check G-1 F-2 && $S review G-1 F-2 pass ok && $S merge G-1 F-2");
});
step("integrate after F-2", "$S integrate G-1", /"suite": "pass"/);
step("the fix voids the old proof but keeps the waiver", "$S next G-1", /row 11 prove: C1$/m);
step("prove C1 again", `${PROVE_C1} && tail -1 .swarm/G-1/log.md`, /\| proved \|/);
step("the whole review blocks again", "$S review G-1 whole fail 'src/util.py:1: still duplicated'", /whole review: fail/);
step("a second block is a goal-level question", "$S next G-1", /row 9 interrupt: goal: the whole review is blocking again/);
step("add-fix runs only once", "$S add-fix G-1 again src/again.py", /runs once per goal/);
step("the human waives the whole review", "$S waive G-1 whole 'duplication accepted for now'", /whole: waived/);

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
test("learn.md with evidence that isn't in the log is refused", () => {
  write(".swarm/G-1/learn.md", "# Learn\n\n## zerg\n\n### P1. demo zerg rule (add)\n- 2026-01-01T00:00:00 | G-1 | integrated |\n\n## project\n\nnone\n");
  assert.match(sh("$S stage G-1 learned"), /P1: this evidence isn't in log\.md/);
});
test("write learn.md", () => {
  const evidence = (event) => sh(`grep '| ${event} |' .swarm/G-1/log.md | tail -1`).trim();
  write(".swarm/G-1/learn.md", `# Learn\n\n## zerg\n\n### P1. demo zerg rule (add)\n${evidence("whole-blocking")}\n\n` +
    `## project\n\n### P2. demo project rule (add)\n${evidence("integrated")}\n`);
});
step("learn routes both lanes", "$S stage G-1 learned", /zerg -> .*inbox\.md/);
step("the project lesson is committed", "git show swarm/G-1:.swarm/LEARNINGS.md", /demo project rule/);
step("the inbox lists the zerg lesson", "$S inbox", /\/G-1\/P1/);
step("no user rules yet", "$S rules", /no user rules yet/);
step("accept into rules", `$S accept repo/G-1/P1 keep`, /rules\.md/);
step("rules prints them for every role", "$S rules", /demo zerg rule/);
step("handoff shows the waiver", "$S handoff G-1", /C2: WAIVED: covered by the integration suite[\s\S]*checked out main/);
step("no leftover worktrees", "git worktree list | wc -l", /^\s*1$/m);
step("merged unit branches are deleted", "git branch --list 'unit/G-1/*' | wc -l", /^\s*0$/m);
test("the goal's scratch folders are gone", () => assert.ok(!fs.readdirSync(path.join(HOME, "work")).some((d) =>
  fs.existsSync(path.join(HOME, "work", d, "G-1")))));
step("state lives on the branch only", "$S status G-1", /check it out first/);
