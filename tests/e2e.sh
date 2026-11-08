#!/usr/bin/env bash
# Full zerg lifecycle on a throwaway repo, with the roles simulated by shell commands.
# Run: bash tests/e2e.sh   (exits non-zero on the first unexpected result)
set -uo pipefail
S="python3 $(cd "$(dirname "$0")/.." && pwd)/skills/zerg/scripts/swarm.py"
T=$(mktemp -d); export ZERG_HOME="$T/home"; cd "$T"
fails=0
expect() { # description, command, pattern
  local got; got=$(eval "$2" 2>&1)
  if grep -qE "$3" <<<"$got"; then echo "ok   $1"; else echo "FAIL $1"; echo "$got" | sed 's/^/     /'; fails=$((fails+1)); fi
}
worker() { # unit, change; runs inside the worktree lease made
  (cd ".swarm/.work/G-1/$1" && eval "$2" && git add -A && git commit -qm "$1") >/dev/null
}

git init -q -b main && mkdir src tests
printf 'def add(a, b):\n    return a + b\n' > src/calc.py
printf 'import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(1, 2), 3)\n' > tests/test_calc.py
git add -A && git commit -qm init

expect "next before a goal" "$S next G-1" "row 2 scope"
$S new G-1 >/dev/null
python3 - <<'EOF'
from pathlib import Path
c = Path(".swarm/G-1/contract.md"); t = c.read_text()
t = t.replace("<title>", "add sub and mul").replace("<command that runs the full suite>", "PYTHONPATH=src python3 -m unittest discover -s tests -q")
t = t.replace("- C1: an observable result a test or command can show", "- C1: sub(5, 3) returns 2\n- C2: mul(2, 3) returns 6")
c.write_text(t)
p = Path(".swarm/G-1/plan.md"); t = p.read_text()
t = t.replace("| U-001 | one sentence | path/a.py | - | C1 | | planned | 0 | |", "| U-001 | add sub | src/calc.py | - | C1 | | planned | 0 | |")
t = t.replace("| U-002 | one sentence | path/b.py | U-001 | C1, C2 | | planned | 0 | |", "| U-002 | add mul | src/mul.py | U-001 | C2 | | planned | 0 | |")
p.write_text(t)
EOF
expect "lint passes" "$S lint G-1" "plan ok"
expect "summary for approval" "$S summary G-1" "U-002  add mul"
expect "approve" "$S approve G-1 ask" "on swarm/G-1"
expect "infrastructure commit" "git log --oneline" "infrastructure: ignore swarm state"

printf 'import unittest\nfrom calc import sub\nclass T(unittest.TestCase):\n    def test_sub(self): self.assertEqual(sub(5, 3), 2)\n' > tests/test_sub.py
printf 'import unittest\nfrom mul import mul\nclass T(unittest.TestCase):\n    def test_mul(self): self.assertEqual(mul(2, 3), 6)\n' > tests/test_mul.py
printf 'import unittest\nfrom calc import add\nclass H(unittest.TestCase):\n    def test_add_unchanged(self): self.assertEqual(add(-1, 1), 0)\n' > .swarm/G-1/holdout/test_h.py
expect "examiner defines checks" "$S define G-1 'U-001=PYTHONPATH=src python3 -m unittest tests.test_sub -q' 'U-002=PYTHONPATH=src python3 -m unittest tests.test_mul -q' 'holdout=PYTHONPATH=src python3 -m unittest discover -s .swarm/G-1/holdout -q' 'finding:U-001=keep add unchanged'" "checks recorded"
expect "holdout command is not in the contract" "git show HEAD:.swarm/G-1/contract.md | grep -c '^holdout'" "^0$"
expect "holdout command is in the ignored dir" "cat .swarm/G-1/holdout/command" "discover -s .swarm/G-1/holdout"
expect "open finding blocks baseline" "$S baseline G-1" "not routed"
expect "next says amend" "$S next G-1" "row 4 amend: U-001"
$S amend G-1 U-001 keep add unchanged >/dev/null
expect "baseline: all checks fail first" "$S baseline G-1" '"passing_before_work": \[\]'
expect "only U-001 is ready" "$S lease G-1 U-002" "not ready"
expect "lease makes a worktree" "$S lease G-1 U-001" "worktree .*/.swarm/.work/G-1/U-001"
expect "brief names the role file" "$S brief G-1 worker U-001" "references/worker.md"

worker U-001 "printf '\ndef sub(a, b):\n    return a - b\n' >> src/calc.py"
expect "worker reports from inside its worktree" "cd .swarm/.work/G-1/U-001 && $S report G-1 U-001 produced 'sub added'" "leased -> produced"
expect "worktree removed after report" "ls .swarm/.work/G-1" "^$"
expect "next says check" "$S next G-1" "row 6 check: U-001"
expect "check passes" "$S check G-1 U-001" '"ok": true'
expect "merge refused before review" "$S merge G-1 U-001" "passed by a verifier"
echo "# verifier scribble" >> src/calc.py
expect "verifier write is restored" "$S review G-1 U-001 pass looks right" "verifier changed the tree"
expect "tree clean again" "git status --porcelain -- src" "^$"
expect "review pass" "$S review G-1 U-001 pass looks right" "review pass"
expect "next says merge" "$S next G-1" "row 6 merge: U-001"
expect "merge" "$S merge G-1 U-001" "produced -> merged"

$S lease G-1 U-002 >/dev/null
worker U-002 "printf 'def mul(a, b):\n    return a * b\n' > src/mul.py && echo '# x' >> tests/test_calc.py"
$S report G-1 U-002 produced mul >/dev/null
expect "scope violation revises" "$S check G-1 U-002" "outside scope: tests/test_calc.py"
$S lease G-1 U-002 >/dev/null
worker U-002 "printf 'def mul(a, b):\n    return a * b\n' > src/mul.py"
$S report G-1 U-002 produced mul >/dev/null
$S check G-1 U-002 >/dev/null
expect "review fail revises" "$S review G-1 U-002 fail 'src/mul.py:1: no docstring'" "revision 2 -> planned"
$S lease G-1 U-002 >/dev/null
worker U-002 "printf 'def mul(a, b):\n    \"\"\"Multiply.\"\"\"\n    return a * b\n' > src/mul.py"
$S report G-1 U-002 produced mul >/dev/null; $S check G-1 U-002 >/dev/null; $S review G-1 U-002 pass ok >/dev/null
expect "U-002 merges" "$S merge G-1 U-002" "produced -> merged"

expect "integrate" "$S integrate G-1" '"holdout": "pass"'
expect "whole review fail" "$S review G-1 whole fail 'duplicate helper'" "whole review: fail"
expect "next says add-fix" "$S next G-1" "row 11 add-fix"
$S add-fix G-1 "tidy" "src/util.py" >/dev/null
expect "fix unit is ready" "$S next G-1" "row 8 implement: F-1"
$S lease G-1 F-1 >/dev/null
worker F-1 "printf 'X = 1\n' > src/util.py"
$S report G-1 F-1 produced tidy >/dev/null; $S check G-1 F-1 >/dev/null; $S review G-1 F-1 pass ok >/dev/null; $S merge G-1 F-1 >/dev/null
expect "integrate again after the fix" "$S next G-1" "row 10 integrate"
$S integrate G-1 >/dev/null
expect "second whole review" "$S next G-1" "row 11 whole-review"
$S review G-1 whole pass clean >/dev/null
$S prove G-1 C1 "PYTHONPATH=src python3 -c 'from calc import sub; assert sub(5, 3) == 2'" >/dev/null
expect "a failing proof is refused" "$S prove G-1 C2 false" "not proven"
expect "prove the rest" "$S prove G-1 C2 'PYTHONPATH=src python3 -m unittest tests.test_mul -q' && tail -1 .swarm/G-1/log.md" "\\| proved \\|"
for i in 1 2 3 4 5 6 7 8 9 10; do $S tokens G-1 "W-$i" implement 100 & done; wait
expect "lock keeps all 10 parallel writes" "grep -c '| tokens |' .swarm/G-1/log.md" "^10$"
expect "next says learn" "$S next G-1" "row 13 learn"
printf '# Learn\n\n## zerg\n\n### P1. demo zerg rule (add)\nlog.md:3\n\n## project\n\n### P2. demo project rule (add)\nlog.md:4\n' > .swarm/G-1/learn.md
expect "learn routes both lanes" "$S stage G-1 learned" "zerg -> .*inbox.md"
expect "project lesson committed" "git show swarm/G-1:.swarm/LEARNINGS.md" "demo project rule"
expect "inbox lists the zerg lesson" "$S inbox" "/G-1/P1"
expect "accept into rules" "$S accept $(basename "$T")/G-1/P1 keep" "rules.md"
expect "handoff" "$S handoff G-1" "checked out main"
expect "no leftover worktrees" "git worktree list | wc -l" "^ *1$"
expect "state on branch only" "$S status G-1" "check it out first"

rm -rf "$T"
echo "---"; [ "$fails" -eq 0 ] && echo "e2e: all passed" || { echo "e2e: $fails failed"; exit 1; }
