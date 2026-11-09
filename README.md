# zerg

An [agent skill](https://agentskills.io/specification) that runs a governed swarm of agents on one goal. You give
it a goal in plain language. It writes a contract and a plan, asks you to approve once, runs examiner, worker,
and verifier roles through test-first stages, and hands you a branch to merge.

It works in any agent that can run shell commands. A dependency-free Node script holds every gate, bound, and state change,
so the rules are enforced by code. The skill's instructions cover only the judgment work: planning, writing
tests, writing code, and reviewing it.

The full flow and who talks to whom are in [docs/workflow.md](docs/workflow.md).

## Install

```sh
npx skills add tacoda/zerg            # into this project, for the agents you pick
npx skills add tacoda/zerg -g         # for every project
npx skills check                      # see whether a newer zerg is out
npx skills update zerg                # update it
npx skills remove zerg                # remove it (add -g if you installed it with -g)
```

It needs git, Node.js 18 or later, a POSIX shell (macOS or Linux), and a repo whose test suite runs from one
command. If you installed it with `npx skills`, you already have Node.

Updating or removing the skill never touches `~/.zerg`, which holds your rules, your lesson inbox, and the
worktrees and holdout tests of goals in progress. Delete that folder yourself if you want them gone.

## Use it

Ask your agent to run zerg on a goal:

```
Use zerg to add a CSV export to the reports page.
Resume zerg goal G-csv-export.
Abandon zerg goal G-csv-export: we're doing it another way.
Review my zerg lessons.
```

You're asked for three kinds of decision, and nothing else:
- **Approve** the plan, once. You can also choose `auto` here, which drops stuck units instead of asking.
- **Decide** when the swarm can't move on its own: a stuck unit (answer, rescope, or drop it), or a goal-level
  failure (`reopen` with a fix unit, `waive` a criterion or the whole review, or `abandon` the goal). `auto` never
  decides these goal-level questions for you.
- **Merge** the branch at the end.

To pause new work at any time, run `touch .swarm/STOP`, and delete the file to go on. Don't edit files in the main
tree during a run: the swarm owns it until the hand-off.

## What it does, in order

The row is the number `swarm.mjs next` prints when that step is due.

| Row | Step | Who | Enforced by `swarm.mjs` |
|---|---|---|---|
| 2 | Plan: observable criteria, constraints, units with non-overlapping scope and `after` | orchestrator | `new`, `lint` |
| 3 | Approve, choosing `ask` or `auto`; the script checks for a clean tree and a green suite | you | `summary`, `approve` |
| 4 | Define: unit tests (committed), holdout tests (hidden), findings routed into tasks | examiner, orchestrator | `define`, `amend` |
| 5 | Baseline: every unit's tests fail first | orchestrator | `baseline` |
| 8 | Implement: one unit per worktree, in parallel | worker | `lease`, `report` |
| 6 | Check, review, then merge into `swarm/<goal>` | orchestrator, verifier | `check`, `review`, `merge` |
| 10 | Integrate: full suite and holdout | orchestrator | `integrate` |
| 11 | Prove: every criterion has a passing evidence command, or a waiver | orchestrator | `prove`, `waive` |
| 12 | Whole review: cross-unit findings and the proofs, one automatic fix unit | verifier | `review whole`, `add-fix` |
| 13 | Learn: lessons split into two lanes and routed | orchestrator | `stage learned` |
| 14 | Hand off with the evidence, findings, and token cost, then clean up | orchestrator, then you merge | `handoff` |

Rows 0 and 1 are stops (`.swarm/STOP` and the bounds), 7 handles leases, 9 is where the swarm asks you
something, and 15 means done.

`swarm.mjs next` is the derive table: the agent runs it, does the one action it prints, and runs it again.

## Roles in any agent

The examiner, worker, and verifier are files in `skills/zerg/references/`. `swarm.mjs brief` prints the
whole handoff for one role: a few identifiers and the path to its role file, never a summary of the run.
- **Agents with subagents** give each brief to a fresh subagent. Workers and verifiers run in parallel.
- **Agents without subagents** play each role in turn. That works, but one agent reviewing its own code is
  weaker than two, and the hand-off says so.

Each role records its own result through the script (`define`, `report`, `review`), so the orchestrator never parses free text.

## What the code guarantees

- **One writer at a time:** every change to a goal's state takes `.swarm/.lock`, so parallel agents can't lose updates.
- **Isolation:** every worker gets its own worktree and branch, outside the repo in `$ZERG_HOME/work/`, so your test
  runner never collects another worker's files. `lint` keeps their scopes from overlapping. An optional `setup:`
  command prepares each new worktree, for example `npm ci`.
- **Fail-first tests:** tests come from the examiner and must fail before work starts. A worker's diff must stay inside its scope.
- **Never trust a report:** `report produced` needs commits, `check` runs the tests itself, and `merge` needs a recorded pass.
  `move` can't skip a gate: by hand it only records a lost lease or a drop.
- **Checked ids:** every goal and unit id is validated before it reaches a path, a branch name, or a delete.
- **No shell in planning:** grep criteria run as argv, so `lint` and `summary` never execute contract text.
- **Checks don't repair:** any change in the tree at review, state files included, goes into `git stash` and the
  verdict is refused. A stash, not a discard, so an edit of yours made by mistake mid-run is never lost.
- **Your git setup stays yours:** zerg's own commits, merges, and worktrees skip your hooks and commit signing.
  Worker commits keep them.
- **Holdout stays hidden:** the holdout tests and their command live outside the repo, in `$ZERG_HOME/holdout/`, where
  no test runner collects them. Only the examiner's brief names the folder. This hides it from roles that follow
  their instructions; it doesn't stop one that searches your home folder, because every role runs as your user.
- **Two strikes:** a third failure, or the same failure word for word, makes a unit stuck.
- **Bounds:** no-progress, iteration, lease, and token limits, plus `.swarm/STOP`.
- **Recovery:** every question the swarm can ask has a command that acts on the answer: `answer`, `rescope`,
  `reopen` (a fix unit after a goal-level failure), `waive` (accept a criterion or the whole change), drop, and
  `abandon`.
- **Crash safety:** state writes are atomic, and the lock knows its owner. A command that finds a dead owner's lock
  commits the crashed command's state before it runs. `merge` rolls back to the sha it recorded and recognizes a unit
  a crash already merged, and `approve` resumes on a half-made branch.
- **Nothing merges into your base branch.**

## Known limits

- **macOS and Linux only.** Setup commands, role instructions, and the examples assume a POSIX shell. Windows
  isn't supported in 1.0.
- **One goal at a time per repo.** The main tree sits on `swarm/<goal>` during a run, and `approve` needs a clean tree.
- **Six units at most.** `lint` refuses a bigger plan; split it into goals.
- **The holdout is hidden by convention.** See "Holdout stays hidden" above.
- **One agent playing every role reviews its own work.** That's weaker than separate subagents, and the hand-off says so.
- **A scope entry for a folder that doesn't exist yet** can't be checked at `lint`. Write it as `dir/**`.

## How it learns without an upgrade

There are three rule layers. A later layer wins where two disagree:

| Layer | Where | Written by | Survives an update? |
|---|---|---|---|
| Defaults | the installed skill | a zerg release | replaced |
| User rules | `~/.zerg/rules.md` (`$ZERG_HOME`) | you, by accepting lessons | yes |
| Project rules | `.swarm/LEARNINGS.md` | the swarm, at the learn stage | yes, and it's committed |

Each goal ends with lessons in two lanes. Project lessons go straight to `.swarm/LEARNINGS.md`.
Lessons about zerg itself go to `~/.zerg/inbox.md`. When you ask your agent to review them, it accepts each one
you approve into `rules.md`, or into `~/.zerg/config` if it changes a bound.

Rules change what the roles are told. They can't loosen what the script enforces; that takes a release.

## Develop

```sh
npm test      # unit tests, the agentskills spec check, and the full lifecycle on a throwaway repo (Node 18.6+)
```

The script has no dependencies and no build step. It uses `// @ts-check` with JSDoc types, so your editor
type-checks it as you work.

For live edits while you work, symlink the skill into your agent's skills directory. For Claude Code, that's
`ln -s "$PWD/skills/zerg" ~/.claude/skills/zerg`.

## Where it came from

The stage order follows the wipp factory. The loop discipline follows `/drive` from parento-portal: a derive
table, identifier handoffs, two-strike and no-progress bounds, an interrupt protocol, and a cost report.

## License

MIT. See [LICENSE](LICENSE).
