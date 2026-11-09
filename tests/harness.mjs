// Shared setup for the end-to-end tests: a throwaway repo, a user layer outside it, and the swarm script.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SWARM = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "zerg", "scripts", "swarm.mjs");

export const pyTest = (name, imports, body) =>
  `import unittest\nfrom ${imports}\nclass T(unittest.TestCase):\n    def test_${name}(self): ${body}\n`;

/** A repo at TOP/repo and a ZERG_HOME at TOP/home, so the user layer is always outside the repo. */
export function makeRepo() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "zerg-test-"));
  const T = path.join(top, "repo");
  const HOME = path.join(top, "home");
  fs.mkdirSync(T);
  const env = { ...process.env, ZERG_HOME: HOME };
  const at = (file) => path.join(T, file);

  /** Runs a shell command in the repo; `$S` is the swarm script. Returns stdout and stderr together. */
  const sh = (command, extraEnv = {}) => {
    const proc = spawnSync(command.replaceAll("$S", `node "${SWARM}"`), { shell: true, cwd: T, env: { ...env, ...extraEnv }, encoding: "utf8" });
    return (proc.stdout ?? "") + (proc.stderr ?? "");
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), text);
  };
  const read = (file) => fs.readFileSync(at(file), "utf8");
  const edit = (file, from, to) => write(file, read(file).replace(from, to));
  /** A unit's worktree, read from its brief: it lives outside the repo, in ZERG_HOME. */
  const tree = (goal, unit) => /WORKTREE: (.+)/.exec(sh(`$S brief ${goal} worker ${unit}`))?.[1] ?? "";
  /** A simulated worker: change files inside the worktree `lease` made, then commit. */
  const work = (goal, unit, change) => sh(`cd "${tree(goal, unit)}" && ${change} && git add -A && git commit -qm ${unit}`);
  const cleanup = () => fs.rmSync(top, { recursive: true, force: true });
  return { T, HOME, env, at, sh, write, read, edit, tree, work, cleanup };
}

const SECTIONS = {
  Outcome: "calc gains sub, and a mul module multiplies.",
  Why: "Callers need both.",
  "Non-goals": "- No other operations.",
  Constraints: "- add keeps working.",
  "Escalate when": "- A change needs a file outside its unit's scope.",
};

/** A repo with a green suite and a goal planned to the point of approval. `rows` are plan.md unit rows. */
export function plannedGoal(r, { goal = "G-1", rows, criteria = "- C1: sub(5, 3) returns 2\n- C2: mul(2, 3) returns 6", header = "" }) {
  r.write("src/calc.py", "def add(a, b):\n    return a + b\n");
  r.write("tests/test_calc.py", pyTest("add", "calc import add", "self.assertEqual(add(1, 2), 3)"));
  r.write(".gitignore", ".deps/\n");
  r.sh("git init -q -b main && git add -A && git commit -qm init");
  r.sh(`$S new ${goal}`);
  const contract = `.swarm/${goal}/contract.md`;
  r.edit(contract, "<title>", "add sub and mul");
  r.edit(contract, "<command that runs the full suite>", "PYTHONPATH=src python3 -m unittest discover -s tests -q");
  r.edit(contract, "- C1: an observable result a test or command can show", criteria);
  for (const line of header ? header.split("\n") : []) {
    const key = line.split(":")[0];
    r.write(contract, r.read(contract).replace(new RegExp(`^${key}:.*$`, "m"), line));
  }
  let text = r.read(contract);
  for (const [name, body] of Object.entries(SECTIONS)) {
    text = text.replace(new RegExp(`(## ${name}\\n)[\\s\\S]*?(?=\\n## )`), `$1${body}\n`);
  }
  r.write(contract, text);
  const plan = `.swarm/${goal}/plan.md`;
  const table = r.read(plan).split("\n").filter((l) => !l.startsWith("| U-"));
  const at = table.findIndex((l) => l.startsWith("|---"));
  table.splice(at + 1, 0, ...rows);
  r.write(plan, table.join("\n"));
}

/** Writes the standard unit tests and defines them, then routes nothing and runs the baseline. */
export function definedGoal(r, goal = "G-1") {
  r.write("tests/test_sub.py", pyTest("sub", "calc import sub", "self.assertEqual(sub(5, 3), 2)"));
  r.write("tests/test_mul.py", pyTest("mul", "mul import mul", "self.assertEqual(mul(2, 3), 6)"));
  return r.sh(`$S define ${goal} 'U-001=PYTHONPATH=src python3 -m unittest tests.test_sub -q' ` +
    `'U-002=PYTHONPATH=src python3 -m unittest tests.test_mul -q'`);
}

export const TWO_UNITS = [
  "| U-001 | add sub | src/calc.py | - | C1 | | planned | 0 | |",
  "| U-002 | add mul | src/mul.py | - | C2 | | planned | 0 | |",
];
