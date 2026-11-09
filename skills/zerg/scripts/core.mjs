// @ts-check
/**
 * zerg core: the pure half of the control plane. Parsing, planning rules, the derive table, and bounds.
 * Nothing here touches the disk, git, or a shell, so all of it is covered by fast unit tests.
 */

export const IGNORES = [".swarm/.lock", ".swarm/STOP"];
// The lock is zerg's own file; it is never a role's write. Worktrees live outside the repo, in ZERG_HOME.
export const NOT_TREE = [".swarm/.lock"];
// A unit check that means "the contract's test command", resolved when it runs, so the command is stored once, verbatim.
export const TEST_CHECK = "@test";
export const GOAL_ID = /^G-[a-z0-9]+(-[a-z0-9]+)*$/;
export const UNIT_ID = /^[UF]-\d+$/;
// The only transitions a human or orchestrator may make by hand. Everything else goes through a gate.
export const MANUAL_MOVES = ["leased>planned", "stuck>dropped", "planned>dropped"];
// Files `define` refuses to commit, because the main tree may hold the user's secrets.
export const SECRET = /(^|\/)(\.env(\..*)?|[^/]*\.(pem|key|p12|pfx))$/;
export const ROLES = ["examiner", "worker", "verifier"];
export const COLUMNS = ["unit", "task", "scope", "after", "criteria", "check", "state", "revisions", "note"];
export const SECTIONS = ["Outcome", "Why", "Non-goals", "Constraints", "Criteria", "Escalate when"];
/** @type {Record<string, string[]>} */
export const TRANSITIONS = {
  planned: ["leased", "dropped", "stuck"],
  leased: ["produced", "stuck", "planned"],
  produced: ["merged", "planned", "stuck"],
  stuck: ["planned", "dropped"],
  merged: [],
  dropped: [],
};
export const CLOSED = ["merged", "dropped"];
// Defaults. A user's ~/.zerg/config (or $ZERG_HOME/config) overrides them without a skill update.
export const BOUNDS = { max_revisions: 2, max_passes: 20, no_progress: 3, lease_minutes: 60 };
// A clean unit still takes about 4 passes (implement, check, review, merge), so the cap grows with the plan.
export const PASSES_PER_UNIT = 5;

/** @typedef {{unit: string, task: string, scope: string, after: string, criteria: string, check: string, state: string, revisions: string, note: string}} Unit */
/** @typedef {{ts?: string, subject: string, event: string, note: string}} Entry */


// --- pure helpers (covered by swarm.test.mjs) ---

/** @param {string} text */
export const lines = (text) => {
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === "") all.pop();
  return all;
};

/** @param {string} text @param {string} sep @returns {[string, string, string]} */
export const partition = (text, sep) => {
  const i = text.indexOf(sep);
  return i < 0 ? [text, "", ""] : [text.slice(0, i), sep, text.slice(i + sep.length)];
};

/** Python's fnmatch: `*` matches anything (slashes too), `?` one character, `[...]` a set. */
export function fnmatch(name, pattern) {
  let re = "";
  for (let i = 0; i < pattern.length;) {
    const [part, next] = globToken(pattern, i);
    re += part;
    i = next;
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

/** @returns {[string, number]} the regex for the glob token at i, and where the next token starts */
export function globToken(pattern, i) {
  const c = pattern[i];
  if (c === "*") return [".*", i + 1];
  if (c === "?") return [".", i + 1];
  if (c === "[") return charClass(pattern, i);
  return [c.replace(/[.+^${}()|\\/-]/g, "\\$&"), i + 1];
}

/** @returns {[string, number]} */
export function charClass(pattern, i) {
  const end = pattern.indexOf("]", i + 2);
  if (end < 0) return ["\\[", i + 1];
  const set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
  return [`[${set.startsWith("!") ? "^" + set.slice(1) : set}]`, end + 1];
}

/** @param {unknown} value */
export const clean = (value) => String(value).replace(/\|/g, "/").split(/\s+/).filter(Boolean).join(" ");

/** @param {string} cell */
export const splitList = (cell) => cell.split(",").map((s) => s.trim()).filter((s) => s !== "" && s !== "-");

/** A scope cell as globs in git's path form: forward slashes, whatever the planner typed. @param {string} cell */
export const scopeGlobs = (cell) => splitList(cell).map((g) => g.replaceAll("\\", "/"));

/** Every file zerg reads goes through this, so a contract saved with CRLF parses like any other. */
export const normalizeNewlines = (text) => text.replace(/\r\n?/g, "\n");

/** Paths from `git status --porcelain -z`: never quoted, and a rename yields its new path only. */
export function parsePorcelainZ(output) {
  const items = output.split("\0");
  const paths = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]) continue;
    paths.push(items[i].slice(3));
    if (/[RC]/.test(items[i].slice(0, 2))) i++;
  }
  return paths;
}

/** A repo name as one word, so ids built from it split cleanly. */
export const slug = (name) => name.trim().replace(/\s+/g, "-") || "repo";

/** The command a unit's check runs. @param {string} check @param {string} test */
export const resolveCheck = (check, test) => (check === TEST_CHECK ? test : check);

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

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
  const globs = units.filter((u) => splitList(u.criteria).includes(cid)).flatMap((u) => scopeGlobs(u.scope));
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
export const WILD = /[*?[\]]/;
/** True when some path could match both globs. Literal globs compare exactly; wildcard globs compare their
 * literal prefix and suffix, so `src/*.js` and `src/a*` overlap while `src/*.js` and `src/*.py` don't. */
export function globOverlap(a, b) {
  if (!WILD.test(a) || !WILD.test(b)) return WILD.test(a) ? fnmatch(b, a) : WILD.test(b) ? fnmatch(a, b) : a === b;
  const prefix = (g) => g.split(WILD)[0];
  const suffix = (g) => g.slice(Math.max(g.lastIndexOf("*"), g.lastIndexOf("?"), g.lastIndexOf("]")) + 1);
  const [pa, pb, sa, sb] = [prefix(a), prefix(b), suffix(a), suffix(b)];
  return (pa.startsWith(pb) || pb.startsWith(pa)) && (sa.endsWith(sb) || sb.endsWith(sa));
}

/** @param {string[]} left @param {string[]} right */
export const globsOverlap = (left, right) => left.some((a) => right.some((b) => globOverlap(a, b)));

export const SHELL_META = /[;&|<>$`()\n]/;

/** Splits a command into argv the way a POSIX shell would for plain words and quotes.
 * Returns null if the command uses any shell operator or expansion, so it can run without a shell. */
export function shellWords(command) {
  const state = { words: [], word: null, quote: "" };
  for (const c of command) {
    if (!shellStep(state, c)) return null;
  }
  if (state.quote) return null;
  endWord(state);
  return state.words;
}

export function shellStep(state, c) {
  if (state.quote === "'") return quoted(state, c);
  if (SHELL_META.test(c)) return false;
  if (state.quote === '"') return quoted(state, c);
  if (c === "'" || c === '"') return openQuote(state, c);
  if (/\s/.test(c)) return endWord(state);
  state.word = (state.word ?? "") + c;
  return true;
}

export function quoted(state, c) {
  if (c === state.quote) state.quote = "";
  else state.word += c;
  return true;
}

export function openQuote(state, c) {
  state.quote = c;
  state.word ??= "";
  return true;
}

export function endWord(state) {
  if (state.word !== null) state.words.push(state.word);
  state.word = null;
  return true;
}

/** A grep criterion as argv, or null when it isn't one plain grep command. */
export function grepArgv(command) {
  const argv = shellWords(command);
  return argv && argv[0] === "grep" ? ["grep", "-H", ...argv.slice(1)] : null;
}

/** Changed files that the examiner wrote: no unit may touch them, whatever its scope says. */
export const testViolations = (changed, testFiles) => changed.filter((p) => testFiles.includes(p));

export const isUnitId = (id) => UNIT_ID.test(id ?? "");
export const ARG_KINDS = {
  unit: isUnitId,
  "unit|whole": (id) => id === "whole" || isUnitId(id),
  "unit|goal": (id) => id === "goal" || isUnitId(id),
  "unit|-": (id) => id === undefined || id === "-" || id === "whole" || isUnitId(id),
  word: (id) => /^[\w.-]+$/.test(id ?? ""),
  "criterion|whole": (id) => id === "whole" || /^C\d+$/.test(id ?? ""),
};
/** What each command's arguments after the goal must be. A null slot is free text. */
export const ARG_SHAPES = {
  report: ["unit"], produced: ["unit"], check: ["unit"], merge: ["unit"], revise: ["unit"], move: ["unit"],
  amend: ["unit"], rescope: ["unit"], review: ["unit|whole"], answer: ["unit|goal"], brief: [null, "unit|-"], tokens: ["word"],
  waive: ["criterion|whole"],
};

/** Every id a command receives, checked before it can reach a path, a branch name, or rm. */
export function argProblem(command, args) {
  const [goal, ...rest] = args;
  if (!GOAL_ID.test(goal ?? "")) return `goal id must look like G-short-slug, not ${JSON.stringify(goal ?? "")}`;
  const shape = command === "lease" ? rest.map(() => "unit") : ARG_SHAPES[command] ?? [];
  const at = shape.findIndex((kind, i) => kind && !ARG_KINDS[kind](rest[i]));
  if (at < 0) return null;
  const what = { word: "token subject must be a plain word", "criterion|whole": "waive takes a criterion like C1, or whole" }[shape[at]]
    ?? "unit id must look like U-001 or F-1";
  return `${what}, not ${JSON.stringify(rest[at] ?? "")}`;
}

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
export function rowProblems(unit, ids, crits) {
  const uid = unit.unit;
  return [
    ...(UNIT_ID.test(uid) ? [] : [`${uid}: unit id must look like U-001`]),
    ...(scopeGlobs(unit.scope).length ? [] : [`${uid}: empty scope`]),
    ...splitList(unit.after).filter((d) => !ids.includes(d)).map((d) => `${uid}: unknown after ${d}`),
    ...splitList(unit.criteria).filter((c) => !crits.includes(c)).map((c) => `${uid}: unknown criterion ${c}`),
  ];
}

/** @param {Unit[]} units @param {string[]} crits */
export function planProblems(units, crits) {
  const ids = units.map((u) => u.unit);
  const problems = units.length ? [] : ["plan: no units"];
  problems.push(...[...new Set(ids.filter((i) => ids.indexOf(i) !== ids.lastIndexOf(i)))].sort().map((i) => `plan: duplicate unit ${i}`));
  units.forEach((u) => problems.push(...rowProblems(u, ids, crits)));
  const covered = new Set(units.flatMap((u) => splitList(u.criteria)));
  problems.push(...crits.filter((c) => !covered.has(c)).map((c) => `plan: criterion ${c} has no unit`));
  units.forEach((a, i) => units.slice(i + 1).forEach((b) => {
    if (globsOverlap(scopeGlobs(a.scope), scopeGlobs(b.scope))) problems.push(`plan: scopes overlap: ${a.unit} and ${b.unit}`);
  }));
  try {
    mergeOrder(units.filter((u) => splitList(u.after).every((d) => ids.includes(d))));
  } catch {
    problems.push("plan: after has a cycle");
  }
  return problems;
}

/** @param {string} text @param {Unit[]} units */
/** Adds a decision line at the end of `## Decisions`, wherever that section sits; creates the section if it's missing. */
export function insertDecision(text, line) {
  const lines_ = text.trimEnd().split("\n");
  const at = lines_.findIndex((l) => l.trim() === "## Decisions");
  if (at < 0) return `${text.trimEnd()}\n\n## Decisions\n${line}\n`;
  const next = lines_.findIndex((l, i) => i > at && l.startsWith("## "));
  const end = next < 0 ? lines_.length : next;
  let insertAt = end;
  while (insertAt > at + 1 && !lines_[insertAt - 1].trim()) insertAt--;
  lines_.splice(insertAt, 0, line);
  return lines_.join("\n") + "\n";
}

/** Parts of the plan still holding the template's text: the title, a section's example prose, the example rows.
 * @param {string} text the contract @param {string} template the contract template @param {Unit[]} units */
export function templateProblems(text, template, units) {
  const title = /<[^>]+>/.test(lines(text)[0] ?? "") ? ["contract: the title is still a placeholder"] : [];
  const sections = SECTIONS.filter((name) => isTemplateSection(text, template, name))
    .map((name) => `contract: ## ${name} still has the template's example text`);
  const rows = units.filter(isTemplateRow).map((u) => `${u.unit}: still the template's example row`);
  return [...title, ...sections, ...rows];
}

const isTemplateSection = (text, template, name) => {
  const body = section(text, name).trim();
  return Boolean(body) && body === section(template, name).trim();
};

const isTemplateRow = (u) => u.task === "one sentence" || /^path\/[ab]\.py$/.test(u.scope);

/** Units whose tests passed before any work and haven't been strengthened since. The examiner's brief names them. */
export function strengthenUnits(rows, units) {
  if (rows.some((e) => e.event === "baseline")) return [];
  const passed = new Set(rows.filter((e) => e.event === "baseline-pass").map((e) => e.subject));
  return units.filter((u) => u.state === "planned" && passed.has(u.unit)).map((u) => u.unit);
}

/** max_parallel must be 1 or more and token_budget a whole number, when they're set at all. */
const wholeNumberAtLeast = (value, min) => /^\d+$/.test(value) && parseInt(value, 10) >= min;

export function numberProblems(header) {
  const problems = [];
  const parallel = header.max_parallel;
  if (parallel && !wholeNumberAtLeast(parallel, 1)) problems.push("contract: max_parallel must be a whole number of 1 or more");
  const budget = header.token_budget;
  if (budget && !wholeNumberAtLeast(budget, 0)) problems.push("contract: token_budget must be a whole number");
  return problems;
}

export function lintProblems(text, units) {
  const header = parseHeader(text);
  const problems = SECTIONS.filter((s) => !section(text, s).trim()).map((s) => `contract: empty section ## ${s}`);
  problems.push(...["base", "test"].filter((k) => !header[k]).map((k) => `contract: missing header ${k}`));
  problems.push(...Object.entries(header).filter(([, v]) => v.startsWith("<") && v.endsWith(">"))
    .map(([k]) => `contract: header ${k} is still a placeholder`));
  problems.push(...numberProblems(header));
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
/** Planned units waiting on a dependency that is stuck or dropped, with the dependencies that block them. */
export function blockers(units) {
  const byId = new Map(units.map((u) => [u.unit, u]));
  const blocking = (u) => splitList(u.after).filter((d) => byId.has(d) && ["dropped", "stuck"].includes(byId.get(d).state));
  return new Map(units.filter((u) => u.state === "planned" && blocking(u).length).map((u) => [u.unit, blocking(u)]));
}

/** @param {Unit[]} units */
export const blockedUnits = (units) => [...blockers(units).keys()];

/** Row 9's detail: which units are stuck, and which wait on them. A blocked unit is resolved through its blocker. */
export function stuckDetail(units) {
  const stuck = idsIn(units, "stuck").map((uid) => `${uid} (stuck)`);
  const blocked = [...blockers(units)].map(([uid, deps]) => `${uid} (blocked by ${deps.join(", ")})`);
  return [...stuck, ...blocked].join(" ");
}

/** A lease is orphaned when its worktree is gone or it has outlived lease_minutes; otherwise its worker is still working.
 * @param {{unit: string, worktree: boolean, minutes: number}[]} leases */
export const orphanedLeases = (leases, maxMinutes) =>
  leases.filter((l) => !l.worktree || l.minutes > maxMinutes).map((l) => l.unit);

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
    if (e.event === "reopened") ["integrated", "integrate-failed", "proved", "whole-blocking", "whole-review"].forEach((x) => events.delete(x));
    events.add(e.event);
  }
  return events;
}

/** @param {{event: string, note: string}[]} entries */
export const tokenTotal = (entries) =>
  entries.filter((e) => e.event === "tokens").reduce((sum, e) => sum + parseInt(e.note.split(/\s+/).pop() ?? "0", 10), 0);

/** @param {{event: string, note: string}[]} entries */
export function boundHit(entries, { budget = 0, bounds = BOUNDS, current = null, unitCount = 0 } = {}) {
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
export const idsIn = (units, state) => units.filter((u) => u.state === state).map((u) => u.unit);

/** Rows 0 to 3: stop signals and the plan gate. */
export function deriveGates(s) {
  if (s.stop) return [0, "stop", ".swarm/STOP is present"];
  if (s.bound) return [1, "stop", s.bound];
  if (!s.has_contract) return [2, "scope", "run `new`, write contract.md and plan.md, then `lint`"];
  if (s.events.has("approved")) return null;
  if (s.lint.length) return [2, "plan", s.lint.join("; ")];
  return [3, "approve", "show `summary`; ask the human; then `approve`"];
}

export const needsDefine = (s) => !s.events.has("defined") || s.units.some((u) => !u.check && !CLOSED.includes(u.state));

/** Rows 4 and 5: tests exist, findings are routed, and every check fails first. */
export function derivePrep(s) {
  if (needsDefine(s)) return [4, "define", "run the examiner: `brief <goal> examiner`; it records its checks with `define`"];
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
export function deriveUnits(s) {
  const produced = idsIn(s.units, "produced");
  for (const phase of ["check", "review", "merge"]) {
    const due = produced.filter((uid) => s.phases[uid] === phase);
    if (due.length) return [6, phase, due.join(" ")];
  }
  const orphans = s.orphans ?? idsIn(s.units, "leased");
  if (orphans.length) return [7, "orphans", orphans.join(" ")];
  const ready = readyUnits(s.units, s.max_parallel);
  if (ready.length) return [8, "implement", ready.join(" ")];
  const leased = idsIn(s.units, "leased");
  if (leased.length) return [7, "wait", `${leased.join(" ")} still leased; wait for those workers to report`];
  const detail = stuckDetail(s.units);
  if (detail) return [9, s.autonomy === "auto" ? "auto-drop" : "interrupt", detail];
  return null;
}

/** Rows 10 to 15: integration to hand-off. */
export function deriveClose(s) {
  const ev = s.events;
  // Goal-level decisions belong to the human under every autonomy setting: auto only drops units.
  if (ev.has("integrate-failed")) return [9, "interrupt", "goal: integration failed; `reopen` with a fix unit, or stop"];
  if (!ev.has("integrated")) return [10, "integrate", "run `integrate`"];
  if (!ev.has("whole-review")) {
    if (ev.has("whole-blocking")) {
      if (s.fix_exists) return [9, "interrupt", "goal: the whole review is blocking again; `reopen`, `waive <goal> whole`, or stop"];
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
export const derive = (s) => deriveGates(s) ?? derivePrep(s) ?? deriveUnits(s) ?? deriveClose(s);

/** Changes whenever anything but a pass or a token count is logged, so every check, review, or answer is progress. */
export function fingerprint(units, rows) {
  const work = rows.filter((e) => e.event !== "pass" && e.event !== "tokens").length;
  return clean(units.map((u) => `${u.unit}:${u.state}:${u.revisions}`).join(",") + ` work:${work}`);
}

/** @param {string[]} changed @param {string[]} globs */
export const scopeViolations = (changed, globs) => changed.filter((p) => !globs.some((g) => fnmatch(p, g)));
