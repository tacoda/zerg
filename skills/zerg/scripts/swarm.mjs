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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARG_KINDS, ARG_SHAPES, BOUNDS, CLOSED, COLUMNS, GOAL_ID,
  IGNORES, MANUAL_MOVES, NOT_TREE, PASSES_PER_UNIT, ROLES, SECRET,
  SECTIONS, SHELL_META, TRANSITIONS, UNIT_ID, WILD, argProblem,
  blockedUnits, boundHit, charClass, checkTransition, clean, criteria, criterionCommand, oneLine, parseLogLine,
  derive, deriveClose, deriveGates, derivePrep, deriveUnits, endWord,
  escapeRe, fingerprint, fnmatch, globOverlap, globToken, globsOverlap,
  goalEvents, grepArgv, grepCriteria, grepHitFiles, grepProblems, idsIn,
  isUnitId, lines, lintProblems, mergeOrder, needsDefine, openFindings,
  openQuote, parseHeader, parseInbox, parseTable, partition, planProblems,
  quoted, readyUnits, renderInbox, renderTable, replaceTable, reviseUnit,
  rowProblems, scopeViolations, section, setHeader, shellStep, shellWords,
  splitLanes, splitList, testViolations, tokenTotal, unitPhase,
  blockers, folderScopeProblems, lastFailure, isFinding, isNoOp, learnProblems, settledCriteria, settlements, orphanedLeases, stuckDetail, insertDecision, templateProblems, strengthenUnits, TEST_CHECK, scopeGlobs, normalizeNewlines, parsePorcelainZ, slug, resolveCheck,
} from "./core.mjs";

export * from "./core.mjs";

const USAGE = `zerg control plane

  new <goal>                          scaffold contract.md and plan.md, add gitignore lines
  lint <goal>                         plan gate: sections, criteria, scopes, deps, coverage
  approve <goal> [ask|auto]           lint + clean tree + green suite on base, then branch swarm/<goal>
  define <goal> U-001='cmd' .. [holdout='cmd'] [finding:U-001='text']   examiner's checks and findings;
                                      the holdout command and tests live outside the repo, in $ZERG_HOME/holdout
  amend <goal> <unit> [text]          route an examiner finding into a planned unit's task; the log's by default
  baseline <goal>                     every unit check must fail before any work
  next <goal>                         the derive table: reclaims lost leases, auto-drops under auto, then
                                      prints the one next action and counts a pass
  peek <goal>                         the same row, without counting a pass
  summary <goal>                      the approval brief, built from contract.md and plan.md
  lease <goal> <unit>..               STOP, budget, deps, parallelism; leased, with a worktree per unit
  brief <goal> <role> [unit]          the handoff text for a subagent (examiner, worker, verifier)
  report <goal> <unit> produced|escalated|gave_up [text]   a worker records its own result
  review <goal> <unit|whole> pass|fail [reason]            a verifier records its verdict
  check <goal> <unit>                 scope + unit check in a temp worktree; revises on failure
  merge <goal> <unit>                 needs a recorded pass; merges, re-runs merged checks; rolls back on red
  move <goal> <unit> <state> [note]   by hand only: leased -> planned (lease lost), planned|stuck -> dropped
  answer <goal> <unit|goal> <text>    a human decision; a stuck unit goes back to planned
  rescope <goal> <unit> <scope> [why] a human decision: new scope for a stuck or planned unit
  reopen <goal> <task> <scope> [why]  a human decision: a fix unit after a goal-level failure
  waive <goal> <C|whole> <why>        a human decision: accept a criterion, or the whole change, without proof
  add-fix <goal> <task> <scope>       the orchestrator's one automatic fix for a blocking whole review
  integrate <goal>                    full suite + holdout; holdout reports pass/fail only
  prove <goal> <criterion> [cmd..]    run evidence for one criterion, the contract's command by default
  stage <goal> learned|finding [note] \`learned\` routes learn.md: project lane to
                                      .swarm/LEARNINGS.md, zerg lane to $ZERG_HOME/inbox.md
  tokens <goal> <who> <stage> <n>     record a dispatch's token use
  status <goal>                       unit table, goal events, token totals
  handoff <goal>                      final report, clean up, then check out base
  abandon <goal> <why>                a human decision: stop for good; keeps swarm/<goal> as the record,
                                      or, before approval, removes the plan

User layer, in $ZERG_HOME (default ~/.zerg), outside the skill so it survives updates:
  home                                paths and the bounds in effect
  rules                               print the user rules every role reads
  inbox                               pending zerg proposals routed by \`stage learned\`
  accept <id> [note]                  move a proposal into rules.md, which every goal reads
  dismiss <id> [reason]               archive a proposal without using it
  config <key> <n>                    override max_revisions, max_passes, no_progress, or lease_minutes`;

const SCRIPT = fs.realpathSync(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(path.dirname(SCRIPT));
const TEMPLATES = path.join(SKILL_DIR, "assets");
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

// --- I/O ---

const say = (/** @type {string} */ text) => console.log(text);
const exists = (/** @type {string} */ p) => fs.existsSync(p);
const read = (/** @type {string} */ p) => normalizeNewlines(fs.readFileSync(p, "utf8"));
/** Writes through a temp file and a rename, so a lock-free reader never sees half a file. */
function write(/** @type {string} */ p, /** @type {string} */ text) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}
const rmrf = (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true });
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
function stamp(withTime = true) {
  const d = new Date();
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return withTime ? `${day}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : day;
}
const json = (value) => JSON.stringify(value, null, 2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Test suites can print a lot; spawnSync's 1 MiB default would kill them and read as a failure. */
const BIG = { maxBuffer: 1 << 30 };
/** zerg's own git work is bookkeeping: the user's hooks and commit signing are for their commits, not these. */
const OWN_GIT = ["-c", `core.hooksPath=${os.devNull}`, "-c", "commit.gpgsign=false"];

/** @param {string[]} args @param {{cwd?: string, check?: boolean}} [options] */
function git(args, { cwd, check = true } = {}) {
  const proc = spawnSync("git", [...OWN_GIT, ...args], { cwd: cwd ?? root(), encoding: "utf8", ...BIG });
  if (check && proc.status !== 0) fail(`git ${args.join(" ")}: ${(proc.stderr ?? "").trim()}`);
  return { code: proc.status ?? 1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

const out = (/** @type {string[]} */ args, cwd = undefined) => git(args, { cwd }).stdout.trim();

let cachedRoot = "";
function root() {
  if (cachedRoot) return cachedRoot;
  // The first entry of `worktree list` is the main worktree, which is right in linked worktrees and submodules alike.
  const proc = spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (proc.status !== 0) fail("not inside a git repository");
  cachedRoot = partition(lines(proc.stdout)[0] ?? "", " ")[2];
  return cachedRoot;
}

/** Runs a project command through the shell. @returns {[boolean, string]} */
function run(command, cwd) {
  const proc = spawnSync(command, { shell: true, cwd, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, ...BIG });
  return [proc.status === 0, ((proc.stdout ?? "") + (proc.stderr ?? "")).slice(-3000)];
}

const lastLine = (/** @type {string} */ text) => lines(text.trim()).pop() ?? "";

/** The real path of p, following symlinks in whatever part of it exists already. */
function realish(p) {
  const full = path.resolve(p);
  if (exists(full)) return fs.realpathSync(full);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(realish(parent), path.basename(full));
}

/** A relative path that is empty, climbs out, or jumps to another root does not stay inside its base. */
const escapes = (rel) => !rel || rel.startsWith("..") || path.isAbsolute(rel);

/** Joins and refuses any result outside base, so no id or ref can point a write or a delete elsewhere. */
function within(base, ...parts) {
  const full = path.resolve(base, ...parts);
  if (escapes(path.relative(base, full))) fail(`refusing a path outside ${base}: ${full}`);
  return full;
}
const goalDir = (/** @type {string} */ goal) => path.join(root(), ".swarm", goal);

const branchExists = (/** @type {string} */ name) => git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { check: false }).code === 0;

/** A goal's state lives on its branch; from any other branch, say where it is. */
function requireBranch(goal) {
  if (branchExists(`swarm/${goal}`)) fail(`${goal}: state lives on swarm/${goal}; check it out first`);
}

function requireFile(goal, name) {
  const file = path.join(goalDir(goal), name);
  if (!exists(file)) {
    requireBranch(goal);
    fail(`no goal ${goal}`);
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
  return lines(read(file)).map(parseLogLine).filter((e) => e !== null);
}

function log(goal, subject, event, note = "") {
  fs.appendFileSync(path.join(goalDir(goal), "log.md"), `- ${stamp()} | ${subject} | ${event} | ${oneLine(note)}\n`);
}

const branch = () => out(["branch", "--show-current"]);

function onSwarm(goal) {
  if (branch() !== `swarm/${goal}`) fail(`check out swarm/${goal} first (on ${branch() || "detached HEAD"})`);
}

/** Commits zerg's own state. A user's hooks and commit signing are for their code, not for this bookkeeping. */
function commitState(message) {
  git(["commit", "-q", "--no-verify", "-m", message]);
}

function save(goal, message) {
  if (branch() !== `swarm/${goal}`) return;
  git(["add", "--", `.swarm/${goal}`]);
  if (git(["diff", "--cached", "--quiet"], { check: false }).code !== 0) commitState(`swarm ${goal}: ${message}`);
}

function require(goal, event) {
  if (!goalEvents(entries(goal)).has(event)) fail(`${goal}: \`${event}\` hasn't happened yet`);
}

/** A folder for this repo in the user layer, which must sit outside the repo so no test runner collects it. */
function userDir(kind, ...parts) {
  const key = `${slug(path.basename(root()))}-${createHash("sha1").update(root()).digest("hex").slice(0, 8)}`;
  const dir = within(path.join(zergHome(), kind), key, ...parts);
  if (!path.relative(root(), realish(dir)).startsWith("..")) fail(`ZERG_HOME (${zergHome()}) is inside this repo; set it outside the repo`);
  return dir;
}

/** Outside the repo, so no test runner collects it and no worker or verifier working in the repo can read it. */
const holdoutDir = (goal) => userDir("holdout", goal);

function holdoutCommand(goal) {
  const file = path.join(holdoutDir(goal), "command");
  return exists(file) ? read(file).trim() : "";
}

const stopped = () => exists(path.join(root(), ".swarm", "STOP"));

function budget(goal) {
  const value = parseHeader(contractText(goal)).token_budget ?? "";
  return /^\d+$/.test(value) ? parseInt(value, 10) : 0;
}

function dirtyPaths() {
  return parsePorcelainZ(git(["status", "--porcelain", "-z", "--untracked-files=all"]).stdout)
    .filter((p) => !NOT_TREE.some((n) => p.startsWith(n)));
}


/** Changes one unit's fields and logs why, in one step. */
function updateUnit(goal, uid, { event, note = "", fields = {} }) {
  const units = loadUnits(goal);
  const unit = { ...getUnit(units, uid), ...fields };
  saveUnits(goal, putUnit(units, unit));
  log(goal, uid, event, note);
  return unit;
}

function moveUnit(goal, uid, target, note = "") {
  const unit = getUnit(loadUnits(goal), uid);
  const error = checkTransition(unit.state, target);
  if (error) fail(`${uid}: ${error}`);
  updateUnit(goal, uid, { event: target, note, fields: { state: target, note: clean(note) || unit.note } });
  save(goal, `${uid} ${target}`);
  say(`${uid}: ${unit.state} -> ${target}`);
}

function revise(goal, uid, note) {
  const units = loadUnits(goal);
  const current = getUnit(units, uid);
  if (!["leased", "produced"].includes(current.state)) fail(`${uid} is ${current.state}; only leased or produced units are revised`);
  const unit = reviseUnit(current, note, userBounds().max_revisions, lastFailure(entries(goal), uid));
  saveUnits(goal, putUnit(units, unit));
  log(goal, uid, unit.state === "planned" ? "revise" : "stuck", note);
  save(goal, `${uid} ${unit.state}`);
  say(`${uid}: revision ${unit.revisions} -> ${unit.state}: ${unit.note}`);
}

const LOCK_OWNER = `${process.pid}@${os.hostname()}`;

/** True when no live process owns the lock: a dead pid on this host, an old lock from another host, or an empty
 * lock that a process died before writing its name into. */
function lockIsStale(lock) {
  const owner = read(lock).trim();
  const age = Date.now() - fs.statSync(lock).mtimeMs;
  if (!owner.includes("@")) return age > 5_000;
  const [pid, host] = partition(owner, "@").filter((_, i) => i !== 1);
  if (host !== os.hostname()) return age > 1_800_000;
  try {
    process.kill(parseInt(pid, 10), 0);
    return false;
  } catch (error) {
    return /** @type {any} */ (error).code === "ESRCH";
  }
}

/** @returns {"taken" | "stale" | "busy"} "stale" means a dead owner's lock was cleared: a command crashed. */
function takeLock(lock) {
  try {
    fs.writeFileSync(lock, LOCK_OWNER, { flag: "wx" });
    return "taken";
  } catch (error) {
    if (/** @type {any} */ (error).code !== "EEXIST") throw error;
  }
  try {
    if (lockIsStale(lock)) {
      fs.unlinkSync(lock);
      return "stale";
    }
  } catch {
    // The owner released it between our two reads; try again.
  }
  return "busy";
}

/** Waits for the lock. @returns {boolean} whether a crashed command left it behind. */
function acquire(lock, label) {
  // ZERG_LOCK_TIMEOUT_S shortens the wait, which lets a test prove a live owner's lock is never taken.
  const seconds = parseInt(process.env.ZERG_LOCK_TIMEOUT_S ?? "", 10) || 900;
  const deadline = Date.now() + seconds * 1000;
  let crashed = false;
  for (let got = takeLock(lock); got !== "taken"; got = takeLock(lock)) {
    crashed ||= got === "stale";
    if (Date.now() > deadline) fail(`another zerg command (${exists(lock) ? read(lock).trim() : "gone"}) held ${label} for ${seconds} seconds`);
    if (got === "busy") sleep(200);
  }
  return crashed;
}

/** One writer at a time, so parallel agents calling the script can't lose each other's updates. */
function withLock(lock, label, fn) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const crashed = acquire(lock, label);
  try {
    return fn(crashed);
  } finally {
    if (exists(lock) && read(lock).trim() === LOCK_OWNER) fs.rmSync(lock, { force: true });
  }
}

/** Holding the lock means no write is in flight, so a temp file now is a crashed write's leftover. */
function removeStaleTemps(goal) {
  const dir = goalDir(goal);
  for (const name of exists(dir) ? fs.readdirSync(dir) : []) if (name.endsWith(".tmp")) rmrf(path.join(dir, name));
}

/** A crashed command may have written state it never committed. Commit it, so no later restore mistakes it for a role's write. */
function withStateLock(goal, fn) {
  return withLock(path.join(root(), ".swarm", ".lock"), ".swarm/.lock", (crashed) => {
    removeStaleTemps(goal);
    if (crashed) save(goal, "recover state after a crashed command");
    return fn();
  });
}

const withUserLock = (fn) => withLock(path.join(zergHome(), ".lock"), `${zergHome()}/.lock`, fn);

const worktreePath = (goal, uid) => userDir("work", goal, uid);

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

/** Runs the contract's `setup` in a new worktree, so ignored dependencies (node_modules, a venv) are there. */
function runSetup(goal, dir) {
  const setup = parseHeader(contractText(goal)).setup;
  if (!setup) return [true, ""];
  const proc = spawnSync(setup, { shell: true, cwd: dir, encoding: "utf8", env: { ...process.env, MAIN: root() }, ...BIG });
  return [proc.status === 0, ((proc.stdout ?? "") + (proc.stderr ?? "")).slice(-3000)];
}

function makeWorktree(goal, uid) {
  const ref = `unit/${goal}/${uid}`;
  const dir = worktreePath(goal, uid);
  removeWorktreeFor(ref);
  rmrf(dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(["worktree", "add", "-q", "-B", ref, dir, `swarm/${goal}`]);
  const [ok, output] = runSetup(goal, dir);
  if (!ok) {
    git(["worktree", "remove", "--force", dir], { check: false });
    fail(`setup failed in ${uid}'s worktree, so nothing was leased:\n${output}`);
  }
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

/** A known bound with a whole value of 1 or more. A no-progress window of 1 would stop every pass, so it needs 2. */
const isBound = (key, value) => key in BOUNDS && /^\d+$/.test(value) && parseInt(value, 10) >= (key === "no_progress" ? 2 : 1);

export function userBounds() {
  const file = path.join(zergHome(), "config");
  const values = {};
  for (const line of exists(file) ? lines(read(file)) : []) {
    const [key, sep, value] = partition(line, ":");
    if (sep && isBound(key.trim(), value.trim())) values[key.trim()] = parseInt(value.trim(), 10);
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

function cmdRules() {
  const file = path.join(zergHome(), "rules.md");
  say(exists(file) ? read(file) : "no user rules yet");
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
  if (!isBound(key, value)) fail(`config takes one of ${Object.keys(BOUNDS).join(", ")} and a whole number (no_progress needs 2 or more)`);
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
  requireBranch(goal);
  if (git(["rev-parse", "--verify", "--quiet", "HEAD"], { check: false }).code !== 0) fail("the repo has no commits; commit once, then run new");
  if (!branch()) fail("HEAD is detached; check out the branch the swarm should build on, then run new");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(holdoutDir(goal), { recursive: true });
  const contract = read(path.join(TEMPLATES, "contract.md")).replaceAll("<goal>", goal);
  write(path.join(dir, "contract.md"), setHeader(contract, "base", branch()));
  write(path.join(dir, "plan.md"), read(path.join(TEMPLATES, "plan.md")).replaceAll("<goal>", goal));
  ensureIgnores();
  log(goal, goal, "created");
  say(`created .swarm/${goal}: fill contract.md and plan.md, then run lint`);
}

const isFolder = (/** @type {string} */ rel) => fs.statSync(path.join(root(), rel), { throwIfNoEntry: false })?.isDirectory() ?? false;

function runGrepCriteria(text, units) {
  return grepCriteria(text).flatMap(([cid, command]) => {
    const argv = grepArgv(command);
    if (!argv) return [`${cid}: a grep criterion must be one plain grep command, with no shell operators`];
    const proc = spawnSync(argv[0], argv.slice(1), { cwd: root(), encoding: "utf8", ...BIG });
    return grepProblems(cid, grepHitFiles(proc.stdout ?? ""), units);
  });
}

function allPlanProblems(goal) {
  const text = contractText(goal);
  const units = loadUnits(goal);
  const template = read(path.join(TEMPLATES, "contract.md"));
  return [...lintProblems(text, units), ...templateProblems(text, template, units), ...runGrepCriteria(text, units),
    ...folderScopeProblems(units, isFolder)];
}

function cmdLint(goal) {
  const problems = allPlanProblems(goal);
  say(problems.join("\n") || `${goal}: plan ok`);
  if (problems.length) exit(1);
}

/** A fresh approve starts on base, with no swarm/<goal> yet. Resuming means a crash left us on swarm/<goal>. */
function branchChecks(goal, header) {
  if (branch() !== header.base) fail(`approve from ${header.base}, not ${branch()}`);
  // git can't hold both a branch `unit` and a branch `unit/<goal>/U-001`.
  const blocking = ["unit", "swarm", `unit/${goal}`].filter(branchExists);
  if (blocking.length) fail(`branch ${blocking.join(", ")} blocks the branches zerg makes under that name; rename it`);
  if (branchExists(`swarm/${goal}`)) {
    fail(`swarm/${goal} already exists; check it out to finish approving, or delete it to start over`);
  }
}

/** Everything approve needs before it touches a branch. */
function approveChecks(goal, header, resuming) {
  const problems = allPlanProblems(goal);
  if (problems.length) fail("plan fails lint:\n" + problems.join("\n"));
  if (!resuming) branchChecks(goal, header);
  const foreign = dirtyPaths().filter((p) => !p.startsWith(`.swarm/${goal}/`) && !p.startsWith(".gitignore"));
  if (foreign.length) fail("tree not clean: " + foreign.join(", "));
  const setup = setupProblem(goal);
  if (setup) fail(setup);
  const [ok, output] = run(header.test, root());
  if (!ok) fail("the suite is red on base, so the swarm can't tell its breakage from what's already broken:\n" + output);
}

function cmdApprove(goal, autonomy = "ask") {
  if (!["ask", "auto"].includes(autonomy)) fail("autonomy is ask or auto");
  const text = contractText(goal);
  const resuming = branch() === `swarm/${goal}`;
  approveChecks(goal, parseHeader(text), resuming);
  if (!resuming) git(["checkout", "-q", "-b", `swarm/${goal}`]);
  git(["add", "--", ".gitignore"]);
  // Infrastructure, owned by zerg rather than a unit; the whole review skips this commit.
  if (git(["diff", "--cached", "--quiet"], { check: false }).code !== 0) commitState(`swarm ${goal}: infrastructure: ignore swarm state`);
  write(path.join(goalDir(goal), "contract.md"), setHeader(text, "autonomy", autonomy));
  log(goal, goal, "approved", `autonomy ${autonomy}`);
  save(goal, "approved plan");
  say(`on swarm/${goal}; autonomy ${autonomy}`);
}

// --- define and baseline ---

function foreignDefineChanges(goal, units) {
  const scopes = units.flatMap((u) => scopeGlobs(u.scope));
  const stateFiles = ["contract.md", "plan.md", "log.md"].map((n) => `.swarm/${goal}/${n}`);
  return dirtyPaths().filter((p) => stateFiles.includes(p) || scopes.some((g) => fnmatch(p, g)));
}

/** Parses define's pairs and checks all of them before anything is written. */
function defineInput(units, pairs) {
  const input = { checks: new Map(), findings: [], holdout: null };
  for (const pair of pairs) {
    const [key, sep, value] = partition(pair, "=");
    if (!sep) fail(`define takes key=value pairs, not ${JSON.stringify(pair)}`);
    addDefinePair(input, units, key, value);
  }
  return input;
}

function addDefinePair(input, units, key, value) {
  if (key === "holdout" && isNoOp(value)) fail(`holdout: \`${value}\` passes whatever the code does`);
  if (key === "holdout") return void (input.holdout = value);
  if (key.startsWith("finding:")) return void input.findings.push([getUnit(units, partition(key, ":")[2]).unit, value]);
  getUnit(units, key);
  if (value.includes("|")) fail(`${key}: a check command can't contain '|'`);
  input.checks.set(key, value);
}

const examinerFiles = (goal) =>
  [...new Set(entries(goal).filter((e) => e.event === "test-files").flatMap((e) => splitList(e.note)))];

/** A goal is defined when every open unit has a check and the holdout has a command. */
function markDefined(goal, units) {
  if (!units.every((u) => u.check || CLOSED.includes(u.state))) return;
  if (holdoutCommand(goal)) log(goal, goal, "defined");
  else say("not defined yet: record the holdout tests' command with holdout=<command>");
}

function cmdDefine(goal, ...pairs) {
  require(goal, "approved");
  onSwarm(goal);
  let units = loadUnits(goal);
  const foreign = foreignDefineChanges(goal, units);
  if (foreign.length) fail("the examiner changed product or state files: " + foreign.join(", "));
  const { checks, findings, holdout } = defineInput(units, pairs);
  const written = dirtyPaths().filter((p) => !p.startsWith(`.swarm/${goal}/`));
  const secrets = written.filter((p) => SECRET.test(p));
  if (secrets.length) fail(`refusing to commit files that look like secrets: ${secrets.join(", ")}`);
  for (const [uid, command] of checks) units = putUnit(units, { ...getUnit(units, uid), check: command });
  saveUnits(goal, units);
  if (holdout !== null) write(path.join(holdoutDir(goal), "command"), holdout + "\n");
  findings.forEach(([uid, text]) => log(goal, uid, "examiner-finding", text));
  if (written.length) {
    log(goal, goal, "test-files", written.join(", "));
    git(["add", "--", ...written]);
  }
  markDefined(goal, units);
  save(goal, `tests for ${[...checks.keys()].join(", ") || "holdout"}`);
  say(`checks recorded for ${[...checks.keys()].join(", ") || "none"}`);
}

function baselineUnit(goal, unit, earlier) {
  if (!run(checkCommand(goal, unit), root())[0]) return null;
  if (earlier.includes(unit.unit)) {
    updateUnit(goal, unit.unit, { event: "stuck", note: "tests pass before any change, twice",
      fields: { state: "stuck", note: "tests pass before any change; the examiner could not strengthen them" } });
    return null;
  }
  log(goal, unit.unit, "baseline-pass");
  return unit.unit;
}

function cmdBaseline(goal) {
  require(goal, "defined");
  onSwarm(goal);
  const pending = openFindings(entries(goal), loadUnits(goal));
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

/** Each leased unit, whether its worktree still exists, and how long ago it was leased. */
function leases(goal, units, rows) {
  return units.filter((u) => u.state === "leased").map((u) => {
    const at = rows.filter((e) => e.subject === u.unit && e.event === "leased").pop()?.ts;
    return { unit: u.unit, worktree: exists(worktreePath(goal, u.unit)), minutes: at ? (Date.now() - Date.parse(at)) / 60_000 : Infinity };
  });
}

/** The derive row. Without gates, STOP and the bounds are left out: a command asks where the goal stands, not
 * whether the loop may run on. */
function currentRow(goal, { gates = true } = {}) {
  const text = contractText(goal);
  const units = loadUnits(goal);
  const rows = entries(goal);
  const header = parseHeader(text);
  const proven = settledCriteria(rows);
  const now = fingerprint(units, rows);
  const state = {
    stop: gates && stopped(),
    bound: gates ? boundHit(rows, { budget: budget(goal), bounds: userBounds(), current: now, unitCount: units.length }) : null,
    has_contract: true,
    lint: lintProblems(text, units), events: goalEvents(rows), units,
    max_parallel: parseInt(header.max_parallel, 10) || 3, autonomy: header.autonomy || "ask",
    unproven: criteria(text).filter((c) => !proven.has(c)),
    open_findings: openFindings(rows, units),
    phases: Object.fromEntries(units.filter((u) => u.state === "produced").map((u) => [u.unit, unitPhase(rows, u.unit)])),
    fix_exists: rows.some((e) => e.event === "auto-fix"),
    orphans: orphanedLeases(leases(goal, units, rows), userBounds().lease_minutes),
  };
  return { row: derive(state), now };
}

/** Fails unless the goal stands at this action, so no command can skip ahead of the derive table. */
function requireRow(goal, action, what) {
  const [row, at] = currentRow(goal, { gates: false }).row;
  if (at !== action) fail(`${what} only at row \`${action}\`; the goal is at row ${row} \`${at}\``);
}

function cmdPeek(goal) {
  if (!exists(goalDir(goal))) {
    requireBranch(goal);
    return say("row 2 scope: run `new`, write contract.md and plan.md, then `lint`");
  }
  const [row, action, detail] = currentRow(goal).row;
  say(`row ${row} ${action}: ${detail}`);
}

/** A lease whose worktree is gone or that outlived lease_minutes goes back to planned. */
function reclaimLeases(goal) {
  const units = loadUnits(goal);
  for (const uid of orphanedLeases(leases(goal, units, entries(goal)), userBounds().lease_minutes)) {
    removeWorktreeFor(`unit/${goal}/${uid}`);
    // The note keeps the last failure reason, which the next worker reads first.
    updateUnit(goal, uid, { event: "planned", note: "lease lost", fields: { state: "planned" } });
    save(goal, `${uid} lease lost`);
    say(`${uid}: leased -> planned (lease lost)`);
  }
}

/** Under `auto`, stuck units drop, and so do the units they block. */
function autoDrop(goal) {
  const units = loadUnits(goal);
  for (const u of units.filter((x) => x.state === "stuck")) moveUnit(goal, u.unit, "dropped", `auto: ${u.note}`);
  for (const [uid, deps] of blockers(units)) moveUnit(goal, uid, "dropped", `auto: blocked by ${deps.join(", ")}`);
}

/** Rows that need no judgment are done here, so the orchestrator never sees them. */
const AUTOMATIC = { orphans: reclaimLeases, "auto-drop": autoDrop };

function settle(goal) {
  for (let action = currentRow(goal).row[1]; action in AUTOMATIC; action = currentRow(goal).row[1]) AUTOMATIC[action](goal);
}

const WAITING = ["approve", "wait", "interrupt"];

function cmdNext(goal) {
  if (!exists(goalDir(goal))) return cmdPeek(goal);
  settle(goal);
  const { row: [row, action, detail], now } = currentRow(goal);
  // A row that waits on a human or on workers isn't a loop, so it doesn't count toward the bounds.
  if (!WAITING.includes(action)) {
    log(goal, goal, "pass", now);
    save(goal, `pass: row ${row}`);
  }
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
  const dirs = uids.map((uid) => makeWorktree(goal, uid));
  uids.forEach((uid) => updateUnit(goal, uid, { event: "leased", fields: { state: "leased" } }));
  save(goal, `lease ${uids.join(" ")}`);
  uids.forEach((uid, i) => say(`leased ${uid}: worktree ${dirs[i]}`));
}

/** A unit's check as a runnable command; `@test` means the contract's test command. */
const checkCommand = (goal, unit) => resolveCheck(unit.check, parseHeader(contractText(goal)).test);

function commitsAhead(goal, uid) {
  const ref = `unit/${goal}/${uid}`;
  const known = git(["rev-parse", "--verify", "--quiet", ref], { check: false }).code === 0;
  return known ? parseInt(out(["rev-list", "--count", `swarm/${goal}..${ref}`]), 10) : 0;
}

/** Runs fn in a throwaway detached checkout of ref, after the contract's setup, and always removes it. */
function inTempWorktree(goal, ref, fn) {
  const tree = userDir("work", goal, `temp-${ref.replaceAll("/", "-")}`);
  git(["worktree", "remove", "--force", tree], { check: false });
  rmrf(tree);
  fs.mkdirSync(path.dirname(tree), { recursive: true });
  git(["worktree", "add", "-q", "--detach", tree, ref]);
  try {
    const setup = runSetup(goal, tree);
    return setup[0] ? fn(tree) : [false, `setup failed:\n${setup[1]}`];
  } finally {
    git(["worktree", "remove", "--force", tree], { check: false });
  }
}

const runInWorktree = (goal, ref, command) => inTempWorktree(goal, ref, (tree) => run(command, tree));

/** A setup that fails, or leaves files git would see, would break every lease, so approve tries it first. */
function setupProblem(goal) {
  if (!parseHeader(contractText(goal)).setup) return null;
  const [ok, output] = inTempWorktree(goal, "HEAD", (tree) => {
    const seen = parsePorcelainZ(git(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: tree }).stdout);
    return [!seen.length, `setup leaves files git doesn't ignore; gitignore them: ${seen.slice(0, 5).join(", ")}`];
  });
  return ok ? null : output;
}

function cmdCheck(goal, uid) {
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "produced") fail(`${uid} is ${unit.state}, not produced`);
  const ref = `unit/${goal}/${uid}`;
  const changed = git(["diff", "--name-only", "-z", `swarm/${goal}...${ref}`]).stdout.split("\0").filter(Boolean);
  const violations = scopeViolations(changed, scopeGlobs(unit.scope));
  const touched = testViolations(changed, examinerFiles(goal));
  const [ok, output] = runInWorktree(goal, ref, checkCommand(goal, unit));
  const problem = !changed.length ? "no changes" : touched.length ? `changes the examiner's tests: ${touched.join(", ")}`
    : violations.length ? `outside scope: ${violations.join(", ")}` : ok ? null : `check fails: ${lastLine(output)}`;
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
  // State files count: every script write is committed at once, so any diff in .swarm/<goal>/ came from a role.
  const dirty = dirtyPaths();
  if (!dirty.length) return;
  const tracked = dirty.filter((p) => out(["ls-files", "--", p]));
  // A stash, not a restore: if the change was a person's and not the verifier's, nothing is lost.
  if (tracked.length) git(["stash", "push", "-q", "-m", `zerg ${goal}: tree changes found at review`, "--", ...tracked], { check: false });
  const leftover = dirty.filter((p) => !tracked.includes(p));
  log(goal, goal, "verifier-wrote", dirty.join(", "));
  git(["add", "--", path.join(".swarm", goal, "log.md")]);
  commitState(`swarm ${goal}: restore after a verifier write`);
  fail(`the tree changed during review (${dirty.join(", ")}); tracked changes saved in \`git stash list\`` +
    (leftover.length ? `; remove these untracked files by hand: ${leftover.join(", ")}` : "") + ". Rerun that verifier once.");
}

/** A worker reports its own result. Its worktree goes away; only commits on its branch count. */
function cmdReport(goal, uid, outcome, ...text) {
  if (!["produced", "escalated", "gave_up"].includes(outcome)) fail("report outcome is produced, escalated, or gave_up");
  const note = text.join(" ").trim();
  if (!note) fail({ produced: "say what changed in one line", escalated: "give the one question a human can answer", gave_up: "say why" }[outcome]);
  const state = getUnit(loadUnits(goal), uid).state;
  if (state !== "leased") fail(`${uid} is ${state}, not leased, so this report is stale; nothing was changed`);
  if (outcome === "produced" && !commitsAhead(goal, uid)) {
    fail(`unit/${goal}/${uid} has no commits. Commit your work in the worktree, then report again; the worktree is kept`);
  }
  // State first: a crash after this leaves a stray worktree, never a lost result.
  if (outcome === "produced") moveUnit(goal, uid, "produced", note);
  else if (outcome === "escalated") moveUnit(goal, uid, "stuck", `question: ${note}`);
  else revise(goal, uid, `gave up: ${note}`);
  removeWorktreeFor(`unit/${goal}/${uid}`);
  rmrf(worktreePath(goal, uid));
}

/** A verifier records its verdict. It may not have changed anything else in the tree. */
function cmdReview(goal, subject, verdict, ...reason) {
  if (!["pass", "fail"].includes(verdict)) fail("review verdict is pass or fail");
  const note = reason.join(" ").trim();
  if (!note) fail(verdict === "pass" ? "a pass needs its strongest evidence" : "a fail needs its first blocking reason");
  onSwarm(goal);
  restoreAfterVerifier(goal);
  if (subject === "whole") {
    requireRow(goal, "whole-review", "a whole review is recorded");
    log(goal, goal, verdict === "pass" ? "whole-review" : "whole-blocking", note);
    save(goal, `whole review ${verdict}`);
    return say(`whole review: ${verdict}`);
  }
  if (getUnit(loadUnits(goal), subject).state !== "produced" || unitPhase(entries(goal), subject) !== "review") {
    fail(`${subject} isn't waiting for review; run \`peek\``);
  }
  if (verdict === "fail") return revise(goal, subject, note);
  log(goal, subject, "review-pass", note);
  save(goal, `${subject} review pass`);
  say(`${subject}: review pass; it merges next`);
}

/** A verifier's scratch folder, under the goal's work folder so hand-off and abandon remove it. */
function makeTmp(goal) {
  const dir = userDir("work", goal);
  fs.mkdirSync(dir, { recursive: true });
  return fs.mkdtempSync(path.join(dir, "verify-"));
}

/** Each criterion and what settled it, for the whole review to judge. */
function proofLines(goal) {
  const settled = settlements(entries(goal));
  const show = (e) => (e.event === "waived" ? `waived by the human: ${e.note}` : e.note);
  return criteria(contractText(goal)).map((c) => `  ${c}: ${settled.has(c) ? show(settled.get(c)) : "not settled"}`);
}

/** What a verifier reads. For the whole goal: everything after zerg's infrastructure commit, minus its own state. */
function diffCommand(goal, uid) {
  if (uid !== "whole") return `git diff ${shq(`swarm/${goal}...unit/${goal}/${uid}`)}`;
  const base = parseHeader(contractText(goal)).base;
  const infra = lines(out(["log", "--format=%H", "--grep", `^swarm ${goal}: infrastructure:`, `${base}..swarm/${goal}`])).pop();
  return `git diff ${infra ? `${infra} ${shq(`swarm/${goal}`)}` : shq(`${base}...swarm/${goal}`)} -- . ':(exclude).swarm'`;
}

/** Quotes a value for a POSIX shell. A branch name may hold `$()` or `;`. */
const shq = (/** @type {string} */ value) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The whole handoff for a subagent: identifiers and a role file, never a summary of the run. */
function cmdBrief(goal, role, uid = "-") {
  if (!ROLES.includes(role)) fail(`role is one of ${ROLES.join(", ")}`);
  const text = [`You are the zerg ${role}. Read ${path.join(SKILL_DIR, "references", role + ".md")} and follow it exactly.`,
    `Goal: ${goal}`, `Unit: ${uid}`, `MAIN: ${root()}`, `S: node "${SCRIPT}"`];
  if (role === "worker") text.push(`WORKTREE: ${worktreePath(goal, uid)}`);
  if (role === "verifier") text.push(`TMP: ${makeTmp(goal)}`, `DIFF: ${diffCommand(goal, uid)}`);
  if (role === "examiner") text.push(`HOLDOUT: ${holdoutDir(goal)}`);
  if (role === "verifier" && uid === "whole") text.push("Proofs:", ...proofLines(goal));
  const strengthen = role === "examiner" ? strengthenUnits(entries(goal), loadUnits(goal)) : [];
  if (strengthen.length) text.push(`Strengthen: ${strengthen.join(", ")}`);
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

/** A conflict makes the unit stuck. Any other merge failure is git's to report, and the unit stays as it is. */
function mergeUnit(goal, uid) {
  const merge = git(["merge", "-q", "--no-ff", "--no-edit", "--no-verify", `unit/${goal}/${uid}`], { check: false });
  if (merge.code === 0) return;
  const conflict = git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { check: false }).code === 0;
  git(["merge", "--abort"], { check: false });
  if (!conflict) fail(`git merge failed, so nothing was merged:\n${merge.stderr.trim()}`);
  moveUnit(goal, uid, "stuck", "merge conflict: the plan's scopes collide in practice");
  exit(1);
}

function cmdMerge(goal, uid) {
  onSwarm(goal);
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "produced" || unitPhase(entries(goal), uid) !== "merge") {
    fail(`${uid} must be produced, checked, and passed by a verifier before it merges`);
  }
  restoreAfterVerifier(goal);
  save(goal, "before merge");
  const before = out(["rev-parse", "HEAD"]);
  // A crash between the merge commit and the state save leaves the unit merged already; don't merge it twice.
  const merged = git(["merge-base", "--is-ancestor", `unit/${goal}/${uid}`, "HEAD"], { check: false }).code === 0;
  if (!merged) mergeUnit(goal, uid);
  // Other units' tests are still red by design (fail-first), so the full suite waits for integrate.
  // Per merge: this unit's check and every merged unit's check must pass.
  const guarded = loadUnits(goal).filter((u) => u.state === "merged" || u.unit === uid);
  const broken = guarded.filter((u) => !run(checkCommand(goal, u), root())[0]).map((u) => u.unit);
  if (broken.length && merged) {
    moveUnit(goal, uid, "stuck", `merged before a crash, and now these checks fail: ${broken.join(", ")}`);
    exit(1);
  }
  if (broken.length) {
    git(["reset", "-q", "--hard", before]);
    revise(goal, uid, `after merge these checks fail: ${broken.join(", ")}`);
    exit(1);
  }
  moveUnit(goal, uid, "merged", "checks green");
}

/** Records a human decision under the contract's Decisions section. */
function addDecision(goal, subject, text) {
  const contract = path.join(goalDir(goal), "contract.md");
  write(contract, insertDecision(read(contract), `- ${subject}: ${clean(text)}`));
}

function cmdAnswer(goal, subject, ...words) {
  const text = words.join(" ");
  if (subject !== "goal") {
    const unit = getUnit(loadUnits(goal), subject);
    if (unit.state !== "stuck") fail(`${subject} is ${unit.state}, not stuck; a blocked unit is answered through the unit blocking it`);
  }
  addDecision(goal, subject, text);
  if (subject !== "goal") {
    updateUnit(goal, subject, { event: "answered", note: text, fields: { state: "planned", revisions: "0", note: `answered: ${text}` } });
  } else log(goal, goal, "answered", text);
  save(goal, `decision for ${subject}`);
  say(`recorded decision for ${subject}`);
}

/** The examiner's findings for a unit since it was last amended. */
function pendingFindings(goal, uid) {
  const rows = entries(goal).filter((e) => e.subject === uid);
  const since = rows.map((e) => e.event).lastIndexOf("amended") + 1;
  return rows.slice(since).filter((e) => e.event === "examiner-finding").map((e) => e.note);
}

/** Route an examiner finding into the unit's task before any worker sees the unit. With no text, the log's findings. */
function cmdAmend(goal, uid, ...words) {
  const text = clean(words.join(" ") || pendingFindings(goal, uid).join("; "));
  if (!text) fail(`${uid} has no open finding; give the text to add`);
  const unit = getUnit(loadUnits(goal), uid);
  if (unit.state !== "planned") fail(`${uid} is ${unit.state}; amend a task only before its unit is leased`);
  updateUnit(goal, uid, { event: "amended", note: text, fields: { task: `${unit.task}. Also: ${text}` } });
  save(goal, `amend ${uid}`);
  say(`${uid}: task amended`);
}

/** A human decision only: widen or change a stuck unit's scope. Open units still may not overlap. */
function cmdRescope(goal, uid, scope, ...reason) {
  const units = loadUnits(goal);
  const unit = getUnit(units, uid);
  if (!["stuck", "planned"].includes(unit.state)) fail(`${uid} is ${unit.state}; only a stuck or planned unit is rescoped, after a human decides`);
  const clash = units.filter((u) => u.unit !== uid && !CLOSED.includes(u.state) && globsOverlap(scopeGlobs(scope), scopeGlobs(u.scope)))
    .map((u) => u.unit);
  if (clash.length) fail(`new scope overlaps open units: ${clash.join(", ")}`);
  const folders = folderScopeProblems([{ ...unit, scope }], isFolder);
  if (folders.length) fail(folders.join("\n"));
  const text = reason.join(" ") || "human decision";
  addDecision(goal, uid, `scope is now ${scope}: ${text}`);
  updateUnit(goal, uid, { event: "rescoped", note: `${scope}: ${text}`, fields: { scope, state: "planned", revisions: "0", note: `rescoped: ${text}` } });
  save(goal, `rescope ${uid}`);
  say(`${uid}: scope ${scope}; back to planned`);
}

// --- integrate to hand-off ---

/** Adds a fix unit F-n, which reopens integration: it runs through implement, check, review, and integrate again. */
function addFixUnit(goal, task, scope, event) {
  if (!splitList(scope).length) fail("a fix unit needs a scope");
  const folders = folderScopeProblems([{ unit: "fix", scope }], isFolder);
  if (folders.length) fail(folders.join("\n"));
  const units = loadUnits(goal);
  const open = units.filter((u) => !CLOSED.includes(u.state)).map((u) => u.unit);
  if (open.length) fail(`units still open: ${open.join(", ")}; a fix unit comes after them`);
  const id = `F-${units.filter((u) => u.unit.startsWith("F-")).length + 1}`;
  /** @type {Unit} */
  const fix = { unit: id, task, scope, after: "-", criteria: "-", check: TEST_CHECK,
    state: "planned", revisions: "0", note: "" };
  saveUnits(goal, [...units, fix]);
  log(goal, id, event, task);
  log(goal, goal, "reopened", `fix unit ${id}`);
  save(goal, `fix unit ${id}`);
  say(`added ${id}; it runs through implement, check, review, then integrate again`);
  return id;
}

/** The orchestrator's one automatic fix for a blocking whole-review finding. */
function cmdAddFix(goal, task, scope) {
  require(goal, "whole-blocking");
  if (entries(goal).some((e) => e.event === "auto-fix")) fail("add-fix runs once per goal; ask the human, who can `reopen`");
  addFixUnit(goal, task, scope, "auto-fix");
}

/** A human decision: add a fix unit after a goal-level failure (integration, or a whole review that blocks again). */
function cmdReopen(goal, task, scope, ...why) {
  require(goal, "approved");
  const reason = why.join(" ") || "human decision";
  addDecision(goal, "goal", `reopened for "${task}" (${scope}): ${reason}`);
  addFixUnit(goal, task, scope, "added");
}

/** A human decision: accept a criterion without proof, or accept the whole change despite a blocking finding. */
function cmdWaive(goal, target, ...why) {
  const reason = why.join(" ");
  if (!reason) fail("waive needs a reason; it goes in the contract and the hand-off");
  if (target === "whole") waiveWhole(goal, reason);
  else waiveCriterion(goal, target, reason);
  save(goal, `waive ${target}`);
  say(`${target}: waived`);
}

/** Accept the change despite a whole review that blocks now; it can't stand in for a review that never ran. */
function waiveWhole(goal, reason) {
  require(goal, "whole-blocking");
  if (goalEvents(entries(goal)).has("whole-review")) fail("the whole review isn't blocking; nothing to waive");
  addDecision(goal, "whole", `waived: ${reason}`);
  log(goal, goal, "whole-review", `waived: ${reason}`);
}

function waiveCriterion(goal, cid, reason) {
  const text = contractText(goal);
  if (!criteria(text).includes(cid)) fail(`no criterion ${cid}`);
  require(goal, "integrated");
  addDecision(goal, cid, `waived: ${reason}`);
  log(goal, cid, "waived", reason);
  if (criteria(text).every((c) => settledCriteria(entries(goal)).has(c))) log(goal, goal, "proved");
}

function cmdIntegrate(goal) {
  onSwarm(goal);
  const open = loadUnits(goal).filter((u) => !CLOSED.includes(u.state)).map((u) => u.unit);
  if (open.length) fail(`units still open: ${open.join(", ")}`);
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
  // After a reopen, criteria settled only by waivers stay settled, so nothing would log `proved` again.
  if (criteria(contractText(goal)).every((c) => settledCriteria(entries(goal)).has(c))) log(goal, goal, "proved");
  save(goal, "integrated");
}

function cmdProve(goal, criterion, ...command) {
  require(goal, "integrated");
  onSwarm(goal);
  const text = contractText(goal);
  if (!criteria(text).includes(criterion)) fail(`no criterion ${criterion}`);
  const evidence = command.join(" ") || criterionCommand(text, criterion);
  if (!evidence) fail(`${criterion}: the contract gives it no command, so give one`);
  if (isNoOp(evidence)) fail(`${criterion}: \`${evidence}\` passes whatever the code does, so it proves nothing`);
  const [ok, output] = run(evidence, root());
  say(output);
  if (!ok) fail(`${criterion}: evidence command failed, so it is not proven`);
  log(goal, criterion, "proof", evidence);
  if (criteria(text).every((c) => settledCriteria(entries(goal)).has(c))) log(goal, goal, "proved");
  save(goal, `proof for ${criterion}`);
}

/** Project lessons go to the project, zerg lessons go to zerg's inbox. Nothing is applied. */
function routeLearnings(goal) {
  const text = read(requireFile(goal, "learn.md"));
  if (!text.includes("## zerg") || !text.includes("## project")) {
    fail("learn.md needs a `## zerg` and a `## project` section (write `none` under an empty one)");
  }
  const lanes = splitLanes(text);
  const logLines = new Set(lines(read(path.join(goalDir(goal), "log.md"))).map((l) => l.trim()));
  const problems = learnProblems(lanes, logLines);
  if (problems.length) fail("learn.md:\n" + problems.join("\n"));
  const when = `${goal} (${stamp(false)})`;
  const routed = [];
  if (lanes.project) {
    appendBlock(path.join(root(), ".swarm", "LEARNINGS.md"), when, lanes.project);
    git(["add", "--", ".swarm/LEARNINGS.md"]);
    routed.push("project -> .swarm/LEARNINGS.md");
  }
  if (lanes.zerg) {
    withUserLock(() => appendBlock(inboxPath(), `${slug(path.basename(root()))} ${when}`, lanes.zerg));
    routed.push(`zerg -> ${inboxPath()}`);
  }
  return routed;
}

function cmdStage(goal, event, ...note) {
  /** @type {Record<string, string>} */
  const needs = { learned: "whole-review", finding: "approved" };
  if (!(event in needs)) fail(`stage is one of ${Object.keys(needs).join(", ")}`);
  require(goal, needs[event]);
  if (event === "finding" && !isFinding(note.join(" "))) fail("a finding is `file:line: what is wrong`");
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

/** Removes the goal's worktrees and scratch folders, and every unit branch already merged. Unmerged work stays. */
function cleanUp(goal) {
  for (const tree of worktrees()) {
    if ((tree.branch ?? "").startsWith(`refs/heads/unit/${goal}/`)) {
      git(["worktree", "remove", "--force", tree.worktree], { check: false });
      say(`removed worktree ${tree.worktree}`);
    }
  }
  rmrf(userDir("work", goal));
  git(["worktree", "prune"], { check: false });
  const refs = lines(out(["for-each-ref", "--format=%(refname:short)", `refs/heads/unit/${goal}/`]));
  const kept = refs.filter((ref) => git(["branch", "-q", "-d", ref], { check: false }).code !== 0);
  if (kept.length) say(`kept unmerged branches: ${kept.join(", ")}`);
}

function cmdHandoff(goal) {
  requireRow(goal, "handoff", "hand-off runs");
  const text = contractText(goal);
  const rows = entries(goal);
  const base = parseHeader(text).base;
  const proofs = Object.fromEntries(rows.filter((e) => ["proof", "waived"].includes(e.event))
    .map((e) => [e.subject, e.event === "waived" ? `WAIVED: ${e.note}` : e.note]));
  say(`branch: swarm/${goal} (base ${base})\n`);
  say(out(["diff", "--stat", `${base}...swarm/${goal}`]) + "\n");
  say("criteria:\n" + criteria(text).map((c) => `  ${c}: ${proofs[c] ?? "UNPROVEN"}`).join("\n"));
  const findings = rows.filter((e) => e.event === "finding").map((e) => `  ${e.note}`);
  say("findings:\n" + (findings.join("\n") || "  none"));
  say("units:\n" + loadUnits(goal).map((u) => `  ${u.unit}: ${u.state}, ${u.revisions} revisions`).join("\n"));
  const recorded = rows.some((e) => e.event === "tokens");
  say("tokens:\n" + (recorded ? tokenLines(rows).join("\n") : "  not recorded: the agent reported no token use for its roles"));
  say(`learn: .swarm/${goal}/learn.md`);
  say(`note: the merge also adds these .gitignore lines: ${IGNORES.join(", ")}`);
  log(goal, goal, "handed-off");
  save(goal, "handed off");
  cleanUp(goal);
  say(`holdout tests: ${holdoutDir(goal)}`);
  git(["checkout", "-q", base]);
  say(`\nchecked out ${base}. Review, then merge swarm/${goal} yourself.`);
}

/** A human decision: stop the goal for good. swarm/<goal> stays as the record; everything else zerg made goes. */
function cmdAbandon(goal, ...why) {
  const reason = why.join(" ").trim();
  if (!reason) fail("abandon needs a reason; it goes in the contract");
  if (!goalEvents(entries(goal)).has("approved")) return abandonPlan(goal);
  onSwarm(goal);
  addDecision(goal, "goal", `abandoned: ${reason}`);
  log(goal, goal, "abandoned", reason);
  save(goal, "abandoned");
  cleanUp(goal);
  rmrf(holdoutDir(goal));
  const base = parseHeader(contractText(goal)).base;
  git(["checkout", "-q", base]);
  say(`${goal}: abandoned. swarm/${goal} keeps the record; checked out ${base}.`);
}

/** Before approval nothing is branched: the plan and the folders `new` made are all there is to remove. */
function abandonPlan(goal) {
  requireFile(goal, "contract.md");
  rmrf(goalDir(goal));
  rmrf(holdoutDir(goal));
  rmrf(userDir("work", goal));
  say(`${goal}: abandoned before approval; removed .swarm/${goal}. Nothing was branched.`);
}

const LOCK_FREE = new Set(["peek", "status", "summary", "brief", "lint"]);
/** @type {Record<string, (...args: string[]) => void>} */
const USER_COMMANDS = { home: cmdHome, rules: cmdRules, inbox: cmdInbox, accept: cmdAccept, dismiss: cmdDismiss, config: cmdConfig };
/** @type {Record<string, (...args: string[]) => void>} */
const COMMANDS = {
  new: cmdNew, lint: cmdLint, approve: cmdApprove, define: cmdDefine, baseline: cmdBaseline,
  next: cmdNext, peek: cmdPeek, report: cmdReport, review: cmdReview, brief: cmdBrief, summary: cmdSummary,
  lease: cmdLease, check: cmdCheck, merge: cmdMerge,
  move: (goal, uid, target, ...note) => {
    const state = getUnit(loadUnits(goal), uid).state;
    if (!MANUAL_MOVES.includes(`${state}>${target}`)) {
      fail(`move only handles a lost lease (leased -> planned) and a drop (planned or stuck -> dropped), not ${state} -> ${target}`);
    }
    moveUnit(goal, uid, target, note.join(" "));
  },
  answer: cmdAnswer, rescope: cmdRescope, amend: cmdAmend, "add-fix": cmdAddFix, reopen: cmdReopen, waive: cmdWaive,
  abandon: cmdAbandon, integrate: cmdIntegrate, prove: cmdProve, stage: cmdStage, tokens: cmdTokens, status: cmdStatus, handoff: cmdHandoff,
};

function dispatch(command, args) {
  if (command in USER_COMMANDS) return withUserLock(() => USER_COMMANDS[command](...args));
  if (!(command in COMMANDS) || !args.length) fail(USAGE);
  const problem = argProblem(command, args);
  if (problem) fail(problem);
  // A worker calls `report` from its own worktree, which `report` deletes. Work from the main tree.
  process.chdir(root());
  return LOCK_FREE.has(command) ? COMMANDS[command](...args) : withStateLock(args[0], () => COMMANDS[command](...args));
}

/** @param {string[]} argv */
export function main(argv) {
  const [command = "", ...args] = argv;
  try {
    dispatch(command, args);
    return 0;
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    if (error.message) console.error(error.message);
    return error.code;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT) process.exitCode = main(process.argv.slice(2));
