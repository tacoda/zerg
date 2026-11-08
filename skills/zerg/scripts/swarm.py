#!/usr/bin/env python3
"""zerg control plane: the deterministic half of the zerg skill. State, gates, bounds, and checks.

State lives in .swarm/<goal>/ (contract.md, plan.md, log.md) and is committed on swarm/<goal>
by every command that changes it, so worker worktrees always branch from current state.

  new <goal>                          scaffold contract.md and plan.md, add gitignore lines
  lint <goal>                         plan gate: sections, criteria, scopes, deps, coverage
  approve <goal> [ask|auto]           lint + clean tree + green suite on base, then branch swarm/<goal>
  define <goal> U-001='cmd' .. [holdout='cmd'] [finding:U-001='text']   examiner's checks and findings;
                                      the holdout command is stored in the gitignored holdout dir
  amend <goal> <unit> <text>          route an examiner finding into a planned unit's task
  baseline <goal>                     every unit check must fail before any work
  next <goal>                         the derive table: prints the one next action, counts a pass
  peek <goal>                         the same row, without counting a pass
  summary <goal>                      the approval brief, built from contract.md and plan.md
  lease <goal> <unit>..               STOP, budget, deps, parallelism; leased, with a worktree per unit
  brief <goal> <role> [unit]          the handoff text for a subagent (examiner, worker, verifier)
  report <goal> <unit> produced|escalated|gave_up [text]   a worker records its own result
  review <goal> <unit|whole> pass|fail [reason]            a verifier records its verdict
  produced <goal> <unit> [summary]    accepted only if the unit branch has commits
  check <goal> <unit>                 scope + unit check in a temp worktree; revises on failure
  merge <goal> <unit>                 needs a recorded pass; merges, re-runs merged checks; rolls back on red
  revise <goal> <unit> <note>         two strikes, or the same note word for word, makes it stuck
  move <goal> <unit> <state> [note]   stuck (escalation), dropped, planned (lease lost)
  answer <goal> <unit|goal> <text>    record a human decision in the contract; unit back to planned
  rescope <goal> <unit> <scope> [why] a human decision: new scope for a stuck unit
  add-fix <goal> <task> <scope>       one fix unit for a blocking whole-review finding
  integrate <goal>                    full suite + holdout; holdout reports pass/fail only
  prove <goal> <criterion> <cmd..>    run evidence for one criterion; all proven -> proved
  stage <goal> whole-review|learned|finding [note]   `learned` routes learn.md: project lane to
                                      .swarm/LEARNINGS.md, zerg lane to $ZERG_HOME/inbox.md
  tokens <goal> <who> <stage> <n>     record a dispatch's token use
  status <goal>                       unit table, goal events, token totals

User layer, in $ZERG_HOME (default ~/.zerg), outside the plugin so it survives upgrades:
  home                                paths and the bounds in effect
  inbox                               pending zerg proposals routed by `stage learned`
  accept <id> [note]                  move a proposal into rules.md, which every goal reads
  dismiss <id> [reason]               archive a proposal without using it
  config <key> <n>                    override max_revisions, max_passes, or no_progress
  handoff <goal>                      final report, then check out base

Stdlib only, Python 3.8+. Every state change takes .swarm/.lock, so parallel agents can call it safely.
"""
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

SCRIPT = Path(__file__).resolve()
SKILL_DIR = SCRIPT.parent.parent
TEMPLATES = SKILL_DIR / "assets"
IGNORES = [".swarm/*/holdout/", ".swarm/.tmp/", ".swarm/.work/", ".swarm/.lock", ".swarm/STOP", ".claude/worktrees/"]
# Worker worktrees (Agent isolation) live here; they are never a verifier's writes.
NOT_TREE = (".claude/worktrees/", ".swarm/.tmp/", ".swarm/.work/", ".swarm/.lock")
ROLES = ("examiner", "worker", "verifier")
COLUMNS = ["unit", "task", "scope", "after", "criteria", "check", "state", "revisions", "note"]
SECTIONS = ["Outcome", "Why", "Non-goals", "Constraints", "Criteria", "Escalate when"]
TRANSITIONS = {
    "planned": {"leased", "dropped", "stuck"},
    "leased": {"produced", "stuck", "planned"},
    "produced": {"merged", "planned", "stuck"},
    "stuck": {"planned", "dropped"},
    "merged": set(),
    "dropped": set(),
}
CLOSED = {"merged", "dropped"}
# Defaults. A user's ~/.zerg/config (or $ZERG_HOME/config) overrides them without a plugin upgrade.
BOUNDS = {"max_revisions": 2, "max_passes": 20, "no_progress": 3}


# --- pure functions (covered by test_swarm.py) ---

def clean(value):
    return " ".join(str(value).replace("|", "/").split())


def split_list(cell):
    return [item.strip() for item in cell.split(",") if item.strip() not in ("", "-")]


def parse_table(text):
    rows = [line for line in text.splitlines() if line.startswith("|")][2:]
    units = []
    for line in rows:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        units.append({**dict.fromkeys(COLUMNS, ""), **dict(zip(COLUMNS, cells))})
    return units


def render_table(units):
    head = "| " + " | ".join(COLUMNS) + " |"
    rule = "|" + "---|" * len(COLUMNS)
    body = ["| " + " | ".join(clean(u.get(c, "")) for c in COLUMNS) + " |" for u in units]
    return "\n".join([head, rule, *body])


def replace_table(text, units):
    lines = text.splitlines()
    rows = [i for i, line in enumerate(lines) if line.startswith("|")]
    if not rows:
        return text.rstrip() + "\n\n" + render_table(units) + "\n"
    return "\n".join(lines[:rows[0]] + render_table(units).splitlines() + lines[rows[-1] + 1:]) + "\n"


def parse_header(text):
    head = text.split("\n## ", 1)[0]
    data = {}
    for line in head.splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith(("#", " ", "-")):
            data[key.strip()] = value.strip()
    return data


def set_header(text, key, value):
    head, sep, rest = text.partition("\n## ")
    lines = head.splitlines()
    for i, line in enumerate(lines):
        if line.partition(":")[0].strip() == key and not line.startswith("#"):
            lines[i] = f"{key}: {value}"
            return "\n".join(lines) + sep + rest
    lines.insert(2 if len(lines) > 1 else len(lines), f"{key}: {value}")
    return "\n".join(lines) + sep + rest


def section(text, name):
    match = re.search(rf"^## {re.escape(name)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1) if match else ""


def criteria(text):
    return re.findall(r"^- (C\d+):", section(text, "Criteria"), re.M)


def grep_criteria(text):
    """(criterion, command) for every backticked `grep ...` in the Criteria section."""
    pairs = []
    for cid, body in re.findall(r"^- (C\d+):(.*)$", section(text, "Criteria"), re.M):
        pairs += [(cid, cmd) for cmd in re.findall(r"`(grep [^`]+)`", body)]
    return pairs


def grep_hit_files(output):
    return sorted({line.split(":", 1)[0] for line in output.splitlines() if line.strip()})


def grep_problems(cid, files, units):
    """Every file a grep criterion hits must sit in the scope of a unit that serves that criterion."""
    serving = [u for u in units if cid in split_list(u["criteria"])]
    globs = [g for u in serving for g in split_list(u["scope"])]
    return [f"{cid}: its grep hits {f}, which no unit serving {cid} has in scope" for f in files
            if not any(fnmatch.fnmatch(f, g) for g in globs)]


def open_findings(rows):
    """Units with an examiner finding not yet routed into their task by `amend`."""
    open_units = set()
    for e in rows:
        if e["event"] == "examiner-finding":
            open_units.add(e["subject"])
        elif e["event"] == "amended":
            open_units.discard(e["subject"])
    return sorted(open_units)


def split_lanes(text):
    """learn.md has a `## zerg` and a `## project` section; return each body, or '' when it holds no proposal."""
    lanes = {}
    for lane in ("zerg", "project"):
        body = section(text, lane).strip()
        lanes[lane] = "" if not body or body.lower().rstrip(".") in ("none", "no proposals") else body
    return lanes


def parse_inbox(text):
    """Pending zerg proposals: [{id, source, title, body}], id = '<source first word>/<goal>/<Pn>'."""
    proposals = []
    for block in re.split(r"^## ", text, flags=re.M)[1:]:
        source, _, rest = block.partition("\n")
        words = source.split()
        for item in re.split(r"^### ", rest, flags=re.M)[1:]:
            title, _, body = item.partition("\n")
            number = title.split(".", 1)[0].strip()
            proposals.append({"id": "/".join([*words[:2], number]), "source": source.strip(),
                              "title": title.strip(), "body": body.strip()})
    return proposals


def render_inbox(proposals):
    lines = ["# inbox"]
    for source in dict.fromkeys(p["source"] for p in proposals):
        lines += ["", f"## {source}"]
        for p in (p for p in proposals if p["source"] == source):
            lines += ["", f"### {p['title']}", p["body"]]
    return "\n".join(lines) + "\n"


def globs_overlap(left, right):
    return any(fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a) for a in left for b in right)


def merge_order(units):
    order, placed = [], set()
    while len(order) < len(units):
        batch = [u["unit"] for u in units if u["unit"] not in placed and set(split_list(u["after"])) <= placed]
        if not batch:
            raise ValueError("cycle")
        order += batch
        placed |= set(batch)
    return order


def row_problems(unit, ids, crits):
    uid = unit["unit"]
    problems = [] if split_list(unit["scope"]) else [f"{uid}: empty scope"]
    problems += [f"{uid}: unknown after {d}" for d in split_list(unit["after"]) if d not in ids]
    problems += [f"{uid}: unknown criterion {c}" for c in split_list(unit["criteria"]) if c not in crits]
    return problems


def plan_problems(units, crits):
    ids = [u["unit"] for u in units]
    problems = [] if units else ["plan: no units"]
    problems += [f"plan: duplicate unit {i}" for i in sorted({i for i in ids if ids.count(i) > 1})]
    for unit in units:
        problems += row_problems(unit, ids, crits)
    covered = {c for u in units for c in split_list(u["criteria"])}
    problems += [f"plan: criterion {c} has no unit" for c in crits if c not in covered]
    problems += [f"plan: scopes overlap: {a['unit']} and {b['unit']}"
                 for i, a in enumerate(units) for b in units[i + 1:]
                 if globs_overlap(split_list(a["scope"]), split_list(b["scope"]))]
    try:
        merge_order([u for u in units if all(d in ids for d in split_list(u["after"]))])
    except ValueError:
        problems.append("plan: after has a cycle")
    return problems


def lint_problems(text, units):
    header = parse_header(text)
    problems = [f"contract: empty section ## {s}" for s in SECTIONS if not section(text, s).strip()]
    problems += [f"contract: missing header {k}" for k in ("base", "test") if not header.get(k)]
    problems += [f"contract: header {k} is still a placeholder" for k, v in header.items()
                 if v.startswith("<") and v.endswith(">")]
    crits = criteria(text)
    if not crits:
        problems.append("contract: no criteria like '- C1: ...'")
    return problems + plan_problems(units, crits)


def check_transition(current, target):
    if target not in TRANSITIONS.get(current, set()):
        return f"illegal transition: {current} -> {target}"
    return None


def revise_unit(unit, note, max_revisions=BOUNDS["max_revisions"]):
    """Two strikes: a third failure, or the same failure word for word, makes the unit stuck."""
    note = clean(note)
    revisions = int(unit["revisions"] or 0) + 1
    stuck = revisions > max_revisions or note == unit["note"]
    return {**unit, "revisions": str(revisions), "state": "stuck" if stuck else "planned", "note": note}


def blocked_units(units):
    by_id = {u["unit"]: u for u in units}
    return [u["unit"] for u in units if u["state"] == "planned"
            and any(by_id[d]["state"] in ("dropped", "stuck") for d in split_list(u["after"]) if d in by_id)]


def ready_units(units, max_parallel):
    by_id = {u["unit"]: u for u in units}
    busy = sum(u["state"] in ("leased", "produced") for u in units)
    ready = [u["unit"] for u in units if u["state"] == "planned"
             and all(by_id[d]["state"] == "merged" for d in split_list(u["after"]) if d in by_id)]
    return ready[:max(0, max_parallel - busy)]


def goal_events(entries):
    """Goal-level events that still hold. A fix unit reopens integration."""
    events = set()
    for entry in entries:
        if entry["event"] == "reopened":
            events -= {"integrated", "proved", "whole-blocking"}
        events.add(entry["event"])
    return events


def bound_hit(entries, budget, bounds=BOUNDS):
    passes = [e for e in entries if e["event"] == "pass"]
    if len(passes) >= bounds["max_passes"]:
        return f"iteration cap: {len(passes)} passes"
    window = bounds["no_progress"]
    recent = [p["note"] for p in passes[-window:]]
    if len(recent) == window and len(set(recent)) == 1:
        return f"no progress: {window} passes with the same state"
    spent = token_total(entries)
    if budget and spent >= budget:
        return f"token budget spent: {spent} of {budget}"
    return None


def token_total(entries):
    return sum(int(e["note"].split()[-1]) for e in entries if e["event"] == "tokens")


def ids_in(units, state):
    return [u["unit"] for u in units if u["state"] == state]


def derive_open(s):
    """Rows 0 to 5: gates before any unit work."""
    if s["stop"]:
        return 0, "stop", ".swarm/STOP is present"
    if s["bound"]:
        return 1, "stop", s["bound"]
    if not s["has_contract"]:
        return 2, "scope", "run `new`, write contract.md and plan.md, then `lint`"
    if "approved" not in s["events"]:
        if s["lint"]:
            return 2, "plan", "; ".join(s["lint"])
        return 3, "approve", "show contract, questions, and units; interrupt; then `approve`"
    if "defined" not in s["events"] or any(not u["check"] for u in s["units"] if u["state"] not in CLOSED):
        return 4, "define", "dispatch swarm-examiner, then `define`"
    if s.get("open_findings"):
        return 4, "amend", " ".join(s["open_findings"])
    if "baseline" not in s["events"]:
        return 5, "baseline", "run `baseline`; re-dispatch the examiner for any unit whose check passes"
    return None


def unit_phase(rows, uid):
    """For a produced unit: what it needs next, from its log since it was last produced."""
    events = [e["event"] for e in rows if e["subject"] == uid]
    start = max((i for i, e in enumerate(events) if e == "produced"), default=0)
    since = events[start:]
    return "merge" if "review-pass" in since else "review" if "check-ok" in since else "check"


def derive_units(s):
    """Rows 6 to 9: the implement, check, review, merge loop."""
    units = s["units"]
    produced = ids_in(units, "produced")
    for phase in ("check", "review", "merge"):
        due = [uid for uid in produced if s["phases"].get(uid) == phase]
        if due:
            return 6, phase, " ".join(due)
    if ids_in(units, "leased"):
        return 7, "orphans", " ".join(ids_in(units, "leased"))
    ready = ready_units(units, s["max_parallel"])
    if ready:
        return 8, "implement", " ".join(ready)
    stuck = ids_in(units, "stuck") + blocked_units(units)
    if stuck:
        return 9, "auto-drop" if s["autonomy"] == "auto" else "interrupt", " ".join(stuck)
    return None


def derive_close(s):
    """Rows 10 to 15: integration to hand-off."""
    events = s["events"]
    if "integrated" not in events:
        return 10, "integrate", "run `integrate`"
    if "whole-review" not in events:
        if "whole-blocking" in events:
            if s.get("fix_exists"):
                return 9, "interrupt", "goal: a second blocking whole-review finding; ask the human"
            return 11, "add-fix", "run `add-fix` for the blocking finding in the log"
        return 11, "whole-review", "dispatch a verifier with `brief <goal> verifier whole`"
    if s["unproven"]:
        return 12, "prove", " ".join(s["unproven"])
    if "learned" not in events:
        return 13, "learn", "write learn.md, then `stage learned`"
    if "handed-off" not in events:
        return 14, "handoff", "run `handoff`"
    return 15, "done", "nothing left to do"


def derive(s):
    return derive_open(s) or derive_units(s) or derive_close(s)


def fingerprint(units, events):
    return clean(",".join(f"{u['unit']}:{u['state']}:{u['revisions']}" for u in units) + " " + ",".join(sorted(events)))


# --- I/O ---

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def git(*args, cwd=None, check=True):
    proc = subprocess.run(["git", *args], cwd=cwd or root(), capture_output=True, text=True)
    if check and proc.returncode:
        fail(f"git {' '.join(args)}: {proc.stderr.strip()}")
    return proc


def out(*args, cwd=None):
    return git(*args, cwd=cwd).stdout.strip()


def root():
    proc = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                          capture_output=True, text=True)
    if proc.returncode:
        fail("not inside a git repository")
    return Path(proc.stdout.strip()).parent


def run(command, cwd):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(command, shell=True, cwd=cwd, capture_output=True, text=True, env=env)
    return proc.returncode == 0, (proc.stdout + proc.stderr)[-3000:]


def last_line(text):
    lines = text.strip().splitlines()
    return lines[-1] if lines else ""


def goal_dir(goal):
    return root() / ".swarm" / goal


def contract_text(goal):
    return require_file(goal, "contract.md").read_text()


def require_file(goal, name):
    path = goal_dir(goal) / name
    if not path.exists():
        on_branch = git("rev-parse", "--verify", "--quiet", f"swarm/{goal}", check=False).returncode == 0
        fail(f"{goal}: state lives on swarm/{goal}; check it out first" if on_branch else f"no goal {goal}")
    return path


def plan_path(goal):
    return require_file(goal, "plan.md")


def load_units(goal):
    return parse_table(plan_path(goal).read_text())


def save_units(goal, units):
    path = plan_path(goal)
    path.write_text(replace_table(path.read_text(), units))


def get_unit(units, uid):
    for unit in units:
        if unit["unit"] == uid:
            return unit
    fail(f"no unit {uid}")


def put_unit(units, new):
    return [new if u["unit"] == new["unit"] else u for u in units]


def entries(goal):
    path = goal_dir(goal) / "log.md"
    rows = []
    for line in path.read_text().splitlines() if path.exists() else []:
        parts = [p.strip() for p in line.lstrip("- ").split("|")]
        if len(parts) >= 4:
            rows.append({"ts": parts[0], "subject": parts[1], "event": parts[2], "note": " | ".join(parts[3:])})
    return rows


def log(goal, subject, event, note=""):
    with open(goal_dir(goal) / "log.md", "a") as f:
        f.write(f"- {time.strftime('%Y-%m-%dT%H:%M:%S')} | {subject} | {event} | {clean(note)}\n")


def branch():
    return out("branch", "--show-current")


def on_swarm(goal):
    if branch() != f"swarm/{goal}":
        fail(f"check out swarm/{goal} first (on {branch() or 'detached HEAD'})")


def save(goal, message):
    if branch() != f"swarm/{goal}":
        return
    git("add", "--", f".swarm/{goal}")
    if git("diff", "--cached", "--quiet", check=False).returncode:
        git("commit", "-q", "-m", f"swarm {goal}: {message}")


def require(goal, event):
    if event not in goal_events(entries(goal)):
        fail(f"{goal}: `{event}` hasn't happened yet")


def holdout_command(goal):
    """Kept in the gitignored holdout dir, so no worktree and no worker ever sees it."""
    path = goal_dir(goal) / "holdout" / "command"
    return path.read_text().strip() if path.exists() else ""


def stopped():
    return (root() / ".swarm" / "STOP").exists()


def budget(goal):
    value = parse_header(contract_text(goal)).get("token_budget", "")
    return int(value) if value.isdigit() else 0


def dirty_paths():
    lines = git("status", "--porcelain", "--untracked-files=all").stdout.splitlines()
    return [line[3:] for line in lines if line.strip() and not line[3:].startswith(NOT_TREE)]


def holdout_tracked(goal):
    return bool(out("ls-files", f".swarm/{goal}/holdout"))


def update_unit(goal, uid, event, log_note="", **fields):
    units = load_units(goal)
    unit = {**get_unit(units, uid), **fields}
    save_units(goal, put_unit(units, unit))
    log(goal, uid, event, log_note)
    return unit


def move_unit(goal, uid, target, note=""):
    unit = get_unit(load_units(goal), uid)
    error = check_transition(unit["state"], target)
    if error:
        fail(f"{uid}: {error}")
    update_unit(goal, uid, target, note, state=target, note=clean(note) or unit["note"])
    save(goal, f"{uid} {target}")
    print(f"{uid}: {unit['state']} -> {target}")


def revise(goal, uid, note):
    units = load_units(goal)
    current = get_unit(units, uid)
    if current["state"] not in ("leased", "produced"):
        fail(f"{uid} is {current['state']}; only leased or produced units are revised")
    unit = revise_unit(current, note, user_bounds()["max_revisions"])
    save_units(goal, put_unit(units, unit))
    log(goal, uid, "revise" if unit["state"] == "planned" else "stuck", note)
    save(goal, f"{uid} {unit['state']}")
    print(f"{uid}: revision {unit['revisions']} -> {unit['state']}: {unit['note']}")


@contextmanager
def state_lock():
    """One state writer at a time, so parallel agents calling the script can't lose each other's updates."""
    path = root() / ".swarm" / ".lock"
    path.parent.mkdir(exist_ok=True)
    deadline = time.time() + 900
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - path.stat().st_mtime > 1800:
                    path.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.time() > deadline:
                fail("another zerg command has held .swarm/.lock for 15 minutes")
            time.sleep(0.2)
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


def worktree_path(goal, uid):
    return root() / ".swarm" / ".work" / goal / uid


def remove_worktree_for(ref):
    blocks = out("worktree", "list", "--porcelain").split("\n\n")
    for block in blocks:
        fields = dict(line.split(" ", 1) for line in block.splitlines() if " " in line)
        if fields.get("branch") == f"refs/heads/{ref}":
            git("worktree", "remove", "--force", fields["worktree"], check=False)


def make_worktree(goal, uid):
    ref, path = f"unit/{goal}/{uid}", worktree_path(goal, uid)
    remove_worktree_for(ref)
    shutil.rmtree(path, ignore_errors=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "-q", "-B", ref, str(path), f"swarm/{goal}")
    return path


def ensure_ignores():
    path = root() / ".gitignore"
    lines = path.read_text().splitlines() if path.exists() else []
    path.write_text("\n".join(lines + [i for i in IGNORES if i not in lines]) + "\n")


# --- commands: the user layer (no goal, no repo needed) ---

def take_from_inbox(pid):
    proposals = parse_inbox(inbox_path().read_text() if inbox_path().exists() else "")
    match = [p for p in proposals if p["id"] == pid]
    if not match:
        fail(f"no pending proposal {pid}; run `inbox`")
    inbox_path().write_text(render_inbox([p for p in proposals if p["id"] != pid]))
    return match[0]


def archive(proposal, status, note):
    append_block(zerg_home() / "archive.md", f"{proposal['id']}: {status} {time.strftime('%Y-%m-%d')}",
                 f"### {proposal['title']}\n{proposal['body']}\n\n{clean(note) or 'no note'}")


def cmd_home():
    print(f"home:   {zerg_home()}")
    for name in ("rules.md", "inbox.md", "archive.md", "config"):
        path = zerg_home() / name
        print(f"{name + ':':8}{path}{'' if path.exists() else '  (none yet)'}")
    print("bounds: " + ", ".join(f"{k}={v}" for k, v in user_bounds().items()))


def cmd_inbox():
    proposals = parse_inbox(inbox_path().read_text() if inbox_path().exists() else "")
    print("\n".join(f"{p['id']}  {p['title']}" for p in proposals) or "inbox is empty")


def cmd_accept(pid, *note):
    """Accepted zerg lessons become user rules, which the skill and every agent read on each goal."""
    proposal = take_from_inbox(pid)
    append_block(zerg_home() / "rules.md", proposal["title"],
                 f"{proposal['body']}\n\n_from {proposal['source']}; accepted {time.strftime('%Y-%m-%d')}_")
    archive(proposal, "accepted", " ".join(note))
    print(f"{pid}: added to {zerg_home() / 'rules.md'}")


def cmd_dismiss(pid, *reason):
    archive(take_from_inbox(pid), "dismissed", " ".join(reason))
    print(f"{pid}: dismissed")


def cmd_config(key, value):
    if key not in BOUNDS or not value.isdigit() or int(value) < 1:
        fail(f"config takes one of {', '.join(BOUNDS)} and a whole number of 1 or more")
    path = zerg_home() / "config"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [l for l in (path.read_text().splitlines() if path.exists() else []) if l.partition(":")[0].strip() != key]
    path.write_text("\n".join(lines + [f"{key}: {value}"]) + "\n")
    print(f"{key} = {value} in {path}")


# --- commands: plan and approve ---

def cmd_new(goal):
    target = goal_dir(goal)
    if target.exists():
        fail(f"{goal} already exists")
    (target / "holdout").mkdir(parents=True)
    contract = (TEMPLATES / "contract.md").read_text().replace("<goal>", goal)
    target.joinpath("contract.md").write_text(set_header(contract, "base", branch()))
    target.joinpath("plan.md").write_text((TEMPLATES / "plan.md").read_text().replace("<goal>", goal))
    ensure_ignores()
    log(goal, goal, "created")
    print(f"created .swarm/{goal}: fill contract.md and plan.md, then run lint")


def run_grep_criteria(text, units):
    problems = []
    for cid, command in grep_criteria(text):
        _, output = run(command, root())
        problems += grep_problems(cid, grep_hit_files(output), units)
    return problems


def all_plan_problems(goal):
    text, units = contract_text(goal), load_units(goal)
    return lint_problems(text, units) + run_grep_criteria(text, units)


def cmd_lint(goal):
    problems = all_plan_problems(goal)
    print("\n".join(problems) or f"{goal}: plan ok")
    sys.exit(1 if problems else 0)


def cmd_approve(goal, autonomy="ask"):
    if autonomy not in ("ask", "auto"):
        fail("autonomy is ask or auto")
    text = contract_text(goal)
    header = parse_header(text)
    problems = all_plan_problems(goal)
    if problems:
        fail("plan fails lint:\n" + "\n".join(problems))
    if branch() != header["base"]:
        fail(f"approve from {header['base']}, not {branch()}")
    foreign = [p for p in dirty_paths() if not p.startswith((f".swarm/{goal}/", ".gitignore"))]
    if foreign:
        fail("tree not clean: " + ", ".join(foreign))
    ok, output = run(header["test"], root())
    if not ok:
        fail("the suite is red on base, so the swarm can't tell its breakage from what's already broken:\n" + output)
    git("checkout", "-q", "-b", f"swarm/{goal}")
    git("add", "--", ".gitignore")
    if git("diff", "--cached", "--quiet", check=False).returncode:
        # Infrastructure, owned by zerg rather than a unit; the whole review skips this commit.
        git("commit", "-q", "-m", f"swarm {goal}: infrastructure: ignore swarm state")
    (goal_dir(goal) / "contract.md").write_text(set_header(text, "autonomy", autonomy))
    log(goal, goal, "approved", f"autonomy {autonomy}")
    save(goal, "approved plan")
    print(f"on swarm/{goal}; autonomy {autonomy}")


# --- commands: define and baseline ---

def foreign_define_changes(goal, units):
    scopes = [g for u in units for g in split_list(u["scope"])]
    state_files = {f".swarm/{goal}/{name}" for name in ("contract.md", "plan.md", "log.md")}
    return [p for p in dirty_paths() if p in state_files or any(fnmatch.fnmatch(p, g) for g in scopes)]


def cmd_define(goal, *pairs):
    require(goal, "approved")
    on_swarm(goal)
    units = load_units(goal)
    foreign = foreign_define_changes(goal, units)
    if foreign:
        fail("the examiner changed product or state files: " + ", ".join(foreign))
    if holdout_tracked(goal):
        fail(f"holdout tests are tracked by git; untrack them, {IGNORES[0]} must stay ignored")
    assigns = dict(pair.split("=", 1) for pair in pairs)
    for key in [k for k in assigns if k.startswith("finding:")]:
        uid = key.split(":", 1)[1]
        get_unit(units, uid)
        log(goal, uid, "examiner-finding", assigns.pop(key))
    if "holdout" in assigns:
        (goal_dir(goal) / "holdout").mkdir(exist_ok=True)
        (goal_dir(goal) / "holdout" / "command").write_text(assigns.pop("holdout") + "\n")
    for uid, command in assigns.items():
        if "|" in command:
            fail(f"{uid}: a check command can't contain '|'")
        units = put_unit(units, {**get_unit(units, uid), "check": command})
    save_units(goal, units)
    git("add", "-A")
    git("commit", "-q", "-m", f"swarm {goal}: tests for {', '.join(assigns) or 'holdout'}")
    if all(u["check"] for u in units if u["state"] not in CLOSED):
        log(goal, goal, "defined")
    save(goal, "defined")
    print(f"checks recorded for {', '.join(assigns) or 'none'}")


def baseline_unit(goal, unit, earlier):
    ok, _ = run(unit["check"], root())
    if not ok:
        return None
    if earlier.count(unit["unit"]) >= 1:
        update_unit(goal, unit["unit"], "stuck", "tests pass before any change, twice", state="stuck",
                    note="tests pass before any change; the examiner could not strengthen them")
        return None
    log(goal, unit["unit"], "baseline-pass")
    return unit["unit"]


def cmd_baseline(goal):
    require(goal, "defined")
    on_swarm(goal)
    pending = open_findings(entries(goal))
    if pending:
        fail(f"examiner findings not routed into a task yet: {', '.join(pending)}; run `amend` for each")
    earlier = [e["subject"] for e in entries(goal) if e["event"] == "baseline-pass"]
    passing = [uid for u in load_units(goal) if u["state"] == "planned"
               if (uid := baseline_unit(goal, u, earlier))]
    holdout = holdout_command(goal)
    holdout_now = "none"
    if holdout:
        holdout_now = "pass" if run(holdout, root())[0] else "fail"
        log(goal, goal, "holdout-baseline", holdout_now)
    if not passing:
        log(goal, goal, "baseline")
    save(goal, "baseline")
    print(json.dumps({"passing_before_work": passing, "holdout_now": holdout_now}, indent=2))
    sys.exit(1 if passing else 0)


# --- commands: the unit loop ---

def current_row(goal):
    text, units, log_rows = contract_text(goal), load_units(goal), entries(goal)
    events = goal_events(log_rows)
    header = parse_header(text)
    proven = {e["subject"] for e in log_rows if e["event"] == "proof"}
    state = {
        "stop": stopped(), "bound": bound_hit(log_rows, budget(goal), user_bounds()), "has_contract": True,
        "lint": lint_problems(text, units), "events": events, "units": units,
        "max_parallel": int(header.get("max_parallel") or 3), "autonomy": header.get("autonomy", "ask"),
        "unproven": [c for c in criteria(text) if c not in proven],
        "open_findings": open_findings(log_rows),
        "phases": {u["unit"]: unit_phase(log_rows, u["unit"]) for u in units if u["state"] == "produced"},
        "fix_exists": any(u["unit"].startswith("F-") for u in units),
    }
    return derive(state), fingerprint(units, events)


def cmd_peek(goal):
    if not goal_dir(goal).exists():
        print("row 2 scope: run `new`, write contract.md and plan.md, then `lint`")
        return
    (row, action, detail), _ = current_row(goal)
    print(f"row {row} {action}: {detail}")


def cmd_next(goal):
    if not goal_dir(goal).exists():
        cmd_peek(goal)
        return
    (row, action, detail), print_ = current_row(goal)
    log(goal, goal, "pass", print_)
    save(goal, f"pass: row {row}")
    print(f"row {row} {action}: {detail}")


def cmd_lease(goal, *uids):
    require(goal, "baseline")
    if stopped():
        fail(".swarm/STOP is present: no new leases")
    spent, limit = token_total(entries(goal)), budget(goal)
    if limit and spent >= limit:
        fail(f"token budget spent: {spent} of {limit}")
    units = load_units(goal)
    ready = ready_units(units, int(parse_header(contract_text(goal)).get("max_parallel") or 3))
    not_ready = [uid for uid in uids if uid not in ready]
    if not_ready:
        fail(f"not ready to lease: {', '.join(not_ready)} (ready: {', '.join(ready) or 'none'})")
    for uid in uids:
        update_unit(goal, uid, "leased", state="leased")
    save(goal, f"lease {' '.join(uids)}")
    for uid in uids:
        print(f"leased {uid}: worktree {make_worktree(goal, uid)}")


def cmd_produced(goal, uid, summary=""):
    if get_unit(load_units(goal), uid)["state"] != "leased":
        fail(f"{uid} is not leased")
    ref = f"unit/{goal}/{uid}"
    exists = git("rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0
    ahead = int(out("rev-list", "--count", f"swarm/{goal}..{ref}")) if exists else 0
    if not ahead:
        revise(goal, uid, f"worker reported produced, but {ref} has no commits")
        sys.exit(1)
    move_unit(goal, uid, "produced", summary)


def scope_violations(changed, globs):
    return [path for path in changed if not any(fnmatch.fnmatch(path, g) for g in globs)]


def run_in_worktree(ref, command):
    tree = root() / ".swarm" / ".tmp" / ref.replace("/", "-")
    git("worktree", "remove", "--force", str(tree), check=False)
    shutil.rmtree(tree, ignore_errors=True)
    git("worktree", "add", "-q", "--detach", str(tree), ref)
    try:
        return run(command, tree)
    finally:
        git("worktree", "remove", "--force", str(tree), check=False)


def cmd_check(goal, uid):
    unit = get_unit(load_units(goal), uid)
    if unit["state"] != "produced":
        fail(f"{uid} is {unit['state']}, not produced")
    ref = f"unit/{goal}/{uid}"
    changed = out("diff", "--name-only", f"swarm/{goal}...{ref}").splitlines()
    violations = scope_violations(changed, split_list(unit["scope"]))
    ok, output = run_in_worktree(ref, unit["check"])
    problem = ("no changes" if not changed else f"outside scope: {', '.join(violations)}" if violations
               else None if ok else f"check fails: {last_line(output)}")
    print(json.dumps({"ok": problem is None, "changed": changed, "scope_violations": violations,
                      "check": "pass" if ok else "fail", "output": "" if ok else output}, indent=2))
    if problem:
        revise(goal, uid, problem)
        sys.exit(1)
    log(goal, uid, "check-ok")
    save(goal, f"{uid} checked")


def restore_after_verifier(goal):
    """Checks do not repair: undo anything a verifier wrote, and say so."""
    dirty = [p for p in dirty_paths() if not p.startswith(f".swarm/{goal}/")]
    if not dirty:
        return
    tracked = [p for p in dirty if out("ls-files", "--", p)]
    if tracked:
        git("restore", "--staged", "--worktree", "--", *tracked, check=False)
    leftover = [p for p in dirty if p not in tracked]
    log(goal, goal, "verifier-wrote", ", ".join(dirty))
    fail(f"a verifier changed the tree ({', '.join(dirty)}); tracked files restored"
         + (f"; remove these untracked files by hand: {', '.join(leftover)}" if leftover else "")
         + ". Rerun that verifier once.")


def cmd_report(goal, uid, outcome, *text):
    """A worker reports its own result. Its worktree goes away; only commits on its branch count."""
    if outcome not in ("produced", "escalated", "gave_up"):
        fail("report outcome is produced, escalated, or gave_up")
    note = " ".join(text)
    remove_worktree_for(f"unit/{goal}/{uid}")
    shutil.rmtree(worktree_path(goal, uid), ignore_errors=True)
    if outcome == "produced":
        cmd_produced(goal, uid, note)
    elif outcome == "escalated":
        move_unit(goal, uid, "stuck", f"question: {note}")
    else:
        revise(goal, uid, f"gave up: {note}")


def cmd_review(goal, subject, verdict, *reason):
    """A verifier records its verdict. It may not have changed anything else in the tree."""
    if verdict not in ("pass", "fail"):
        fail("review verdict is pass or fail")
    note = " ".join(reason)
    restore_after_verifier(goal)
    if subject == "whole":
        require(goal, "integrated")
        log(goal, goal, "whole-review" if verdict == "pass" else "whole-blocking", note)
        save(goal, f"whole review {verdict}")
        print(f"whole review: {verdict}")
        return
    if get_unit(load_units(goal), subject)["state"] != "produced" or unit_phase(entries(goal), subject) != "review":
        fail(f"{subject} isn't waiting for review; run `peek`")
    if verdict == "fail":
        revise(goal, subject, note or "verifier failed it without a reason")
        return
    log(goal, subject, "review-pass", note)
    save(goal, f"{subject} review pass")
    print(f"{subject}: review pass; it merges next")


def cmd_brief(goal, role, uid="-"):
    """The whole handoff for a subagent: identifiers and a role file, never a summary of the run."""
    if role not in ROLES:
        fail(f"role is one of {', '.join(ROLES)}")
    lines = [f"You are the zerg {role}. Read {SKILL_DIR / 'references' / (role + '.md')} and follow it exactly.",
             f"Goal: {goal}", f"Unit: {uid}", f"MAIN: {root()}", f"S: python3 {SCRIPT}"]
    if role == "worker":
        lines.append(f"WORKTREE: {worktree_path(goal, uid)}")
    print("\n".join(lines))


def cmd_summary(goal):
    """The approval brief, built from the files so the human sees exactly what will run."""
    text, units = contract_text(goal), load_units(goal)
    print(text.splitlines()[0])
    for name in ("Outcome", "Criteria", "Constraints", "Non-goals", "Decisions"):
        body = section(text, name).strip()
        if body:
            print(f"\n{name}:\n{body}")
    print("\nUnits:")
    for u in units:
        print(f"  {u['unit']}  {u['task']}  [scope: {u['scope']}]  [after: {u['after']}]  [{u['criteria']}]")
    problems = all_plan_problems(goal)
    print("\nLint: " + ("ok" if not problems else "; ".join(problems)))


def cmd_merge(goal, uid):
    on_swarm(goal)
    unit = get_unit(load_units(goal), uid)
    if unit["state"] != "produced" or unit_phase(entries(goal), uid) != "merge":
        fail(f"{uid} must be produced, checked, and passed by a verifier before it merges")
    restore_after_verifier(goal)
    save(goal, "before merge")
    if git("merge", "-q", "--no-ff", "--no-edit", f"unit/{goal}/{uid}", check=False).returncode:
        git("merge", "--abort", check=False)
        move_unit(goal, uid, "stuck", "merge conflict: the plan's scopes collide in practice")
        sys.exit(1)
    # Other units' tests are still red by design (fail-first), so the full suite waits for integrate.
    # Per merge: this unit's check and every merged unit's check must pass.
    guarded = [u for u in load_units(goal) if u["state"] == "merged" or u["unit"] == uid]
    broken = [u["unit"] for u in guarded if not run(u["check"], root())[0]]
    if broken:
        git("reset", "-q", "--hard", "HEAD~1")
        revise(goal, uid, f"after merge these checks fail: {', '.join(broken)}")
        sys.exit(1)
    move_unit(goal, uid, "merged", "checks green")


def cmd_revise(goal, uid, *note):
    revise(goal, uid, " ".join(note))


def cmd_move(goal, uid, target, *note):
    move_unit(goal, uid, target, " ".join(note))


def cmd_answer(goal, subject, *words):
    text = " ".join(words)
    path = goal_dir(goal) / "contract.md"
    path.write_text(path.read_text().rstrip() + f"\n- {subject}: {clean(text)}\n")
    if subject != "goal":
        unit = get_unit(load_units(goal), subject)
        if unit["state"] != "stuck":
            fail(f"{subject} is {unit['state']}, not stuck")
        update_unit(goal, subject, "answered", text, state="planned", revisions="0", note=f"answered: {text}")
    else:
        log(goal, goal, "answered", text)
    save(goal, f"decision for {subject}")
    print(f"recorded decision for {subject}")


def cmd_amend(goal, uid, *words):
    """Route an examiner finding into the unit's task before any worker sees the unit."""
    text = clean(" ".join(words))
    unit = get_unit(load_units(goal), uid)
    if unit["state"] != "planned":
        fail(f"{uid} is {unit['state']}; amend a task only before its unit is leased")
    update_unit(goal, uid, "amended", text, task=f"{unit['task']}. Also: {text}")
    save(goal, f"amend {uid}")
    print(f"{uid}: task amended")


def cmd_rescope(goal, uid, scope, *reason):
    """A human decision only: widen or change a stuck unit's scope. Open units still may not overlap."""
    units = load_units(goal)
    unit = get_unit(units, uid)
    if unit["state"] != "stuck":
        fail(f"{uid} is {unit['state']}; only a stuck unit is rescoped, after a human decides")
    others = [u for u in units if u["unit"] != uid and u["state"] not in CLOSED]
    clash = [u["unit"] for u in others if globs_overlap(split_list(scope), split_list(u["scope"]))]
    if clash:
        fail(f"new scope overlaps open units: {', '.join(clash)}")
    text = " ".join(reason) or "human decision"
    path = goal_dir(goal) / "contract.md"
    path.write_text(path.read_text().rstrip() + f"\n- {uid}: scope is now {clean(scope)}: {clean(text)}\n")
    update_unit(goal, uid, "rescoped", f"{scope}: {text}", scope=scope, state="planned", revisions="0",
                note=f"rescoped: {text}")
    save(goal, f"rescope {uid}")
    print(f"{uid}: scope {scope}; back to planned")


# --- commands: integrate to hand-off ---

def cmd_add_fix(goal, task, scope):
    require(goal, "integrated")
    units = load_units(goal)
    if any(u["unit"].startswith("F-") for u in units):
        fail("one fix unit per goal; a second blocking finding goes to the human")
    test = parse_header(contract_text(goal))["test"]
    fix = {**dict.fromkeys(COLUMNS, ""), "unit": "F-1", "task": task, "scope": scope, "after": "-",
           "criteria": "-", "check": test, "state": "planned", "revisions": "0"}
    save_units(goal, units + [fix])
    log(goal, "F-1", "added", task)
    log(goal, goal, "reopened", "fix unit F-1")
    save(goal, "fix unit F-1")
    print("added F-1; it runs through implement, check, review, then integrate again")


def cmd_integrate(goal):
    on_swarm(goal)
    units = load_units(goal)
    open_units = [u["unit"] for u in units if u["state"] not in CLOSED]
    if open_units:
        fail(f"units still open: {', '.join(open_units)}")
    if holdout_tracked(goal):
        fail("holdout tests are tracked by git")
    header = parse_header(contract_text(goal))
    suite_ok, output = run(header["test"], root())
    holdout = holdout_command(goal)
    holdout_ok = run(holdout, root())[0] if holdout else True
    print(json.dumps({"suite": "pass" if suite_ok else "fail", "suite_output": "" if suite_ok else output,
                      "holdout": "pass" if holdout_ok else "fail"}, indent=2))
    if not (suite_ok and holdout_ok):
        log(goal, goal, "integrate-failed", f"suite {suite_ok}, holdout {holdout_ok}")
        save(goal, "integration failed")
        sys.exit(1)
    log(goal, goal, "integrated")
    save(goal, "integrated")


def cmd_prove(goal, criterion, *command):
    require(goal, "integrated")
    on_swarm(goal)
    text = contract_text(goal)
    if criterion not in criteria(text):
        fail(f"no criterion {criterion}")
    command = " ".join(command)
    ok, output = run(command, root())
    print(output)
    if not ok:
        fail(f"{criterion}: evidence command failed, so it is not proven")
    log(goal, criterion, "proof", command)
    proven = {e["subject"] for e in entries(goal) if e["event"] == "proof"}
    if set(criteria(text)) <= proven:
        log(goal, goal, "proved")
    save(goal, f"proof for {criterion}")


def zerg_home():
    """The user layer. It lives outside the plugin, so what a user's swarm learns survives every upgrade."""
    return Path(os.environ.get("ZERG_HOME", Path.home() / ".zerg"))


def inbox_path():
    return zerg_home() / "inbox.md"


def user_bounds():
    path = zerg_home() / "config"
    values = {}
    for line in path.read_text().splitlines() if path.exists() else []:
        key, sep, value = line.partition(":")
        if sep and key.strip() in BOUNDS and value.strip().isdigit():
            values[key.strip()] = int(value.strip())
    return {**BOUNDS, **values}


def append_block(path, heading, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text() if path.exists() else f"# {path.stem}\n"
    path.write_text(existing.rstrip() + f"\n\n## {heading}\n\n{body}\n")


def route_learnings(goal):
    """Project lessons go to the project, zerg lessons go to zerg's inbox. Nothing is applied."""
    lanes = split_lanes(require_file(goal, "learn.md").read_text())
    if "## zerg" not in (goal_dir(goal) / "learn.md").read_text() or "## project" not in (goal_dir(goal) / "learn.md").read_text():
        fail("learn.md needs a `## zerg` and a `## project` section (write `none` under an empty one)")
    stamp = f"{goal} ({time.strftime('%Y-%m-%d')})"
    routed = []
    if lanes["project"]:
        append_block(root() / ".swarm" / "LEARNINGS.md", stamp, lanes["project"])
        git("add", "--", ".swarm/LEARNINGS.md")
        routed.append("project -> .swarm/LEARNINGS.md")
    if lanes["zerg"]:
        append_block(inbox_path(), f"{root().name} {stamp}", lanes["zerg"])
        routed.append(f"zerg -> {inbox_path()}")
    return routed


def cmd_stage(goal, event, *note):
    needs = {"whole-review": "integrated", "learned": "proved", "finding": "approved"}
    if event not in needs:
        fail(f"stage is one of {', '.join(needs)}")
    require(goal, needs[event])
    if event == "learned":
        routed = route_learnings(goal)
        note = (*note, "; ".join(routed) or "no proposals")
        print("\n".join(routed) or "no proposals to route")
    log(goal, goal, event, " ".join(note))
    save(goal, event)
    print(f"{goal}: {event}")


def cmd_tokens(goal, who, stage, count):
    if not count.isdigit():
        fail("tokens must be a whole number")
    log(goal, who, "tokens", f"{stage} {count}")
    save(goal, f"tokens {who}")


def token_lines(rows):
    by_stage = {}
    for e in rows:
        if e["event"] == "tokens":
            stage, count = e["note"].rsplit(" ", 1)
            by_stage[stage] = by_stage.get(stage, 0) + int(count)
    return [f"  {stage}: {count:,}" for stage, count in sorted(by_stage.items())] + [f"  total: {token_total(rows):,}"]


def cmd_status(goal):
    print(plan_path(goal).read_text().split("\n|", 1)[0].strip())
    print(render_table(load_units(goal)))
    rows = entries(goal)
    print("events:", ", ".join(sorted(goal_events(rows) - {"pass", "tokens"})))
    print("tokens:\n" + "\n".join(token_lines(rows)))


def remove_unit_worktrees(goal):
    """Worker worktrees outlive their agents when they hold commits; the branches keep the work."""
    blocks = out("worktree", "list", "--porcelain").split("\n\n")
    for block in blocks:
        lines = dict(line.split(" ", 1) for line in block.splitlines() if " " in line)
        if lines.get("branch", "").startswith(f"refs/heads/unit/{goal}/"):
            git("worktree", "remove", "--force", lines["worktree"], check=False)
            print(f"removed worktree {lines['worktree']}")


def cmd_handoff(goal):
    require(goal, "learned")
    text, rows, units = contract_text(goal), entries(goal), load_units(goal)
    base = parse_header(text)["base"]
    proofs = {e["subject"]: e["note"] for e in rows if e["event"] == "proof"}
    print(f"branch: swarm/{goal} (base {base})\n")
    print(out("diff", "--stat", f"{base}...swarm/{goal}") + "\n")
    print("criteria:\n" + "\n".join(f"  {c}: {proofs.get(c, 'UNPROVEN')}" for c in criteria(text)))
    findings = [f"  {e['note']}" for e in rows if e["event"] == "finding"]
    print("findings:\n" + ("\n".join(findings) or "  none"))
    print("units:\n" + "\n".join(f"  {u['unit']}: {u['state']}, {u['revisions']} revisions" for u in units))
    print("tokens:\n" + "\n".join(token_lines(rows)))
    print(f"learn: .swarm/{goal}/learn.md")
    print(f"note: the merge also adds these .gitignore lines: {', '.join(IGNORES)}")
    log(goal, goal, "handed-off")
    save(goal, "handed off")
    remove_unit_worktrees(goal)
    git("checkout", "-q", base)
    print(f"\nchecked out {base}. Review, then merge swarm/{goal} yourself.")


LOCK_FREE = {"peek", "status", "summary", "brief", "lint"}
USER_COMMANDS = {"home": cmd_home, "inbox": cmd_inbox, "accept": cmd_accept, "dismiss": cmd_dismiss,
                 "config": cmd_config}
COMMANDS = {
    "new": cmd_new, "lint": cmd_lint, "approve": cmd_approve, "define": cmd_define, "baseline": cmd_baseline,
    "next": cmd_next, "peek": cmd_peek, "report": cmd_report, "review": cmd_review, "brief": cmd_brief,
    "summary": cmd_summary, "lease": cmd_lease, "produced": cmd_produced, "check": cmd_check, "merge": cmd_merge,
    "revise": cmd_revise, "move": cmd_move, "answer": cmd_answer, "rescope": cmd_rescope, "amend": cmd_amend, "add-fix": cmd_add_fix,
    "integrate": cmd_integrate, "prove": cmd_prove, "stage": cmd_stage, "tokens": cmd_tokens,
    "status": cmd_status, "handoff": cmd_handoff,
}

if __name__ == "__main__":
    command, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if command in USER_COMMANDS:
        USER_COMMANDS[command](*args)
    elif command in COMMANDS and args and command in LOCK_FREE:
        COMMANDS[command](*args)
    elif command in COMMANDS and args:
        with state_lock():
            COMMANDS[command](*args)
    else:
        fail(__doc__)
