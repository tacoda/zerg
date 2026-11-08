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
const T = fs.mkdtempSync(path.join(os.tmpdir(), "zerg-e2e-"));
const env = { ...process.env, ZERG_HOME: path.join(T, "home") };
after(() => fs.rmSync(T, { recursive: true, force: true }));

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
  write("src/calc.py", "def add(a, b):\n    return a + b\n");
  write("tests/test_calc.py", pyTest("add", "calc import add", "self.assertEqual(add(1, 2), 3)"));
  sh("git init -q -b main && git add -A && git commit -qm init");
});

step("next before a goal", "$S next G-1", /row 2 scope/);

test("scope and plan", () => {
  sh("$S new G-1");
  edit(".swarm/G-1/contract.md", "<title>", "add sub and mul");
  edit(".swarm/G-1/contract.md", "<command that runs the full suite>", "PYTHONPATH=src python3 -m unittest discover -s tests -q");
  edit(".swarm/G-1/contract.md", "- C1: an observable result a test or command can show", "- C1: sub(5, 3) returns 2\n- C2: mul(2, 3) returns 6");
  edit(".swarm/G-1/plan.md", "| U-001 | one sentence | path/a.py | - | C1 | | planned | 0 | |", "| U-001 | add sub | src/calc.py | - | C1 | | planned | 0 | |");
  edit(".swarm/G-1/plan.md", "| U-002 | one sentence | path/b.py | U-001 | C1, C2 | | planned | 0 | |", "| U-002 | add mul | src/mul.py | U-001 | C2 | | planned | 0 | |");
});

step("lint passes", "$S lint G-1", /plan ok/);
step("summary for approval", "$S summary G-1", /U-002 {2}add mul/);
step("approve", "$S approve G-1 ask", /on swarm\/G-1/);
step("infrastructure commit", "git log --oneline", /infrastructure: ignore swarm state/);

test("examiner writes tests", () => {
  write("tests/test_sub.py", pyTest("sub", "calc import sub", "self.assertEqual(sub(5, 3), 2)"));
  write("tests/test_mul.py", pyTest("mul", "mul import mul", "self.assertEqual(mul(2, 3), 6)"));
  write(".swarm/G-1/holdout/test_h.py", pyTest("add_unchanged", "calc import add", "self.assertEqual(add(-1, 1), 0)"));
});

step("examiner defines checks",
  "$S define G-1 'U-001=PYTHONPATH=src python3 -m unittest tests.test_sub -q' 'U-002=PYTHONPATH=src python3 -m unittest tests.test_mul -q' " +
  "'holdout=PYTHONPATH=src python3 -m unittest discover -s .swarm/G-1/holdout -q' 'finding:U-001=keep add unchanged'", /checks recorded/);
step("holdout command is not in the contract", "git show HEAD:.swarm/G-1/contract.md | grep -c '^holdout'", /^0$/m);
step("holdout command is in the ignored dir", "cat .swarm/G-1/holdout/command", /discover -s \.swarm\/G-1\/holdout/);
step("an open finding blocks baseline", "$S baseline G-1", /not routed/);
step("next says amend", "$S next G-1", /row 4 amend: U-001/);
step("amend", "$S amend G-1 U-001 keep add unchanged", /task amended/);
step("baseline: all checks fail first", "$S baseline G-1", /"passing_before_work": \[\]/);
step("only U-001 is ready", "$S lease G-1 U-002", /not ready/);
step("lease makes a worktree", "$S lease G-1 U-001", /worktree .*\/\.swarm\/\.work\/G-1\/U-001/);
step("brief names the role file", "$S brief G-1 worker U-001", /references\/worker\.md/);

test("worker U-001", () => work("U-001", "printf '\\ndef sub(a, b):\\n    return a - b\\n' >> src/calc.py"));
step("worker reports from inside its worktree", "cd .swarm/.work/G-1/U-001 && $S report G-1 U-001 produced 'sub added'", /leased -> produced/);
step("worktree removed after report", "ls .swarm/.work/G-1 | wc -l", /^\s*0$/m);
step("next says check", "$S next G-1", /row 6 check: U-001/);
step("check passes", "$S check G-1 U-001", /"ok": true/);
step("merge refused before review", "$S merge G-1 U-001", /passed by a verifier/);
step("a verifier write is restored", "echo '# scribble' >> src/calc.py && $S review G-1 U-001 pass looks right", /verifier changed the tree/);
step("tree clean again", "git status --porcelain -- src | wc -l", /^\s*0$/m);
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
step("U-002 merges", "$S merge G-1 U-002", /produced -> merged/);

step("integrate", "$S integrate G-1", /"holdout": "pass"/);
step("whole review fails", "$S review G-1 whole fail 'duplicate helper'", /whole review: fail/);
step("next says add-fix", "$S next G-1", /row 11 add-fix/);
step("add a fix unit", "$S add-fix G-1 tidy src/util.py", /added F-1/);
step("the fix unit is ready", "$S next G-1", /row 8 implement: F-1/);

test("worker F-1", () => {
  sh("$S lease G-1 F-1");
  work("F-1", "printf 'X = 1\\n' > src/util.py");
  sh("$S report G-1 F-1 produced tidy && $S check G-1 F-1 && $S review G-1 F-1 pass ok && $S merge G-1 F-1");
});
step("integrate again after the fix", "$S next G-1", /row 10 integrate/);
step("integrate", "$S integrate G-1", /"suite": "pass"/);
step("second whole review", "$S next G-1", /row 11 whole-review/);
step("whole review passes", "$S review G-1 whole pass clean", /whole review: pass/);
step("prove C1", "$S prove G-1 C1 \"PYTHONPATH=src python3 -c 'from calc import sub; assert sub(5, 3) == 2'\" && tail -1 .swarm/G-1/log.md", /\| proof \|/);
step("a failing proof is refused", "$S prove G-1 C2 false", /not proven/);
step("prove C2", "$S prove G-1 C2 'PYTHONPATH=src python3 -m unittest tests.test_mul -q' && tail -1 .swarm/G-1/log.md", /\| proved \|/);

test("the lock keeps all 10 parallel writes", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve) =>
    spawn("node", [SWARM, "tokens", "G-1", `W-${i}`, "implement", "100"], { cwd: T, env }).on("exit", resolve))));
  assert.match(sh("grep -c '| tokens |' .swarm/G-1/log.md"), /^10$/m);
});

step("next says learn", "$S next G-1", /row 13 learn/);
test("write learn.md", () => write(".swarm/G-1/learn.md",
  "# Learn\n\n## zerg\n\n### P1. demo zerg rule (add)\nlog.md:3\n\n## project\n\n### P2. demo project rule (add)\nlog.md:4\n"));
step("learn routes both lanes", "$S stage G-1 learned", /zerg -> .*inbox\.md/);
step("the project lesson is committed", "git show swarm/G-1:.swarm/LEARNINGS.md", /demo project rule/);
step("the inbox lists the zerg lesson", "$S inbox", /\/G-1\/P1/);
step("accept into rules", `$S accept ${path.basename(T)}/G-1/P1 keep`, /rules\.md/);
step("handoff", "$S handoff G-1", /checked out main/);
step("no leftover worktrees", "git worktree list | wc -l", /^\s*1$/m);
step("state lives on the branch only", "$S status G-1", /check it out first/);
