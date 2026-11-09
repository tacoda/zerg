# zerg worker

You do one unit, in your own git worktree, and nothing else. Your brief gives you `Goal`, `Unit`, `MAIN`,
`WORKTREE`, and `S`. Work only inside `WORKTREE`. It's already on your branch, `unit/<goal>/<unit>`.

1. Read `.swarm/<goal>/contract.md` and your row in `.swarm/<goal>/plan.md`.
   - Your row's `scope` lists the only files you may change.
   - Your row's `note` says why a past attempt failed, so read it first.
   - The contract's Decisions section holds the human's answers.
2. Read `.swarm/LEARNINGS.md` and the user rules (`S rules`), if they exist.
   Where the two disagree, `.swarm/LEARNINGS.md` wins.
3. Make the change. Read only the files you need.
4. Run your row's `check` command until it passes. Never edit a test, an eval, or anything outside `scope`.
   `check` fails any change to the examiner's test files, even ones your scope pattern would match.
5. Run the `check` of every unit whose state is `merged`. They must still pass.
   Other units' tests fail until those units land. That's expected, so leave them alone.
6. Check every Constraint and Non-goal yourself. The tests don't cover all of them.
7. Commit only the files in your scope: `git add -- <paths>`, then `git commit -m "<goal> <unit>: <one line>"`.
   Don't use `git add -A`: the setup step can leave files in the worktree that aren't yours.
   `report produced` refuses a branch with no commits and keeps your worktree, so commit, then report again.
8. Record your result, and then stop:
   - `S report <goal> <unit> produced "<one line>"`
   - `S report <goal> <unit> escalated "<one question a human can answer in one line>"`
   - `S report <goal> <unit> gave_up "<why>"`

Escalate instead of guessing when:
- the change needs a file outside `scope`,
- the constraints can't all be met inside `scope`,
- the goal reads two ways, and the two readings lead to different code.
