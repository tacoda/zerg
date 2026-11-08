#!/usr/bin/env node
// @ts-check
/**
 * zerg control plane: the deterministic half of the zerg skill. State, gates, bounds, and checks.
 *
 * State lives in .swarm/<goal>/ (contract.md, plan.md, log.md) and is committed on swarm/<goal>
 * by every command that changes it, so worker worktrees always branch from current state.
 *
 * No dependencies, Node 18+. Every state change takes .swarm/.lock, so parallel agents can call it safely.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `zerg control plane

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
  stage <goal> whole-review|learned|finding [note]   \`learned\` routes learn.md: project lane to
                                      .swarm/LEARNINGS.md, zerg lane to $ZERG_HOME/inbox.md
  tokens <goal> <who> <stage> <n>     record a dispatch's token use
  status <goal>                       unit table, goal events, token totals
  handoff <goal>                      final report, then check out base

User layer, in $ZERG_HOME (default ~/.zerg), outside the skill so it survives updates:
  home                                paths and the bounds in effect
  inbox                               pending zerg proposals routed by \`stage learned\`
  accept <id> [note]                  move a proposal into rules.md, which every goal reads
  dismiss <id> [reason]               archive a proposal without using it
  config <key> <n>                    override max_revisions, max_passes, or no_progress`;

const SCRIPT = fs.realpathSync(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(path.dirname(SCRIPT));
const TEMPLATES = path.join(SKILL_DIR, "assets");
export const IGNORES = [".swarm/*/holdout/", ".swarm/.tmp/", ".swarm/.work/", ".swarm/.lock", ".swarm/STOP", ".claude/worktrees/"];
// Worker worktrees live here; they are never a verifier's writes.
const NOT_TREE = [".claude/worktrees/", ".swarm/.tmp/", ".swarm/.work/", ".swarm/.lock"];
const ROLES = ["examiner", "worker", "verifier"];
export const COLUMNS = ["unit", "task", "scope", "after", "criteria", "check", "state", "revisions", "note"];
const SECTIONS = ["Outcome", "Why", "Non-goals", "Constraints", "Criteria", "Escalate when"];
/** @type {Record<string, string[]>} */
const TRANSITIONS = {
  planned: ["leased", "dropped", "stuck"],
  leased: ["produced", "stuck", "planned"],
  produced: ["merged", "planned", "stuck"],
  stuck: ["planned", "dropped"],
  merged: [],
  dropped: [],
};
const CLOSED = ["merged", "dropped"];
// Defaults. A user's ~/.zerg/config (or $ZERG_HOME/config) overrides them without a skill update.
export const BOUNDS = { max_revisions: 2, max_passes: 20, no_progress: 3 };
// A clean unit still takes about 4 passes (implement, check, review, merge), so the cap grows with the plan.
export const PASSES_PER_UNIT = 5;

/** @typedef {{unit: string, task: string, scope: string, after: string, criteria: string, check: string, state: string, revisions: string, note: string}} Unit */
/** @typedef {{ts?: string, subject: string, event: string, note: string}} Entry */

/** Thrown instead of process.exit, so `finally` blocks (the state lock) still run. */
class Exit extends Error {
  /** @param {number} code @param {string} [message] */
  constructor(code, message = "") {
    super(message);
    this.code = code;
  }
}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Exit(1, message);
}

/** @param {number} code @returns {never} */
function exit(code) {
  throw new Exit(code);
}

// --- pure helpers (covered by swarm.test.mjs) ---

/** @param {string} text */
export const lines = (text) => {
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === "") all.pop();
  return all;
};

/** @param {string} text @param {string} sep @returns {[string, string, string]} */
const partition = (text, sep) => {
  const i = text.indexOf(sep);
  return i < 0 ? [text, "", ""] : [text.slice(0, i), sep, text.slice(i + sep.length)];
};

/** Python's fnmatch: `*` matches anything (slashes too), `?` one character, `[...]` a set. */
export function fnmatch(name, pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = "^" + set.slice(1);
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/-]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

/** @param {unknown} value */
export const clean = (value) => String(value).replace(/\|/g, "/").split(/\s+/).filter(Boolean).join(" ");

/** @param {string} cell */
export const splitList = (cell) => cell.split(",").map((s) => s.trim()).filter((s) => s !== "" && s !== "-");

/** @param {string} text @returns {Unit[]} */
export function parseTable(text) {
  return lines(text).filter((l) => l.startsWith("|")).slice(2).map((line) => {
    const cells = line.trim().replace(/^\|+|\|+$/g, "").split("|").map((c) => c.trim());
    /** @type {any} */
    const unit = Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i] ?? ""]));
    return unit;
  });
}

/** @param {Unit[]} units */
export function renderTable(units) {
  const head = "| " + COLUMNS.join(" | ") + " |";
  const rule = "|" + "---|".repeat(COLUMNS.length);
  const body = units.map((u) => "| " + COLUMNS.map((c) => clean(/** @type {any} */ (u)[c] ?? "")).join(" | ") + " |");
  return [head, rule, ...body].join("\n");
}

/** @param {string} text @param {Unit[]} units */
export function replaceTable(text, units) {
  const all = lines(text);
  const rows = all.map((l, i) => (l.startsWith("|") ? i : -1)).filter((i) => i >= 0);
  if (!rows.length) return text.trimEnd() + "\n\n" + renderTable(units) + "\n";
  return [...all.slice(0, rows[0]), ...renderTable(units).split("\n"), ...all.slice(rows[rows.length - 1] + 1)].join("\n") + "\n";
}

/** @param {string} text @returns {Record<string, string>} */
export function parseHeader(text) {
  const head = partition(text, "\n## ")[0];
  /** @type {Record<string, string>} */
  const data = {};
  for (const line of lines(head)) {
    const [key, sep, value] = partition(line, ":");
    if (sep && !/^[# -]/.test(line)) data[key.trim()] = value.trim();
  }
  return data;
}

/** @param {string} text @param {string} key @param {string} value */
export function setHeader(text, key, value) {
  const [head, sep, rest] = partition(text, "\n## ");
  const all = lines(head);
  const at = all.findIndex((l) => partition(l, ":")[0].trim() === key && !l.startsWith("#"));
  if (at >= 0) all[at] = `${key}: ${value}`;
  else all.splice(all.length > 1 ? 2 : all.length, 0, `${key}: ${value}`);
  return all.join("\n") + sep + rest;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {string} text @param {string} name */
export function section(text, name) {
  const m = new RegExp(`^## ${escapeRe(name)}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
  return m ? m[1] : "";
}

/** @param {string} text */
export const criteria = (text) => [...section(text, "Criteria").matchAll(/^- (C\d+):/gm)].map((m) => m[1]);

/** (criterion, command) for every backticked `grep ...` in the Criteria section. @param {string} text */
export function grepCriteria(text) {
  /** @type {[string, string][]} */
  const pairs = [];
  for (const [, cid, body] of section(text, "Criteria").matchAll(/^- (C\d+):(.*)$/gm)) {
    for (const [, cmd] of body.matchAll(/`(grep [^`]+)`/g)) pairs.push([cid, cmd]);
  }
  return pairs;
}

/** @param {string} output */
export const grepHitFiles = (output) =>
  [...new Set(lines(output).filter((l) => l.trim()).map((l) => partition(l, ":")[0]))].sort();

/** Every file a grep criterion hits must sit in the scope of a unit that serves that criterion. */
export function grepProblems(cid, files, units) {
  const globs = units.filter((u) => splitList(u.criteria).includes(cid)).flatMap((u) => splitList(u.scope));
  return files.filter((f) => !globs.some((g) => fnmatch(f, g)))
    .map((f) => `${cid}: its grep hits ${f}, which no unit serving ${cid} has in scope`);
}

/** Units with an examiner finding not yet routed into their task by `amend`. @param {Entry[]} rows */
export function openFindings(rows) {
  const open = new Set();
  for (const e of rows) {
    if (e.event === "examiner-finding") open.add(e.subject);
    else if (e.event === "amended") open.delete(e.subject);
  }
  return [...open].sort();
}

/** learn.md has a `## zerg` and a `## project` section; each body, or '' when it holds no proposal. */
export function splitLanes(text) {
  /** @type {Record<string, string>} */
  const lanes = {};
  for (const lane of ["zerg", "project"]) {
    const body = section(text, lane).trim();
    lanes[lane] = !body || ["none", "no proposals"].includes(body.toLowerCase().replace(/\.+$/, "")) ? "" : body;
  }
  return lanes;
}

/** Pending zerg proposals; id = '<source first word>/<goal>/<Pn>'. @param {string} text */
export function parseInbox(text) {
  const proposals = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const [source, , rest] = partition(block, "\n");
    const words = source.split(/\s+/).filter(Boolean);
    for (const item of rest.split(/^### /m).slice(1)) {
      const [title, , body] = partition(item, "\n");
      const number = partition(title, ".")[0].trim();
      proposals.push({ id: [...words.slice(0, 2), number].join("/"), source: source.trim(), title: title.trim(), body: body.trim() });
    }
  }
  return proposals;
}

/** @param {{source: string, title: string, body: string}[]} proposals */
export function renderInbox(proposals) {
  const out = ["# inbox"];
  for (const source of [...new Set(proposals.map((p) => p.source))]) {
    out.push("", `## ${source}`);
    for (const p of proposals.filter((p) => p.source === source)) out.push("", `### ${p.title}`, p.body);
  }
  return out.join("\n") + "\n";
}

/** @param {string[]} left @param {string[]} right */
export const globsOverlap = (left, right) => left.some((a) => right.some((b) => fnmatch(a, b) || fnmatch(b, a)));

/** @param {Unit[]} units */
export function mergeOrder(units) {
  const order = [];
  const placed = new Set();
  while (order.length < units.length) {
    const batch = units.filter((u) => !placed.has(u.unit) && splitList(u.after).every((d) => placed.has(d))).map((u) => u.unit);
    if (!batch.length) throw new Error("cycle");
    order.push(...batch);
    batch.forEach((b) => placed.add(b));
  }
  return order;
}

/** @param {Unit} unit @param {string[]} ids @param {string[]} crits */
function rowProblems(unit, ids, crits) {
  const uid = unit.unit;
  return [
    ...(splitList(unit.scope).length ? [] : [`${uid}: empty scope`]),
    ...splitList(unit.after).filter((d) => !ids.includes(d)).map((d) => `${uid}: unknown after ${d}`),
    ...splitList(unit.criteria).filter((c) => !crits.includes(c)).map((c) => `${uid}: unknown criterion ${c}`),
  ];
}

/** @param {Unit[]} units @param {string[]} crits */
function planProblems(units, crits) {
  const ids = units.map((u) => u.unit);
  const problems = units.length ? [] : ["plan: no units"];
  problems.push(...[...new Set(ids.filter((i) => ids.indexOf(i) !== ids.lastIndexOf(i)))].sort().map((i) => `plan: duplicate unit ${i}`));
  units.forEach((u) => problems.push(...rowProblems(u, ids, crits)));
  const covered = new Set(units.flatMap((u) => splitList(u.criteria)));
  problems.push(...crits.filter((c) => !covered.has(c)).map((c) => `plan: criterion ${c} has no unit`));
  units.forEach((a, i) => units.slice(i + 1).forEach((b) => {
    if (globsOverlap(splitList(a.scope), splitList(b.scope))) problems.push(`plan: scopes overlap: ${a.unit} and ${b.unit}`);
  }));
  try {
    mergeOrder(units.filter((u) => splitList(u.after).every((d) => ids.includes(d))));
  } catch {
    problems.push("plan: after has a cycle");
  }
  return problems;
}

/** @param {string} text @param {Unit[]} units */
export function lintProblems(text, units) {
  const header = parseHeader(text);
  const problems = SECTIONS.filter((s) => !section(text, s).trim()).map((s) => `contract: empty section ## ${s}`);
  problems.push(...["base", "test"].filter((k) => !header[k]).map((k) => `contract: missing header ${k}`));
  problems.push(...Object.entries(header).filter(([, v]) => v.startsWith("<") && v.endsWith(">"))
    .map(([k]) => `contract: header ${k} is still a placeholder`));
  const crits = criteria(text);
  if (!crits.length) problems.push("contract: no criteria like '- C1: ...'");
  return [...problems, ...planProblems(units, crits)];
}

/** @param {string} current @param {string} target */
export const checkTransition = (current, target) =>
  (TRANSITIONS[current] ?? []).includes(target) ? null : `illegal transition: ${current} -> ${target}`;

/** Two strikes: a third failure, or the same failure word for word, makes the unit stuck. @param {Unit} unit */
export function reviseUnit(unit, note, maxRevisions = BOUNDS.max_revisions) {
  const text = clean(note);
  const revisions = (parseInt(unit.revisions, 10) || 0) + 1;
  const stuck = revisions > maxRevisions || text === unit.note;
  return { ...unit, revisions: String(revisions), state: stuck ? "stuck" : "planned", note: text };
}

/** @param {Unit[]} units */
export function blockedUnits(units) {
  const byId = new Map(units.map((u) => [u.unit, u]));
  return units.filter((u) => u.state === "planned" &&
    splitList(u.after).some((d) => byId.has(d) && ["dropped", "stuck"].includes(byId.get(d).state))).map((u) => u.unit);
}

/** @param {Unit[]} units @param {number} maxParallel */
export function readyUnits(units, maxParallel) {
  const byId = new Map(units.map((u) => [u.unit, u]));
  const busy = units.filter((u) => ["leased", "produced"].includes(u.state)).length;
  const ready = units.filter((u) => u.state === "planned" &&
    splitList(u.after).every((d) => !byId.has(d) || byId.get(d).state === "merged")).map((u) => u.unit);
  return ready.slice(0, Math.max(0, maxParallel - busy));
}

/** Goal-level events that still hold. A fix unit reopens integration. @param {{event: string}[]} entries */
export function goalEvents(entries) {
  const events = new Set();
  for (const e of entries) {
    if (e.event === "reopened") ["integrated", "proved", "whole-blocking"].forEach((x) => events.delete(x));
    events.add(e.event);
  }
  return events;
}

/** @param {{event: string, note: string}[]} entries */
export const tokenTotal = (entries) =>
  entries.filter((e) => e.event === "tokens").reduce((sum, e) => sum + parseInt(e.note.split(/\s+/).pop() ?? "0", 10), 0);

/** @param {{event: string, note: string}[]} entries */
export function boundHit(entries, budget, bounds = BOUNDS, current = null, unitCount = 0) {
  const passes = entries.filter((e) => e.event === "pass");
  const cap = bounds.max_passes + PASSES_PER_UNIT * unitCount;
  if (passes.length >= cap) return `iteration cap: ${passes.length} passes (cap ${cap} for ${unitCount} units)`;
  const window = bounds.no_progress;
  const notes = passes.map((p) => p.note);
  const recent = (current !== null ? [...notes, current] : notes).slice(-window);
  if (recent.length === window && new Set(recent).size === 1) return `no progress: ${window} passes with the same state`;
  const spent = tokenTotal(entries);
  if (budget && spent >= budget) return `token budget spent: ${spent} of ${budget}`;
  return null;
}

/** @param {Unit[]} units @param {string} state */
const idsIn = (units, state) => units.filter((u) => u.state === state).map((u) => u.unit);

/** Rows 0 to 5: gates before any unit work. */
function deriveOpen(s) {
  if (s.stop) return [0, "stop", ".swarm/STOP is present"];
  if (s.bound) return [1, "stop", s.bound];
  if (!s.has_contract) return [2, "scope", "run `new`, write contract.md and plan.md, then `lint`"];
  if (!s.events.has("approved")) {
    if (s.lint.length) return [2, "plan", s.lint.join("; ")];
    return [3, "approve", "show `summary`; ask the human; then `approve`"];
  }
  if (!s.events.has("defined") || s.units.some((u) => !u.check && !CLOSED.includes(u.state))) {
    return [4, "define", "run the examiner: `brief <goal> examiner`; it records its checks with `define`"];
  }
  if (s.open_findings?.length) return [4, "amend", s.open_findings.join(" ")];
  if (!s.events.has("baseline")) {
    return [5, "baseline", "run `baseline`; rerun the examiner with `Strengthen:` for any unit whose check passes"];
  }
  return null;
}

/** For a produced unit: what it needs next, from its log since it was last produced. @param {Entry[]} rows */
export function unitPhase(rows, uid) {
  const events = rows.filter((e) => e.subject === uid).map((e) => e.event);
  const start = Math.max(0, events.lastIndexOf("produced"));
  const since = events.slice(start);
  return since.includes("review-pass") ? "merge" : since.includes("check-ok") ? "review" : "check";
}

/** Rows 6 to 9: the implement, check, review, merge loop. */
function deriveUnits(s) {
  const produced = idsIn(s.units, "produced");
  for (const phase of ["check", "review", "merge"]) {
    const due = produced.filter((uid) => s.phases[uid] === phase);
    if (due.length) return [6, phase, due.join(" ")];
  }
  const leased = idsIn(s.units, "leased");
  if (leased.length) return [7, "orphans", leased.join(" ")];
  const ready = readyUnits(s.units, s.max_parallel);
  if (ready.length) return [8, "implement", ready.join(" ")];
  const stuck = [...idsIn(s.units, "stuck"), ...blockedUnits(s.units)];
  if (stuck.length) return [9, s.autonomy === "auto" ? "auto-drop" : "interrupt", stuck.join(" ")];
  return null;
}

/** Rows 10 to 15: integration to hand-off. */
function deriveClose(s) {
  const ev = s.events;
  if (!ev.has("integrated")) return [10, "integrate", "run `integrate`"];
  if (!ev.has("whole-review")) {
    if (ev.has("whole-blocking")) {
      if (s.fix_exists) return [9, "interrupt", "goal: a second blocking whole-review finding; ask the human"];
      return [11, "add-fix", "run `add-fix` for the blocking finding in the log"];
    }
    return [11, "whole-review", "dispatch a verifier with `brief <goal> verifier whole`"];
  }
  if (s.unproven.length) return [12, "prove", s.unproven.join(" ")];
  if (!ev.has("learned")) return [13, "learn", "write learn.md, then `stage learned`"];
  if (!ev.has("handed-off")) return [14, "handoff", "run `handoff`"];
  return [15, "done", "nothing left to do"];
}

/** The derive table: first match wins. @returns {[number, string, string]} */
export const derive = (s) => deriveOpen(s) ?? deriveUnits(s) ?? deriveClose(s);

/** Changes whenever anything but a pass or a token count is logged, so every check, review, or answer is progress. */
export function fingerprint(units, rows) {
  const work = rows.filter((e) => e.event !== "pass" && e.event !== "tokens").length;
  return clean(units.map((u) => `${u.unit}:${u.state}:${u.revisions}`).join(",") + ` work:${work}`);
}

/** @param {string[]} changed @param {string[]} globs */
export const scopeViolations = (changed, globs) => changed.filter((p) => !globs.some((g) => fnmatch(p, g)));

// --- I/O ---

const say = (/** @type {string} */ text) => console.log(text);
const exists = (/** @type {string} */ p) => fs.existsSync(p);
const read = (/** @type {string} */ p) => fs.readFileSync(p, "utf8");
const write = (/** @type {string} */ p, /** @type {string} */ text) => fs.writeFileSync(p, text);
const rmrf = (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true });
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
function stamp(withTime = true) {
  const d = new Date();
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${day}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : day;
}
const json = (value) => JSON.stringify(value, null, 2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** @param {string[]} args @param {{cwd?: string, check?: boolean}} [options] */
function git(args, { cwd, check = true } = {}) {
  const proc = spawnSync("git", args, { cwd: cwd ?? root(), encoding: "utf8" });
  if (check && proc.status !== 0) fail(`git ${args.join(" ")}: ${(proc.stderr ?? "").trim()}`);
  return { code: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

const out = (/** @type {string[]} */ args, cwd = undefined) => git(args, { cwd }).stdout.trim();

let cachedRoot = "";
function root() {
  if (cachedRoot) return cachedRoot;
  const proc = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (proc.status !== 0) fail("not inside a git repository");
  cachedRoot = path.dirname(proc.stdout.trim());
  return cachedRoot;
}

/** Runs a project command through the shell. @returns {[boolean, string]} */
function run(command, cwd) {
  const proc = spawnSync(command, { shell: true, cwd, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  return [proc.status === 0, ((proc.stdout ?? "") + (proc.stderr ?? "")).slice(-3000)];
}

const lastLine = (/** @type {string} */ text) => lines(text.trim()).pop() ?? "";
const goalDir = (/** @type {string} */ goal) => path.join(root(), ".swarm", goal);

function requireFile(goal, name) {
  const file = path.join(goalDir(goal), name);
  if (!exists(file)) {
    const onBranch = git(["rev-parse", "--verify", "--quiet", `swarm/${goal}`], { check: false }).code === 0;
    fail(onBranch ? `${goal}: state lives on swarm/${goal}; check it out first` : `no goal ${goal}`);
  }
  return file;
}

const contractText = (goal) => read(requireFile(goal, "contract.md"));
const planPath = (goal) => requireFile(goal, "plan.md");
/** @returns {Unit[]} */
const loadUnits = (goal) => parseTable(read(planPath(goal)));
const saveUnits = (goal, units) => write(planPath(goal), replaceTable(read(planPath(goal)), units));

/** @param {Unit[]} units @param {string} uid @returns {Unit} */
function getUnit(units, uid) {
  return units.find((u) => u.unit === uid) ?? fail(`no unit ${uid}`);
}

const putUnit = (units, next) => units.map((u) => (u.unit === next.unit ? next : u));

/** @returns {Entry[]} */
function entries(goal) {
  const file = path.join(goalDir(goal), "log.md");
  if (!exists(file)) return [];
  return lines(read(file)).map((line) => line.replace(/^[- ]+/, "").split("|").map((p) => p.trim()))
    .filter((parts) => parts.length >= 4)
    .map((parts) => ({ ts: parts[0], subject: parts[1], event: parts[2], note: parts.slice(3).join(" | ") }));
}

function log(goal, subject, event, note = "") {
  fs.appendFileSync(path.join(goalDir(goal), "log.md"), `- ${stamp()} | ${subject} | ${event} | ${clean(note)}\n`);
}

const branch = () => out(["branch", "--show-current"]);

function onSwarm(goal) {
  if (branch() !== `swarm/${goal}`) fail(`check out swarm/${goal} first (on ${branch() || "detached HEAD"})`);
}

function save(goal, message) {
  if (branch() !== `swarm/${goal}`) return;
  git(["add", "--", `.swarm/${goal}`]);
  if (git(["diff", "--cached", "--quiet"], { check: false }).code !== 0) git(["commit", "-q", "-m", `swarm ${goal}: ${message}`]);
}

function require(goal, event) {
  if (!goalEvents(entries(goal)).has(event)) fail(`${goal}: \`${event}\` hasn't happened yet`);
}

/** Kept in the gitignored holdout dir, so no worktree and no worker ever sees it. */
function holdoutCommand(goal) {
  const file = path.join(goalDir(goal), "holdout", "command");
  return exists(file) ? read(file).trim() : "";
}

const stopped = () => exists(path.join(root(), ".swarm", "STOP"));

function budget(goal) {
  const value = parseHeader(contractText(goal)).token_budget ?? "";
  return /^\d+$/.test(value) ? parseInt(value, 10) : 0;
}

function dirtyPaths() {
  return lines(git(["status", "--porcelain", "--untracked-files=all"]).stdout)
    .filter((l) => l.trim()).map((l) => l.slice(3)).filter((p) => !NOT_TREE.some((n) => p.startsWith(n)));
}

const holdoutTracked = (goal) => Boolean(out(["ls-files", `.swarm/${goal}/holdout`]));

function updateUnit(goal, uid, event, logNote = "", fields = {}) {
  const units = loadUnits(goal);
  const unit = { ...getUnit(units, uid), ...fields };
  saveUnits(goal, putUnit(units, unit));
  log(goal, uid, event, logNote);
  return unit;
}

function moveUnit(goal, uid, target, note = "") {
  const unit = getUnit(loadUnits(goal), uid);
  const error = checkTransition(unit.state, target);
  if (error) fail(`${uid}: ${error}`);
  updateUnit(goal, uid, target, note, { state: target, note: clean(note) || unit.note });
  save(goal, `${uid} ${target}`);
  say(`${uid}: ${unit.state} -> ${target}`);
}

function revise(goal, uid, note) {
  const units = loadUnits(goal);
  const current = getUnit(units, uid);
  if (!["leased", "produced"].includes(current.state)) fail(`${uid} is ${current.state}; only leased or produced units are revised`);
  const unit = reviseUnit(current, note, userBounds().max_revisions);
  saveUnits(goal, putUnit(units, unit));
  log(goal, uid, unit.state === "planned" ? "revise" : "stuck", note);
  save(goal, `${uid} ${unit.state}`);
  say(`${uid}: revision ${unit.revisions} -> ${unit.state}: ${unit.note}`);
}

/** One state writer at a time, so parallel agents calling the script can't lose each other's updates. */
function withStateLock(fn) {
  const lock = path.join(root(), ".swarm", ".lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 900_000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (/** @type {any} */ (error).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 1_800_000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) fail("another zerg command has held .swarm/.lock for 15 minutes");
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

const worktreePath = (goal, uid) => path.join(root(), ".swarm", ".work", goal, uid);

/** @returns {Record<string, string>[]} */
function worktrees() {
  return out(["worktree", "list", "--porcelain"]).split("\n\n").map((block) =>
    Object.fromEntries(lines(block).filter((l) => l.includes(" ")).map((l) => partition(l, " ")).map(([k, , v]) => [k, v])));
}

function removeWorktreeFor(ref) {
  for (const tree of worktrees()) {
    if (tree.branch === `refs/heads/${ref}`) git(["worktree", "remove", "--force", tree.worktree], { check: false });
  }
}

function makeWorktree(goal, uid) {
  const ref = `unit/${goal}/${uid}`;
  const dir = worktreePath(goal, uid);
  removeWorktreeFor(ref);
  rmrf(dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(["worktree", "add", "-q", "-B", ref, dir, `swarm/${goal}`]);
  return dir;
}

function ensureIgnores() {
  const file = path.join(root(), ".gitignore");
  const have = exists(file) ? lines(read(file)) : [];
  write(file, [...have, ...IGNORES.filter((i) => !have.includes(i))].join("\n") + "\n");
}

// --- the user layer (no goal, no repo needed) ---

/** The user layer. It lives outside the skill, so what a user's swarm learns survives every update. */
const zergHome = () => process.env.ZERG_HOME || path.join(os.homedir(), ".zerg");
const inboxPath = () => path.join(zergHome(), "inbox.md");

export function userBounds() {
  const file = path.join(zergHome(), "config");
  const values = {};
  for (const line of exists(file) ? lines(read(file)) : []) {
    const [key, sep, value] = partition(line, ":");
    if (sep && key.trim() in BOUNDS && /^\d+$/.test(value.trim())) values[key.trim()] = parseInt(value.trim(), 10);
  }
  return { ...BOUNDS, ...values };
}

function appendBlock(file, heading, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = exists(file) ? read(file) : `# ${path.parse(file).name}\n`;
  write(file, existing.trimEnd() + `\n\n## ${heading}\n\n${body}\n`);
}

function takeFromInbox(pid) {
  const proposals = parseInbox(exists(inboxPath()) ? read(inboxPath()) : "");
  const match = proposals.find((p) => p.id === pid) ?? fail(`no pending proposal ${pid}; run \`inbox\``);
  write(inboxPath(), renderInbox(proposals.filter((p) => p.id !== pid)));
  return match;
}

function archive(proposal, status, note) {
  appendBlock(path.join(zergHome(), "archive.md"), `${proposal.id}: ${status} ${stamp(false)}`,
    `### ${proposal.title}\n${proposal.body}\n\n${clean(note) || "no note"}`);
}

function cmdHome() {
  say(`home:   ${zergHome()}`);
  for (const name of ["rules.md", "inbox.md", "archive.md", "config"]) {
    const file = path.join(zergHome(), name);
    say(`${(name + ":").padEnd(8)}${file}${exists(file) ? "" : "  (none yet)"}`);
  }
  say("bounds: " + Object.entries(userBounds()).map(([k, v]) => `${k}=${v}`).join(", "));
}

function cmdInbox() {
  const proposals = parseInbox(exists(inboxPath()) ? read(inboxPath()) : "");
  say(proposals.map((p) => `${p.id}  ${p.title}`).join("\n") || "inbox is empty");
}

/** Accepted zerg lessons become user rules, which the skill and every role read on each goal. */
function cmdAccept(pid, ...note) {
  const proposal = takeFromInbox(pid);
  const rules = path.join(zergHome(), "rules.md");
  appendBlock(rules, proposal.title, `${proposal.body}\n\n_from ${proposal.source}; accepted ${stamp(false)}_`);
  archive(proposal, "accepted", note.join(" "));
  say(`${pid}: added to ${rules}`);
}

function cmdDismiss(pid, ...reason) {
  archive(takeFromInbox(pid), "dismissed", reason.join(" "));
  say(`${pid}: dismissed`);
}

function cmdConfig(key, value = "") {
  if (!(key in BOUNDS) || !/^\d+$/.test(value) || parseInt(value, 10) < 1) {
    fail(`config takes one of ${Object.keys(BOUNDS).join(", ")} and a whole number of 1 or more`);
  }
  const file = path.join(zergHome(), "config");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kept = (exists(file) ? lines(read(file)) : []).filter((l) => partition(l, ":")[0].trim() !== key);
  write(file, [...kept, `${key}: ${value}`].join("\n") + "\n");
  say(`${key} = ${value} in ${file}`);
}

// --- plan and approve ---

function cmdNew(goal) {
  const dir = goalDir(goal);
  if (exists(dir)) fail(`${goal} already exists`);
  fs.mkdirSync(path.join(dir, "holdout"), { recursive: true });
  const contract = read(path.join(TEMPLATES, "contract.md")).replaceAll("<goal>", goal);
  write(path.join(dir, "contract.md"), setHeader(contract, "base", branch()));
  write(path.join(dir, "plan.md"), read(path.join(TEMPLATES, "plan.md")).replaceAll("<goal>", goal));
  ensureIgnores();
  log(goal, goal, "created");
  say(`created .swarm/${goal}: fill contract.md and plan.md, then run lint`);
}

function runGrepCriteria(text, units) {
  return grepCriteria(text).flatMap(([cid, command]) => grepProblems(cid, grepHitFiles(run(command, root())[1]), units));
}

function allPlanProblems(goal) {
  const text = contractText(goal);
  const units = loadUnits(goal);
  return [...lintProblems(text, units), ...runGrepCriteria(text, units)];
}

function cmdLint(goal) {
  const problems = allPlanProblems(goal);
  say(problems.join("\n") || `${goal}: plan ok`);
  if (problems.length) exit(1);
}

function cmdApprove(goal, autonomy = "ask") {
  if (!["ask", "auto"].includes(autonomy)) fail("autonomy is ask or auto");
  const text = contractText(goal);
  const header = parseHeader(text);
  const problems = allPlanProblems(goal);
  if (problems.length) fail("plan fails lint:\n" + problems.join("\n"));
  if (branch() !== header.base) fail(`approve from ${header.base}, not ${branch()}`);
  const foreign = dirtyPaths().filter((p) => !p.startsWith(`.swarm/${goal}/`) && !p.startsWith(".gitignore"));
  if (foreign.length) fail("tree not clean: " + foreign.join(", "));
  const [ok, output] = run(header.test, root());
  if (!ok) fail("the suite is red on base, so the swarm can't tell its breakage from what's already broken:\n" + output);
  git(["checkout", "-q", "-b", `swarm/${goal}`]);
  git(["add", "--", ".gitignore"]);
  if (git(["diff", "--cached", "--quiet"], { check: false }).code !== 0) {
    // Infrastructure, owned by zerg rather than a unit; the whole review skips this commit.
    git(["commit", "-q", "-m", `swarm ${goal}: infrastructure: ignore swarm state`]);
  }
  write(path.join(goalDir(goal), "contract.md"), setHeader(text, "autonomy", autonomy));
  log(goal, goal, "approved", `autonomy ${autonomy}`);
  save(goal, "approved plan");
  say(`on swarm/${goal}; autonomy ${autonomy}`);
}

// --- define and baseline ---

function foreignDefineChanges(goal, units) {
  const scopes = units.flatMap((u) => splitList(u.scope));
  const stateFiles = ["contract.md", "plan.md", "log.md"].map((n) => `.swarm/${goal}/${n}`);
  return dirtyPaths().filter((p) => stateFiles.includes(p) || scopes.some((g) => fnmatch(p, g)));
}

function cmdDefine(goal, ...pairs) {
  require(goal, "approved");
  onSwarm(goal);
  let units = loadUnits(goal);
  const foreign = foreignDefineChanges(goal, units);
  if (foreign.length) fail("the examiner changed product or state files: " + foreign.join(", "));
  if (holdoutTracked(goal)) fail(`holdout tests are tracked by git; untrack them, ${IGNORES[0]} must stay ignored`);
  const assigns = new Map(pairs.map((pair) => { const [k, , v] = partition(pair, "="); return [k, v]; }));
  for (const key of [...assigns.keys()].filter((k) => k.startsWith("finding:"))) {
    const uid = partition(key, ":")[2];
    getUnit(units, uid);
    log(goal, uid, "examiner-finding", assigns.get(key));
    assigns.delete(key);
  }
  if (assigns.has("holdout")) {
    fs.mkdirSync(path.join(goalDir(goal), "holdout"), { recursive: true });
    write(path.join(goalDir(goal), "holdout", "command"), assigns.get("holdout") + "\n");
    assigns.delete("holdout");
  }
  for (const [uid, command] of assigns) {
    if (command.includes("|")) fail(`${uid}: a check command can't contain '|'`);
    units = putUnit(units, { ...getUnit(units, uid), check: command });
  }
  saveUnits(goal, units);
  const named = [...assigns.keys()].join(", ");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", `swarm ${goal}: tests for ${named || "holdout"}`]);
  if (units.every((u) => u.check || CLOSED.includes(u.state))) log(goal, goal, "defined");
  save(goal, "defined");
  say(`checks recorded for ${named || "none"}`);
}

function baselineUnit(goal, unit, earlier) {
  if (!run(unit.check, root())[0]) return null;
  if (earlier.includes(unit.unit)) {
    updateUnit(goal, unit.unit, "stuck", "tests pass before any change, twice",
      { state: "stuck", note: "tests pass before any change; the examiner could not strengthen them" });
    return null;
  }
  log(goal, unit.unit, "baseline-pass");
  return unit.unit;
}

function cmdBaseline(goal) {
  require(goal, "defined");
  onSwarm(goal);
  const pending = openFindings(entries(goal));
  if (pending.length) fail(`examiner findings not routed into a task yet: ${pending.join(", ")}; run \`amend\` for each`);
  const earlier = entries(goal).filter((e) => e.event === "baseline-pass").map((e) => e.subject);
  const passing = loadUnits(goal).filter((u) => u.state === "planned").map((u) => baselineUnit(goal, u, earlier)).filter(Boolean);
  const holdout = holdoutCommand(goal);
  let holdoutNow = "none";
  if (holdout) {
    holdoutNow = run(holdout, root())[0] ? "pass" : "fail";
    log(goal, goal, "holdout-baseline", holdoutNow);
  }
  if (!passing.length) log(goal, goal, "baseline");
  save(goal, "baseline");
  say(json({ passing_before_work: passing, holdout_now: holdoutNow }));
  if (passing.length) exit(1);
}

// --- the unit loop ---

function currentRow(goal) {
  const text = contractText(goal);
  const units = loadUnits(goal);
  const rows = entries(goal);
  const header = parseHeader(text);
  const proven = new Set(rows.filter((e) => e.event === "proof").map((e) => e.subject));
  const now = fingerprint(units, rows);
  const state = {
    stop: stopped(), bound: boundHit(rows, budget(goal), userBounds(), now, units.length), has_contract: true,
    lint: lintProblems(text, units), events: goalEvents(rows), units,
    max_parallel: parseInt(header.max_parallel, 10) || 3, autonomy: header.autonomy || "ask",
    unproven: criteria(text).filter((c) => !proven.has(c)),
    open_findings: openFindings(rows),
    phases: Object.fromEntries(units.filter((u) => u.state === "produced").map((u) => [u.unit, unitPhase(rows, u.unit)])),
    fix_exists: units.some((u) => u.unit.startsWith("F-")),
  };
  return { row: derive(state), now };
}

function cmdPeek(goal) {
  if (!exists(goalDir(goal))) return say("row 2 scope: run `new`, write contract.md and plan.md, then `lint`");
  const [row, action, detail] = currentRow(goal).row;
  say(`row ${row} ${action}: ${detail}`);
}

function cmdNext(goal) {
  if (!exists(goalDir(goal))) return cmdPeek(goal);
  const { row: [row, action, detail], now } = currentRow(goal);
  log(goal, goal, "pass", now);
  save(goal, `pass: row ${row}`);
  say(`row ${row} ${action}: ${detail}`);
}

function cmdLease(goal, ...uids) {
  require(goal, "baseline");
  if (stopped()) fail(".swarm/STOP is present: no new leases");
  const spent = tokenTotal(entries(goal));
  const limit = budget(goal);
  if (limit && spent >= limit) fail(`token budget spent: ${spent} of ${limit}`);
  const ready = readyUnits(loadUnits(goal), parseInt(parseHeader(contractText(goal)).max_parallel, 10) || 3);
  const notReady = uids.filter((u) => !ready.includes(u));
  if (notReady.length) fail(`not ready to lease: ${notReady.join(", ")} (ready: ${ready.join(", ") || "none"})`);
  uids.forEach((uid) => updateUnit(goal, uid, "leased", "", { state: "leased" }));
  save(goal, `lease ${uids.join(" ")}`);
  uids.forEach((uid) => say(`leased ${uid}: worktree ${makeWorktree(goal, uid)}`));
}

function cmdProduced(goal, uid, summary = "") {
  if (getUnit(loadUnits(goal), uid).state !== "leased") fail(`${uid} is not leased`);
  const ref = `unit/${goal}/${uid}`;
  const known = git(["rev-parse", "--verify", "--quiet", ref], { check: false }).code === 0;
  const ahead = known ? parseInt(out(["rev-list", "--count", `swarm/${goal}..${ref}`]), 10) : 0;
  if (!ahead) {
    revise(goal, uid, `worker reported produced, but ${ref} has no commits`);
    exit(1);
  }
  moveUnit(goal, uid, "produced", summary);
}

function runInWorktree(ref, command) {
  const tree = path.join(root(), ".swarm", ".tmp", ref.replaceAll("/", "-"));
  git(["worktree", "remove", "--force", tree], { check: false });
  rmrf(tree);
  git(["worktree", "add", "-q", "--detach", tree, ref]);
  try {
    return run(command, tree);
  } finally {
    git(["worktree", "remove", "--force", tree], { check: false });
  }
}

function cmdCheck(goal, uid) {
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "produced") fail(`${uid} is ${unit.state}, not produced`);
  const ref = `unit/${goal}/${uid}`;
  const changed = lines(out(["diff", "--name-only", `swarm/${goal}...${ref}`]));
  const violations = scopeViolations(changed, splitList(unit.scope));
  const [ok, output] = runInWorktree(ref, unit.check);
  const problem = !changed.length ? "no changes" : violations.length ? `outside scope: ${violations.join(", ")}`
    : ok ? null : `check fails: ${lastLine(output)}`;
  say(json({ ok: problem === null, changed, scope_violations: violations, check: ok ? "pass" : "fail", output: ok ? "" : output }));
  if (problem) {
    revise(goal, uid, problem);
    exit(1);
  }
  log(goal, uid, "check-ok");
  save(goal, `${uid} checked`);
}

/** Checks do not repair: undo anything a verifier wrote, and say so. */
function restoreAfterVerifier(goal) {
  const dirty = dirtyPaths().filter((p) => !p.startsWith(`.swarm/${goal}/`));
  if (!dirty.length) return;
  const tracked = dirty.filter((p) => out(["ls-files", "--", p]));
  if (tracked.length) git(["restore", "--staged", "--worktree", "--", ...tracked], { check: false });
  const leftover = dirty.filter((p) => !tracked.includes(p));
  log(goal, goal, "verifier-wrote", dirty.join(", "));
  fail(`a verifier changed the tree (${dirty.join(", ")}); tracked files restored` +
    (leftover.length ? `; remove these untracked files by hand: ${leftover.join(", ")}` : "") + ". Rerun that verifier once.");
}

/** A worker reports its own result. Its worktree goes away; only commits on its branch count. */
function cmdReport(goal, uid, outcome, ...text) {
  if (!["produced", "escalated", "gave_up"].includes(outcome)) fail("report outcome is produced, escalated, or gave_up");
  const note = text.join(" ");
  removeWorktreeFor(`unit/${goal}/${uid}`);
  rmrf(worktreePath(goal, uid));
  if (outcome === "produced") cmdProduced(goal, uid, note);
  else if (outcome === "escalated") moveUnit(goal, uid, "stuck", `question: ${note}`);
  else revise(goal, uid, `gave up: ${note}`);
}

/** A verifier records its verdict. It may not have changed anything else in the tree. */
function cmdReview(goal, subject, verdict, ...reason) {
  if (!["pass", "fail"].includes(verdict)) fail("review verdict is pass or fail");
  const note = reason.join(" ");
  restoreAfterVerifier(goal);
  if (subject === "whole") {
    require(goal, "integrated");
    log(goal, goal, verdict === "pass" ? "whole-review" : "whole-blocking", note);
    save(goal, `whole review ${verdict}`);
    return say(`whole review: ${verdict}`);
  }
  if (getUnit(loadUnits(goal), subject).state !== "produced" || unitPhase(entries(goal), subject) !== "review") {
    fail(`${subject} isn't waiting for review; run \`peek\``);
  }
  if (verdict === "fail") return revise(goal, subject, note || "verifier failed it without a reason");
  log(goal, subject, "review-pass", note);
  save(goal, `${subject} review pass`);
  say(`${subject}: review pass; it merges next`);
}

/** The whole handoff for a subagent: identifiers and a role file, never a summary of the run. */
function cmdBrief(goal, role, uid = "-") {
  if (!ROLES.includes(role)) fail(`role is one of ${ROLES.join(", ")}`);
  const text = [`You are the zerg ${role}. Read ${path.join(SKILL_DIR, "references", role + ".md")} and follow it exactly.`,
    `Goal: ${goal}`, `Unit: ${uid}`, `MAIN: ${root()}`, `S: node ${SCRIPT}`];
  if (role === "worker") text.push(`WORKTREE: ${worktreePath(goal, uid)}`);
  say(text.join("\n"));
}

/** The approval brief, built from the files so the human sees exactly what will run. */
function cmdSummary(goal) {
  const text = contractText(goal);
  say(lines(text)[0] ?? goal);
  for (const name of ["Outcome", "Criteria", "Constraints", "Non-goals", "Decisions"]) {
    const body = section(text, name).trim();
    if (body) say(`\n${name}:\n${body}`);
  }
  say("\nUnits:");
  for (const u of loadUnits(goal)) say(`  ${u.unit}  ${u.task}  [scope: ${u.scope}]  [after: ${u.after}]  [${u.criteria}]`);
  const problems = allPlanProblems(goal);
  say("\nLint: " + (problems.length ? problems.join("; ") : "ok"));
}

function cmdMerge(goal, uid) {
  onSwarm(goal);
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "produced" || unitPhase(entries(goal), uid) !== "merge") {
    fail(`${uid} must be produced, checked, and passed by a verifier before it merges`);
  }
  restoreAfterVerifier(goal);
  save(goal, "before merge");
  if (git(["merge", "-q", "--no-ff", "--no-edit", `unit/${goal}/${uid}`], { check: false }).code !== 0) {
    git(["merge", "--abort"], { check: false });
    moveUnit(goal, uid, "stuck", "merge conflict: the plan's scopes collide in practice");
    exit(1);
  }
  // Other units' tests are still red by design (fail-first), so the full suite waits for integrate.
  // Per merge: this unit's check and every merged unit's check must pass.
  const guarded = loadUnits(goal).filter((u) => u.state === "merged" || u.unit === uid);
  const broken = guarded.filter((u) => !run(u.check, root())[0]).map((u) => u.unit);
  if (broken.length) {
    git(["reset", "-q", "--hard", "HEAD~1"]);
    revise(goal, uid, `after merge these checks fail: ${broken.join(", ")}`);
    exit(1);
  }
  moveUnit(goal, uid, "merged", "checks green");
}

function cmdAnswer(goal, subject, ...words) {
  const text = words.join(" ");
  const contract = path.join(goalDir(goal), "contract.md");
  write(contract, read(contract).trimEnd() + `\n- ${subject}: ${clean(text)}\n`);
  if (subject !== "goal") {
    const unit = getUnit(loadUnits(goal), subject);
    if (unit.state !== "stuck") fail(`${subject} is ${unit.state}, not stuck`);
    updateUnit(goal, subject, "answered", text, { state: "planned", revisions: "0", note: `answered: ${text}` });
  } else log(goal, goal, "answered", text);
  save(goal, `decision for ${subject}`);
  say(`recorded decision for ${subject}`);
}

/** Route an examiner finding into the unit's task before any worker sees the unit. */
function cmdAmend(goal, uid, ...words) {
  const text = clean(words.join(" "));
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "planned") fail(`${uid} is ${unit.state}; amend a task only before its unit is leased`);
  updateUnit(goal, uid, "amended", text, { task: `${unit.task}. Also: ${text}` });
  save(goal, `amend ${uid}`);
  say(`${uid}: task amended`);
}

/** A human decision only: widen or change a stuck unit's scope. Open units still may not overlap. */
function cmdRescope(goal, uid, scope, ...reason) {
  const units = loadUnits(goal);
  const unit = getUnit(units, uid);
  if (unit.state !== "stuck") fail(`${uid} is ${unit.state}; only a stuck unit is rescoped, after a human decides`);
  const clash = units.filter((u) => u.unit !== uid && !CLOSED.includes(u.state) && globsOverlap(splitList(scope), splitList(u.scope)))
    .map((u) => u.unit);
  if (clash.length) fail(`new scope overlaps open units: ${clash.join(", ")}`);
  const text = reason.join(" ") || "human decision";
  const contract = path.join(goalDir(goal), "contract.md");
  write(contract, read(contract).trimEnd() + `\n- ${uid}: scope is now ${clean(scope)}: ${clean(text)}\n`);
  updateUnit(goal, uid, "rescoped", `${scope}: ${text}`, { scope, state: "planned", revisions: "0", note: `rescoped: ${text}` });
  save(goal, `rescope ${uid}`);
  say(`${uid}: scope ${scope}; back to planned`);
}

// --- integrate to hand-off ---

function cmdAddFix(goal, task, scope) {
  require(goal, "integrated");
  const units = loadUnits(goal);
  if (units.some((u) => u.unit.startsWith("F-"))) fail("one fix unit per goal; a second blocking finding goes to the human");
  /** @type {Unit} */
  const fix = { unit: "F-1", task, scope, after: "-", criteria: "-", check: parseHeader(contractText(goal)).test,
    state: "planned", revisions: "0", note: "" };
  saveUnits(goal, [...units, fix]);
  log(goal, "F-1", "added", task);
  log(goal, goal, "reopened", "fix unit F-1");
  save(goal, "fix unit F-1");
  say("added F-1; it runs through implement, check, review, then integrate again");
}

function cmdIntegrate(goal) {
  onSwarm(goal);
  const open = loadUnits(goal).filter((u) => !CLOSED.includes(u.state)).map((u) => u.unit);
  if (open.length) fail(`units still open: ${open.join(", ")}`);
  if (holdoutTracked(goal)) fail("holdout tests are tracked by git");
  const [suiteOk, output] = run(parseHeader(contractText(goal)).test, root());
  const holdout = holdoutCommand(goal);
  const holdoutOk = holdout ? run(holdout, root())[0] : true;
  say(json({ suite: suiteOk ? "pass" : "fail", suite_output: suiteOk ? "" : output, holdout: holdoutOk ? "pass" : "fail" }));
  if (!(suiteOk && holdoutOk)) {
    log(goal, goal, "integrate-failed", `suite ${suiteOk}, holdout ${holdoutOk}`);
    save(goal, "integration failed");
    exit(1);
  }
  log(goal, goal, "integrated");
  save(goal, "integrated");
}

function cmdProve(goal, criterion, ...command) {
  require(goal, "integrated");
  onSwarm(goal);
  const text = contractText(goal);
  if (!criteria(text).includes(criterion)) fail(`no criterion ${criterion}`);
  const evidence = command.join(" ");
  const [ok, output] = run(evidence, root());
  say(output);
  if (!ok) fail(`${criterion}: evidence command failed, so it is not proven`);
  log(goal, criterion, "proof", evidence);
  const proven = new Set(entries(goal).filter((e) => e.event === "proof").map((e) => e.subject));
  if (criteria(text).every((c) => proven.has(c))) log(goal, goal, "proved");
  save(goal, `proof for ${criterion}`);
}

/** Project lessons go to the project, zerg lessons go to zerg's inbox. Nothing is applied. */
function routeLearnings(goal) {
  const text = read(requireFile(goal, "learn.md"));
  if (!text.includes("## zerg") || !text.includes("## project")) {
    fail("learn.md needs a `## zerg` and a `## project` section (write `none` under an empty one)");
  }
  const lanes = splitLanes(text);
  const when = `${goal} (${stamp(false)})`;
  const routed = [];
  if (lanes.project) {
    appendBlock(path.join(root(), ".swarm", "LEARNINGS.md"), when, lanes.project);
    git(["add", "--", ".swarm/LEARNINGS.md"]);
    routed.push("project -> .swarm/LEARNINGS.md");
  }
  if (lanes.zerg) {
    appendBlock(inboxPath(), `${path.basename(root())} ${when}`, lanes.zerg);
    routed.push(`zerg -> ${inboxPath()}`);
  }
  return routed;
}

function cmdStage(goal, event, ...note) {
  /** @type {Record<string, string>} */
  const needs = { "whole-review": "integrated", learned: "proved", finding: "approved" };
  if (!(event in needs)) fail(`stage is one of ${Object.keys(needs).join(", ")}`);
  require(goal, needs[event]);
  if (event === "learned") {
    const routed = routeLearnings(goal);
    note.push(routed.join("; ") || "no proposals");
    say(routed.join("\n") || "no proposals to route");
  }
  log(goal, goal, event, note.join(" "));
  save(goal, event);
  say(`${goal}: ${event}`);
}

function cmdTokens(goal, who, stage, count = "") {
  if (!/^\d+$/.test(count)) fail("tokens must be a whole number");
  log(goal, who, "tokens", `${stage} ${count}`);
  save(goal, `tokens ${who}`);
}

function tokenLines(rows) {
  /** @type {Record<string, number>} */
  const byStage = {};
  for (const e of rows.filter((r) => r.event === "tokens")) {
    const at = e.note.lastIndexOf(" ");
    const stage = e.note.slice(0, at);
    byStage[stage] = (byStage[stage] ?? 0) + parseInt(e.note.slice(at + 1), 10);
  }
  const fmt = (n) => n.toLocaleString("en-US");
  return [...Object.keys(byStage).sort().map((s) => `  ${s}: ${fmt(byStage[s])}`), `  total: ${fmt(tokenTotal(rows))}`];
}

function cmdStatus(goal) {
  say(partition(read(planPath(goal)), "\n|")[0].trim());
  say(renderTable(loadUnits(goal)));
  const rows = entries(goal);
  say("events: " + [...goalEvents(rows)].filter((e) => e !== "pass" && e !== "tokens").sort().join(", "));
  say("tokens:\n" + tokenLines(rows).join("\n"));
}

/** Worker worktrees outlive their agents when they hold commits; the branches keep the work. */
function removeUnitWorktrees(goal) {
  for (const tree of worktrees()) {
    if ((tree.branch ?? "").startsWith(`refs/heads/unit/${goal}/`)) {
      git(["worktree", "remove", "--force", tree.worktree], { check: false });
      say(`removed worktree ${tree.worktree}`);
    }
  }
}

function cmdHandoff(goal) {
  require(goal, "learned");
  const text = contractText(goal);
  const rows = entries(goal);
  const base = parseHeader(text).base;
  const proofs = Object.fromEntries(rows.filter((e) => e.event === "proof").map((e) => [e.subject, e.note]));
  say(`branch: swarm/${goal} (base ${base})\n`);
  say(out(["diff", "--stat", `${base}...swarm/${goal}`]) + "\n");
  say("criteria:\n" + criteria(text).map((c) => `  ${c}: ${proofs[c] ?? "UNPROVEN"}`).join("\n"));
  const findings = rows.filter((e) => e.event === "finding").map((e) => `  ${e.note}`);
  say("findings:\n" + (findings.join("\n") || "  none"));
  say("units:\n" + loadUnits(goal).map((u) => `  ${u.unit}: ${u.state}, ${u.revisions} revisions`).join("\n"));
  say("tokens:\n" + tokenLines(rows).join("\n"));
  say(`learn: .swarm/${goal}/learn.md`);
  say(`note: the merge also adds these .gitignore lines: ${IGNORES.join(", ")}`);
  log(goal, goal, "handed-off");
  save(goal, "handed off");
  removeUnitWorktrees(goal);
  git(["checkout", "-q", base]);
  say(`\nchecked out ${base}. Review, then merge swarm/${goal} yourself.`);
}

const LOCK_FREE = new Set(["peek", "status", "summary", "brief", "lint"]);
/** @type {Record<string, (...args: string[]) => void>} */
const USER_COMMANDS = { home: cmdHome, inbox: cmdInbox, accept: cmdAccept, dismiss: cmdDismiss, config: cmdConfig };
/** @type {Record<string, (...args: string[]) => void>} */
const COMMANDS = {
  new: cmdNew, lint: cmdLint, approve: cmdApprove, define: cmdDefine, baseline: cmdBaseline,
  next: cmdNext, peek: cmdPeek, report: cmdReport, review: cmdReview, brief: cmdBrief, summary: cmdSummary,
  lease: cmdLease, produced: cmdProduced, check: cmdCheck, merge: cmdMerge,
  revise: (goal, uid, ...note) => revise(goal, uid, note.join(" ")),
  move: (goal, uid, target, ...note) => moveUnit(goal, uid, target, note.join(" ")),
  answer: cmdAnswer, rescope: cmdRescope, amend: cmdAmend, "add-fix": cmdAddFix,
  integrate: cmdIntegrate, prove: cmdProve, stage: cmdStage, tokens: cmdTokens, status: cmdStatus, handoff: cmdHandoff,
};

/** @param {string[]} argv */
export function main(argv) {
  const [command = "", ...args] = argv;
  try {
    if (command in USER_COMMANDS) USER_COMMANDS[command](...args);
    else if (command in COMMANDS && args.length) {
      // A worker calls `report` from its own worktree, which `report` deletes. Work from the main tree.
      process.chdir(root());
      if (LOCK_FREE.has(command)) COMMANDS[command](...args);
      else withStateLock(() => COMMANDS[command](...args));
    } else fail(USAGE);
    return 0;
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    if (error.message) console.error(error.message);
    return error.code;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT) process.exitCode = main(process.argv.slice(2));
