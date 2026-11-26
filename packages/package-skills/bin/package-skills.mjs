#!/usr/bin/env node
// package-skills: installs the skills of the packages the `devSkills` field of the repository's
// root `package.json` lists (every package alike, none is special), into a repository, as
// `.claude/skills/<skill>` and `.agents/skills/<skill>`, so an agent finds them where it looks
// (agents do not scan `node_modules`). In a lab `.claude/skills` is a committed symbolic link to
// `../.agents/skills` (lab D19): the command then installs once, into `.agents/skills`, and
// reports one target. Any other link in `.claude`, `.agents`, `.claude/skills` or
// `.agents/skills` is refused, so a link the agent planted never makes the command write or
// delete outside the repository's skill folders. By default each is a copy; with `--link` each is a
// relative symbolic link into the installed package (`node_modules/<package>/skills/<skill>`
// when the package is installed there, so the link survives an upgrade). Copies are the default
// because `validate-md` reads no template through a symbolic link and Node strips no types from
// a `*.refine.ts` under `node_modules`: with links, documents bound to the skills' templates stay
// unbound.
//
// `devSkills` is required: it is the person's list, so a new dependency never adds agent
// instructions unseen. It is an array of package names (every skill of each) or an object of package
// names to a selection: `"*"` (every skill, those the package adds later too), a list of the skills to
// install, or `{ "exclude": [...] }` (all but those). A name the package does not ship fails the run, and
// nothing is changed. The key of the 0.8 line, `installSkills` (an array), is read when `devSkills` is
// absent, with a warning; a root with both fails. Without the field (or without a readable root `package.json`) nothing is
// installed, from no package; the command names the packages that export skills
// and fails (exit 1). What an earlier run installed stays as it is, neither removed nor refreshed,
// and its record is not rewritten. An empty list is valid: it installs nothing and removes what an
// earlier run installed.
//
// A listed package must be one the root `package.json` declares in `dependencies` or
// `devDependencies` (an undeclared or hoisted transitive package is ignored) whose `exports`
// has `./skills/*`; its skills come from the folder that export maps to. A package declared as an
// npm alias (`"<key>": "npm:<package>@<range>"`) is listed, selected and recorded by its key; the
// installed manifest must name the alias's target. A skill name two
// packages provide (after the selection) is installed or refreshed from neither (a copy already installed
// stays) and reported (exit 1); selecting the skill from one package settles it. A skill an earlier run
// installed and the list no longer selects is removed, like one its package dropped.
//
// Each target folder keeps a record of what was installed there, `.package-skills.json` (the older
// `.install-skills.json` is read once and replaced by it), with a
// hash of each copy and the package each skill came from. Running the command again after an upgrade refreshes what the record lists
// (and links that point into `<root>/node_modules/<package>/`) and removes those of skills the
// package no longer has. Anything else of the same name is left alone and reported, and so is a
// copy changed since it was installed (`--force` replaces it); either makes the run fail. Each
// target also gets a generated `.gitignore` that lists the record, itself and one line per skill
// it installed there and nothing else, so Git tracks every skill that is not an installed one
// (the person's, the agent's, one from skills.sh). Every run prints the skills it installed for
// the first time and those it removed. Plain Node, no dependencies.
//
//   package-skills [--check] [--link] [--force] [--root <dir>]
//
// `--check` plans the same run and writes nothing: it prints one line per change (a skill to install,
// refresh or remove, a record or `.gitignore` to write) and per finding a run would leave alone and
// fail on, and exits 0 when there is none, 1 when there is any, 2 on a usage error or a layout a run
// refuses. A skill a listed package ships and the list leaves out is reported too, as available, not
// selected; it changes nothing and does not fail. The run is a plan (`planInstall`) and its application (`applyPlan`); `--check` stops
// after the plan.
//
// `--root` is the repository to install into: by default the nearest folder above the current
// directory that holds `.git`, else the current directory.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folders of a repository the skills are installed into, relative to its root. */
export const TARGETS = ['.claude/skills', '.agents/skills'];

/** The record of what was installed, kept in each target folder. */
export const RECORD = '.package-skills.json';

/** The record of the 0.8 line (the package was called install-skills): read once, replaced by RECORD. */
export const LEGACY_RECORD = '.install-skills.json';

/** The generated ignore file in each target folder: the skills installed there, and nothing else. */
export const GITIGNORE = '.gitignore';

/** What `.claude/skills` holds in a lab: the one link package-skills accepts (lab D19). */
export const LINK_TARGET = '../.agents/skills';

/** What a package name may look like when it is used as a path under `node_modules`. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** What an npm alias spec looks like (`npm:<target>` or `npm:<target>@<range>`): the target is the installed package's name. */
const NPM_ALIAS = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@.*)?$/;

/** What a skill name may look like: it goes into a path and into the generated `.gitignore`. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Quotes a name from a file the agent can write, so a control character never reaches the terminal raw. */
const shown = (text) => JSON.stringify(String(text));

const USAGE = `Usage: package-skills [--check] [--link] [--force] [--root <dir>]
Installs the skills of the packages the root package.json lists in devSkills: an array of package names
(every skill of each), or an object of package names to "*", a list of skills, or { "exclude": [...] }.
`;

/**
 * Lists the skills of the package: the folders under `skills/` that hold a `SKILL.md`.
 * @param {string} packageRoot - The package's folder.
 * @returns {string[]} The skill names, sorted.
 */
export function listSkills(packageRoot) {
  return listSkillFolders(join(packageRoot, 'skills'));
}

/**
 * Lists the skill folders under a folder: the subfolders that hold a `SKILL.md`.
 * @param {string} folder - The skills folder.
 * @returns {string[]} The skill names, sorted.
 */
function listSkillFolders(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Finds the folder a package's `./skills/*` export maps to.
 * @param {string} packageDir - The package's folder.
 * @param {{ exports?: unknown }} pkg - Its parsed `package.json`.
 * @returns {string | undefined} The folder, or undefined when the package exports no skills.
 */
function skillsFolderOf(packageDir, pkg) {
  const exported = pkg.exports?.['./skills/*'];
  const target = typeof exported === 'string' ? exported : exported?.default;
  if (typeof target !== 'string' || !target.includes('*') || !target.startsWith('./')) {
    return undefined;
  }
  const prefix = target.slice(0, target.indexOf('*'));
  if (prefix.split('/').includes('..')) return undefined;
  const folder = join(packageDir, prefix);
  if (!existsSync(folder)) return undefined;
  // the folder must stay inside the package even through symbolic links
  const inside = relative(realpathSync(packageDir), realpathSync(folder));
  return inside.startsWith('..') || isAbsolute(inside) ? undefined : folder;
}

/**
 * Reads the packages the root `package.json` declares in `dependencies` or `devDependencies`, with
 * the name each must carry once installed.
 * @param {string} root - The repository root.
 * @returns {{ key: string, alias?: string }[]} One entry per declared key; `alias` is the target
 * of an npm alias (`"<key>": "npm:<target>@<range>"`), whose installed manifest is named
 * after the target, not the key.
 */
function declaredEntries(root) {
  try {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const specs = { ...rootPackage.devDependencies, ...rootPackage.dependencies };
    return Object.keys(specs)
      .sort()
      .map((key) => {
        const alias = typeof specs[key] === 'string' ? NPM_ALIAS.exec(specs[key])?.[1] : undefined;
        return alias === undefined ? { key } : { key, alias };
      });
  } catch {
    return [];
  }
}

/**
 * Finds the packages installed in a repository that export skills, and those whose installed
 * manifest names another package than the one the root declares.
 * @param {string} root - The repository root.
 * @returns {{ found: { name: string, version: string, folder: string, skillsFolder: string }[], mismatched: { declared: string, name: string, alias?: string }[] }}
 * Each package the root `package.json` declares in `dependencies` or `devDependencies` (under a
 * name that is a safe path below `node_modules`), installed there, whose `exports` has
 * `./skills/*`, keyed by the declared name, with the folder that export maps to; and each such
 * package whose manifest `name` differs from the declared one (skipped). A key declared as an npm
 * alias (`npm:<target>@<range>`) is installed under the target's name: that is the name its manifest
 * must carry, and the package is still keyed by the declared key.
 */
function scanSkillPackages(root) {
  const declared = declaredEntries(root);
  const found = [];
  const mismatched = [];
  for (const { key: dependency, alias } of declared) {
    // the key becomes a path: a `..` in it would read outside node_modules
    if (!PACKAGE_NAME.test(dependency)) continue;
    const folder = join(root, 'node_modules', ...dependency.split('/'));
    try {
      const pkg = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
      const skillsFolder = skillsFolderOf(folder, pkg);
      if (skillsFolder === undefined) continue;
      if (pkg.name !== (alias ?? dependency)) {
        mismatched.push({ declared: dependency, name: pkg.name, ...(alias && { alias }) });
      } else {
        found.push({ name: dependency, version: pkg.version, folder, skillsFolder });
      }
    } catch {
      // not installed, or not a package folder
    }
  }
  found.sort((left, right) => (left.name < right.name ? -1 : 1));
  return { found, mismatched };
}

/**
 * Finds the packages installed in a repository that export skills.
 * @param {string} root - The repository root.
 * @returns {{ name: string, version: string, folder: string, skillsFolder: string }[]} Each
 * package the root `package.json` declares in `dependencies` or `devDependencies`, installed in
 * `<root>/node_modules`, whose `exports` has `./skills/*`, with the folder that export maps to.
 * Its `name` is the declared key; a package whose manifest says another name is left out.
 */
export function discoverSkillPackages(root) {
  return scanSkillPackages(root).found;
}

/**
 * Finds the repository root: the nearest folder from `start` upward that holds `.git`.
 * @param {string} start - The folder to start from.
 * @returns {string} That folder, or `start` when none holds `.git`.
 */
export function findRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}

/**
 * Reads what is at a path without following a final symbolic link.
 * @param {string} path - The path.
 * @returns {'none' | 'link' | 'dir' | 'other'} What is there.
 */
function kindOf(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'link';
    return stat.isDirectory() ? 'dir' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'none';
    throw error;
  }
}

/**
 * Removes whatever is at a path (a link is removed itself, never followed) and writes a regular
 * file there, so a link planted at the path never makes the write land elsewhere.
 * @param {string} path - The file's path.
 * @param {string} text - Its content.
 */
function writeFresh(path, text) {
  rmSync(path, { recursive: true, force: true });
  writeFileSync(path, text, { flag: 'wx' });
}

/**
 * Decides which folders of a repository receive the skills, and refuses a layout in which a
 * symbolic link could redirect what the command writes or deletes.
 * @param {string} root - The repository root.
 * @returns {{ targets: string[], linked: boolean } | { problem: string }} The folders to install
 * into (one, `.agents/skills`, when `.claude/skills` is the lab's link to it) or why none is safe.
 */
export function resolveTargets(root) {
  for (const parent of ['.claude', '.agents']) {
    if (kindOf(join(root, parent)) === 'link') {
      return {
        problem: `${parent} is a symbolic link; package-skills writes only into real folders`,
      };
    }
    if (kindOf(join(root, parent)) === 'other') {
      return { problem: `${parent} is not a folder` };
    }
  }
  const agents = kindOf(join(root, '.agents/skills'));
  if (agents === 'link' || agents === 'other') {
    return {
      problem: `.agents/skills is ${agents === 'link' ? 'a symbolic link' : 'not a folder'}; package-skills writes only into real folders`,
    };
  }
  const claude = kindOf(join(root, '.claude/skills'));
  if (claude === 'link') {
    const held = readlinkSync(join(root, '.claude/skills'));
    if (held !== LINK_TARGET) {
      return {
        problem: `.claude/skills is a link to ${held}; a lab links it to ${LINK_TARGET} and nothing else (remove it, or point it there)`,
      };
    }
    return { targets: ['.agents/skills'], linked: true };
  }
  if (claude === 'other') return { problem: '.claude/skills is not a folder' };
  return { targets: [...TARGETS], linked: false };
}

const DEV_SKILLS_SHAPE =
  '`devSkills` in package.json must be an array of package names, or an object of package names to "*", a list of skill names or { "exclude": [skill names] }';

/** Tells whether a value is a list of non-empty strings. */
const isNames = (value) =>
  Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');

/**
 * Reads the list of the root `package.json`: `devSkills`, or the 0.8 line's `installSkills` when
 * `devSkills` is absent.
 * @param {string} root - The repository root.
 * @returns {{ field: undefined | Map<string, { kind: 'all' } | { kind: 'only', names: string[] } | { kind: 'exclude', names: string[] }>, names?: string[], legacy?: boolean } | { problem: string }}
 * The listed packages with the selection of each (an array is `"*"` for each package), sorted by name;
 * `legacy` when it came from `installSkills`; `field: undefined` when the root has neither key (or no
 * readable `package.json`); a problem for a malformed list, or for both keys.
 */
export function readDevSkills(root) {
  let rootPackage;
  try {
    rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return { field: undefined };
  }
  const dev = rootPackage?.devSkills;
  const old = rootPackage?.installSkills;
  if (dev !== undefined && old !== undefined) {
    return {
      problem:
        'package.json holds both `devSkills` and `installSkills`; keep `devSkills` (the new name of the same list) and remove `installSkills`',
    };
  }
  if (dev === undefined && old === undefined) return { field: undefined };
  const entries = new Map();
  if (dev === undefined) {
    if (!isNames(old)) {
      return { problem: '`installSkills` in package.json must be an array of package names' };
    }
    for (const name of old) entries.set(name, { kind: 'all' });
  } else if (Array.isArray(dev)) {
    if (!isNames(dev)) return { problem: DEV_SKILLS_SHAPE };
    for (const name of dev) entries.set(name, { kind: 'all' });
  } else if (typeof dev === 'object' && dev !== null) {
    for (const [name, selection] of Object.entries(dev)) {
      if (name === '') return { problem: DEV_SKILLS_SHAPE };
      if (selection === '*') {
        entries.set(name, { kind: 'all' });
      } else if (isNames(selection)) {
        entries.set(name, { kind: 'only', names: [...new Set(selection)].sort() });
      } else if (
        typeof selection === 'object' &&
        selection !== null &&
        !Array.isArray(selection) &&
        Object.keys(selection).length === 1 &&
        isNames(selection.exclude)
      ) {
        entries.set(name, { kind: 'exclude', names: [...new Set(selection.exclude)].sort() });
      } else {
        return { problem: `${DEV_SKILLS_SHAPE} (the entry for ${shown(name)} is none of them)` };
      }
    }
  } else {
    return { problem: DEV_SKILLS_SHAPE };
  }
  const names = [...entries.keys()].sort();
  return {
    field: new Map(names.map((name) => [name, entries.get(name)])),
    names,
    legacy: dev === undefined,
  };
}

/**
 * Lists the packages the root `package.json` declares in `dependencies` or `devDependencies`.
 * @param {string} root - The repository root.
 * @returns {string[]} The declared keys (an npm alias is listed by its key).
 */
function declaredPackages(root) {
  return declaredEntries(root).map(({ key }) => key);
}

/**
 * Builds the generated `.gitignore` of a target folder.
 * @param {Record<string, { mode: 'copy' | 'link' }>} entries - The skills installed there.
 * @returns {string} The file's text.
 */
function gitignoreText(entries) {
  const lines = [
    '# Generated by package-skills; do not edit.',
    '# It lists the skills package-skills installed here. A skill of your own, or one that',
    '# `npx skills add` installed, is not listed, so Git tracks it.',
    `/${RECORD}`,
    `/${GITIGNORE}`,
    // a folder pattern does not match a symbolic link, so a linked skill is listed without the slash
    ...Object.keys(entries)
      .filter((skill) => SKILL_NAME.test(skill))
      .sort()
      .map((skill) => (entries[skill].mode === 'link' ? `/${skill}` : `/${skill}/`)),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Hashes a folder's contents: every file's path and bytes, and every link's path and text
 * (links are left out with `skipLinks`, as a copy of a skill leaves them out).
 * @param {string} dir - The folder.
 * @param {{ skipLinks?: boolean }} [options] - Whether to leave symbolic links out.
 * @returns {string} The SHA-256 hash, hexadecimal.
 */
export function hashFolder(dir, { skipLinks = false } = {}) {
  const hash = createHash('sha256');
  const walk = (relativeDir) => {
    const entries = readdirSync(join(dir, relativeDir), { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (skipLinks) continue;
        hash.update(`link\0${path}\0${readlinkSync(join(dir, path))}\0`);
      } else if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        hash.update(`file\0${path}\0`);
        hash.update(readFileSync(join(dir, path)));
        hash.update('\0');
      }
    }
  };
  walk('');
  return hash.digest('hex');
}

/**
 * Tells whether a path is a regular file (a link is not followed).
 * @param {string} path - The path.
 * @returns {boolean} Whether it is.
 */
function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Tells whether a path is a regular file (a link is not followed) holding exactly this text.
 * @param {string} path - The path.
 * @param {string} text - The text.
 * @returns {boolean} Whether it is.
 */
function holds(path, text) {
  try {
    return lstatSync(path).isFile() && readFileSync(path, 'utf8') === text;
  } catch {
    return false;
  }
}

/**
 * Reads a target folder's record.
 * @param {string} folder - The target folder.
 * @returns {{ packages: string[], entries: Record<string, { mode: 'copy' | 'link', hash?: string, package?: string }> }}
 * The packages it names and the entries it lists; none when it is missing or unreadable. An old
 * record's entries belong to its `package`.
 */
function readRecord(folder) {
  try {
    // a record that is a link (or anything but a regular file) is not ours: read nothing through it
    const name = kindOf(join(folder, RECORD)) === 'none' ? LEGACY_RECORD : RECORD;
    if (!lstatSync(join(folder, name)).isFile()) return { packages: [], entries: {} };
    const record = JSON.parse(readFileSync(join(folder, name), 'utf8'));
    const entries =
      typeof record.entries === 'object' && record.entries !== null ? record.entries : {};
    const packages = [
      ...new Set([record.package, ...Object.keys(record.packages ?? {})].filter(Boolean)),
    ].filter((name) => typeof name === 'string' && PACKAGE_NAME.test(name));
    for (const entry of Object.values(entries)) entry.package ??= record.package;
    return { packages, entries };
  } catch {
    return { packages: [], entries: {} };
  }
}

/**
 * Plans what a run would do to the repository, and writes nothing: every decision of the
 * installer is made here, and `applyPlan` carries the resulting operations out.
 * @param {{ root: string, link?: boolean, force?: boolean }} options - The repository root,
 * whether to link instead of copy, and whether to replace changed copies.
 * @returns {{ ops: object[], changes: { kind: 'install' | 'refresh' | 'remove' | 'write' | 'rewrite', target: string, detail?: string }[], actions: { target: string, action: 'removed' | 'conflict' | 'edited' | 'duplicate', detail?: string }[], skills: string[], packages: Record<string, string>, sources: string[], targets: string[], linked: boolean, first: { skill: string, package: string }[], unlisted: { package: string, skills: string[] }[], available: { package: string, skill: string }[], warnings: string[], missingField: boolean, layoutProblem: boolean, problems: string[] }}
 * The operations (in order), what they change (`changes`: the skills to install, refresh or
 * remove, the files to write), what a run leaves alone (`actions`), the skills installed, the
 * packages they come from (name to version), the folders the links point into (relative to
 * the root's `node_modules` side, one per package), the folders written (one when
 * `.claude/skills` is a link to `.agents/skills`), the skills installed for the first time, the
 * packages `devSkills` does not list (with their skills; every package that exports skills
 * when the field is missing), the skills a listed package ships and its selection leaves out
 * (`available`), the warnings (the old key), whether the field is missing (then nothing is read from a package
 * and nothing in the target folders is touched), whether the layout is refused (nothing is
 * written then), and the problems that stop a package or the whole run.
 */
export function planInstall({ root, link = false, force = false }) {
  const empty = {
    ops: [],
    changes: [],
    actions: [],
    skills: [],
    packages: {},
    sources: [],
    targets: [],
    linked: false,
    first: [],
    unlisted: [],
    available: [],
    warnings: [],
    missingField: false,
    layoutProblem: false,
    problems: [],
  };
  const layout = resolveTargets(root);
  if ('problem' in layout) return { ...empty, layoutProblem: true, problems: [layout.problem] };
  const listing = readDevSkills(root);
  if ('problem' in listing) return { ...empty, problems: [listing.problem] };
  const warnings = listing.legacy
    ? [
        '`installSkills` in package.json is the old name of `devSkills`: the same list is read for now, and a later minor release of package-skills will not read it; rename the key to `devSkills`',
      ]
    : [];
  // Link through node_modules, so an upgrade (which moves the package's real folder in pnpm's
  // store) does not break the links.
  const installedOf = (packageName) => join(root, 'node_modules', packageName);
  const scan = scanSkillPackages(root);
  const everyProvider = scan.found.map((other) => ({
    ...other,
    linked: join(installedOf(other.name), relative(other.folder, other.skillsFolder)),
  }));
  const problems = scan.mismatched.map(({ declared, name: claimed, alias }) =>
    alias !== undefined
      ? `${declared} is installed in node_modules but its package.json names ${shown(claimed)}, not ${shown(alias)}, the package it is declared as an alias of; it is skipped (an alias must install its target)`
      : `${declared} is installed in node_modules but its package.json names ${shown(claimed)}; it is skipped (a declared package must carry the name it is declared under)`,
  );
  const unlisted = [];
  const unlist = (provider) =>
    unlisted.push({
      package: provider.name,
      skills: listSkillFolders(provider.skillsFolder).filter((skill) => SKILL_NAME.test(skill)),
    });
  if (listing.field === undefined) {
    // No list: nothing is installed from any package, and what an earlier run installed stays.
    for (const provider of everyProvider) unlist(provider);
    return { ...empty, unlisted, missingField: true, problems };
  }
  const declared = declaredPackages(root);
  for (const listed of listing.names) {
    if (!declared.includes(listed)) {
      problems.push(`${shown(listed)} is in devSkills but package.json does not declare it`);
    } else if (!everyProvider.some((provider) => provider.name === listed)) {
      problems.push(
        `${shown(listed)} is in devSkills but exports no skills (or is not installed in node_modules)`,
      );
    }
  }
  const providers = everyProvider.filter((provider) => listing.field.has(provider.name));
  for (const provider of everyProvider) {
    if (!listing.field.has(provider.name)) unlist(provider);
  }
  // The selection of each listed package: a name it does not ship fails the run before anything is
  // written, so a renamed or misspelt skill never vanishes silently (and nothing installed is removed).
  const selected = new Map();
  const available = [];
  const unknown = [];
  for (const provider of providers) {
    const shipped = listSkillFolders(provider.skillsFolder);
    const selection = listing.field.get(provider.name);
    const named = selection.kind === 'all' ? [] : selection.names;
    const missing = named.filter((name) => !shipped.includes(name));
    if (missing.length > 0) {
      unknown.push(
        `${provider.name} does not ship the skill${missing.length === 1 ? '' : 's'} ${missing.map(shown).join(', ')} that devSkills ${selection.kind === 'exclude' ? 'excludes' : 'names'}; it ships ${shipped.length === 0 ? 'no skills' : shipped.join(', ')}`,
      );
      continue;
    }
    const chosen = shipped.filter((skill) =>
      selection.kind === 'all'
        ? true
        : selection.kind === 'only'
          ? named.includes(skill)
          : !named.includes(skill),
    );
    selected.set(provider.name, chosen);
    for (const skill of shipped) {
      if (!chosen.includes(skill) && SKILL_NAME.test(skill)) {
        available.push({ package: provider.name, skill });
      }
    }
  }
  if (unknown.length > 0)
    return { ...empty, unlisted, warnings, problems: [...problems, ...unknown] };
  const providedBy = new Map();
  for (const provider of providers) {
    for (const skill of selected.get(provider.name)) {
      if (!SKILL_NAME.test(skill)) {
        problems.push(
          `${provider.name} has a skill named ${shown(skill)}, which is refused (a skill name is letters, digits, . _ - and starts with a letter or digit)`,
        );
        continue;
      }
      providedBy.set(skill, [...(providedBy.get(skill) ?? []), provider]);
    }
  }
  const duplicates = [...providedBy].filter(([, from]) => from.length > 1).map(([skill]) => skill);
  const skills = [...providedBy.keys()].filter((skill) => !duplicates.includes(skill)).sort();
  const providing = providers.filter((provider) =>
    skills.some((skill) => providedBy.get(skill)[0] === provider),
  );
  const packages = Object.fromEntries(
    providing.map((provider) => [provider.name, provider.version]),
  );
  const actions = [];
  const changes = [];
  const ops = [];
  for (const skill of duplicates) {
    actions.push({
      target: skill,
      action: 'duplicate',
      detail: providedBy
        .get(skill)
        .map((provider) => provider.name)
        .join(' and '),
    });
  }
  const sourceHashes = new Map();
  const sourceHash = (provider, skill) => {
    const key = `${provider.name}\0${skill}`;
    if (!sourceHashes.has(key)) {
      sourceHashes.set(key, hashFolder(join(provider.skillsFolder, skill), { skipLinks: true }));
    }
    return sourceHashes.get(key);
  };
  const previously = new Set();
  const installedNow = new Map();
  for (const target of layout.targets) {
    const folder = join(root, target);
    const targetOps = [];
    const { packages: recordedPackages, entries: recorded } = readRecord(folder);
    // the record of the 0.8 line is replaced by the new one: removed here, written below
    if (isRegularFile(join(folder, LEGACY_RECORD))) {
      targetOps.push({ op: 'remove', path: join(folder, LEGACY_RECORD) });
      changes.push({
        kind: 'remove',
        target: `${target}/${LEGACY_RECORD}`,
        detail: `the record of install-skills, replaced by ${RECORD}`,
      });
    }
    for (const entry of Object.keys(recorded)) previously.add(entry);
    // The package folders under node_modules a link of ours may point into: the listed providers
    // and the packages the record names (earlier installs), not an unlisted exporter a person
    // linked into by hand.
    const installedDirs = [
      ...new Set([...providers.map((provider) => provider.name), ...recordedPackages]),
    ].map(installedOf);
    const next = {};
    // A recorded entry is kept only under a safe name: the name goes into the generated .gitignore.
    const keep = (entry) => {
      if (SKILL_NAME.test(entry)) return true;
      problems.push(
        `${target}/${shown(entry)} has a name that is refused (letters, digits, . _ - only); it is not recorded or listed in .gitignore`,
      );
      return false;
    };
    // What an entry is to this script: its own (listed in the record, or a link into a package
    // under node_modules), a copy of its own changed since, or someone else's.
    const ownership = (entry) => {
      const path = join(folder, entry);
      const kind = kindOf(path);
      const listed = recorded[entry];
      if (kind === 'link') {
        const resolved = resolve(folder, readlinkSync(path));
        if (installedDirs.some((dir) => resolved.startsWith(dir + sep))) return 'own';
        return listed?.mode === 'link' ? 'own' : 'foreign';
      }
      if (kind === 'dir' && listed?.mode === 'copy') {
        return force || hashFolder(path) === listed.hash ? 'own' : 'edited';
      }
      return 'foreign';
    };
    for (const entry of kindOf(folder) === 'dir' ? readdirSync(folder).sort() : []) {
      if (entry === RECORD || entry === LEGACY_RECORD || entry === GITIGNORE) continue;
      if (skills.includes(entry)) continue;
      const state = ownership(entry);
      if (duplicates.includes(entry)) {
        // a name two packages provide: what is installed stays as it is, with its record
        if (state !== 'foreign' && recorded[entry] !== undefined && keep(entry)) {
          next[entry] = recorded[entry];
        }
        continue;
      }
      if (state === 'own') {
        // removes a link itself and never what it points at
        targetOps.push({ op: 'remove', path: join(folder, entry) });
        actions.push({ target: `${target}/${entry}`, action: 'removed' });
        changes.push({ kind: 'remove', target: `${target}/${entry}` });
      } else if (state === 'edited') {
        if (keep(entry)) next[entry] = recorded[entry];
        actions.push({ target: `${target}/${entry}`, action: 'edited' });
      }
    }
    for (const skill of skills) {
      const provider = providedBy.get(skill)[0];
      const path = join(folder, skill);
      const linkTarget = relative(folder, join(provider.linked, skill));
      const hash = link ? undefined : sourceHash(provider, skill);
      const existing = kindOf(path) !== 'none';
      if (existing) {
        const state = ownership(skill);
        if (state !== 'own') {
          if (state === 'edited') next[skill] = recorded[skill];
          actions.push({
            target: `${target}/${skill}`,
            action: state === 'edited' ? 'edited' : 'conflict',
          });
          continue;
        }
      }
      next[skill] = link
        ? { mode: 'link', package: provider.name }
        : { mode: 'copy', hash, package: provider.name };
      installedNow.set(skill, provider.name);
      const listed = recorded[skill];
      const current =
        existing &&
        listed?.package === provider.name &&
        (link
          ? listed.mode === 'link' && kindOf(path) === 'link' && readlinkSync(path) === linkTarget
          : listed.mode === 'copy' &&
            listed.hash === hash &&
            kindOf(path) === 'dir' &&
            hashFolder(path) === hash);
      if (current) continue;
      targetOps.push({
        op: 'install',
        path,
        link,
        from: join(provider.skillsFolder, skill),
        linkTarget,
      });
      changes.push({
        kind: existing ? 'refresh' : 'install',
        target: `${target}/${skill}`,
        detail: `${link ? 'linked' : 'copied'} from ${provider.name}`,
      });
    }
    const files = [
      [RECORD, `${JSON.stringify({ packages, entries: next }, null, 2)}\n`],
      [GITIGNORE, gitignoreText(next)],
    ];
    for (const [name, text] of files) {
      const path = join(folder, name);
      const present = kindOf(path) !== 'none';
      if (holds(path, text)) continue;
      targetOps.push({ op: 'write', path, text });
      changes.push({ kind: present ? 'rewrite' : 'write', target: `${target}/${name}` });
    }
    if (targetOps.length > 0 && kindOf(folder) === 'none') {
      targetOps.unshift({ op: 'mkdir', path: folder });
    }
    ops.push(...targetOps);
  }
  const first = [...installedNow]
    .filter(([skill]) => !previously.has(skill))
    .map(([skill, packageName]) => ({ skill, package: packageName }))
    .sort((left, right) => (left.skill < right.skill ? -1 : 1));
  return {
    ...empty,
    ops,
    changes,
    actions,
    skills,
    packages,
    sources: providing.map((provider) => relative(root, provider.linked)),
    targets: layout.targets,
    linked: layout.linked,
    first,
    unlisted,
    available,
    warnings,
    problems,
  };
}

/**
 * Carries out the operations of a plan.
 * @param {object[]} ops - The `ops` of `planInstall`.
 */
export function applyPlan(ops) {
  for (const op of ops) {
    if (op.op === 'mkdir') {
      mkdirSync(op.path, { recursive: true });
    } else if (op.op === 'remove') {
      rmSync(op.path, { recursive: true, force: true });
    } else if (op.op === 'write') {
      writeFresh(op.path, op.text);
    } else {
      rmSync(op.path, { recursive: true, force: true });
      if (op.link) {
        symlinkSync(op.linkTarget, op.path, 'dir');
      } else {
        cpSync(op.from, op.path, {
          recursive: true,
          // no package is trusted to link out of itself
          filter: (from) => !lstatSync(from).isSymbolicLink(),
        });
      }
    }
  }
}

/**
 * Installs the skills of the installed packages `devSkills` lists, or refreshes them.
 * @param {{ root: string, link?: boolean, force?: boolean }} options - The repository root,
 * whether to link instead of copy, and whether to replace changed copies.
 * @returns {ReturnType<typeof planInstall>} The plan that was carried out.
 */
export function install(options) {
  const plan = planInstall(options);
  applyPlan(plan.ops);
  return plan;
}

/**
 * Prints what a run leaves alone and fails on, as the run does (to standard error).
 * @param {ReturnType<typeof planInstall>} plan - The plan.
 * @param {string} repository - The repository root.
 * @returns {string[]} One line per finding, in the words of a run.
 */
function failureLines(plan, repository) {
  const { actions, unlisted, missingField, problems } = plan;
  const lines = problems.map((problem) => problem);
  if (missingField && !existsSync(join(repository, 'package.json'))) {
    lines.push(
      `no readable package.json at ${repository}, so there is no \`devSkills\` list and nothing is installed from any package, and what an earlier run installed stays as it is`,
    );
  } else if (missingField) {
    lines.push(
      `package.json at ${repository} has no \`devSkills\` field (an array of package names, or an object of package names to selections), so nothing is installed from any package, and what an earlier run installed stays as it is`,
    );
  }
  for (const { package: packageName, skills: skillNames } of unlisted) {
    lines.push(
      `${packageName} exports ${skillNames.length === 0 ? 'no skills' : `the skills ${skillNames.join(', ')}`} and is not in devSkills of package.json, so nothing of it is installed (adding it to the list is the person's decision)`,
    );
  }
  for (const { target, action, detail } of actions) {
    if (action === 'duplicate') {
      lines.push(
        `the skill ${target} is provided by ${detail}; neither installs it, and what is installed stays`,
      );
    } else if (action === 'conflict') {
      lines.push(`${target} exists and was not installed by package-skills; left alone`);
    } else if (action === 'edited') {
      lines.push(
        `${shown(target)} was changed since package-skills copied it; left alone (--force replaces it)`,
      );
    }
  }
  return lines;
}

/**
 * Lists what `package-skills --check` reports: the changes a run would make, then what it
 * would leave alone and fail on. Names from files are quoted.
 * @param {ReturnType<typeof planInstall>} plan - The plan.
 * @param {string} repository - The repository root.
 * @returns {string[]} One line per finding; none when a run would change nothing and fail on nothing.
 */
export function checkLines(plan, repository) {
  const lines = plan.changes.map(({ kind, target, detail }) => {
    if (kind === 'remove') {
      return `would remove ${shown(target)} (${detail ?? 'no longer in the package, not selected, or its package is not listed'})`;
    }
    return `would ${kind} ${shown(target)}${detail === undefined ? '' : ` (${detail})`}`;
  });
  for (const line of failureLines(plan, repository)) lines.push(`would fail: ${line}`);
  return lines;
}

/**
 * Lists the skills a listed package ships and the list leaves out: `--check` reports them, and they
 * neither change anything nor fail.
 * @param {ReturnType<typeof planInstall>} plan - The plan.
 * @returns {string[]} One line per skill.
 */
export function availableLines(plan) {
  return plan.available.map(
    ({ package: packageName, skill }) =>
      `available, not selected: ${shown(skill)} of ${packageName} (add it to its devSkills entry to install it)`,
  );
}

/**
 * Runs the command.
 * @param {string[]} args - The arguments after the command name.
 * @returns {number} The exit code: 0, 1 when `devSkills` is missing from the root `package.json` (or it holds both keys), an entry it did not install, a changed copy, a skill two packages provide, a `devSkills` name that is undeclared or exports nothing, a selection naming a skill its package does not ship, or an unsafe link blocks something (with `--check`: when a run would change or fail on anything), 2 for a usage error (with `--check`: or a layout a run refuses).
 */
export function main(args) {
  let link = false;
  let force = false;
  let check = false;
  let root;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--link') link = true;
    else if (arg === '--copy') link = false;
    else if (arg === '--force') force = true;
    else if (arg === '--check') check = true;
    else if (arg === '--root' && args[index + 1] !== undefined) root = args[(index += 1)];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    } else {
      process.stderr.write(`package-skills: unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const repository = root === undefined ? findRoot(process.cwd()) : resolve(root);
  if (check) {
    const plan = planInstall({ root: repository, link, force });
    if (plan.layoutProblem) {
      process.stderr.write(`package-skills: ${plan.problems[0]}\n`);
      return 2;
    }
    for (const warning of plan.warnings)
      process.stderr.write(`package-skills: warning: ${warning}\n`);
    const lines = checkLines(plan, repository);
    for (const line of [...lines, ...availableLines(plan)]) process.stdout.write(`${line}\n`);
    return lines.length === 0 ? 0 : 1;
  }
  const plan = install({ root: repository, link, force });
  const { actions, skills, packages, sources, targets, linked, first, missingField, problems } =
    plan;
  for (const warning of plan.warnings)
    process.stderr.write(`package-skills: warning: ${warning}\n`);
  for (const line of failureLines(plan, repository)) {
    process.stderr.write(`package-skills: ${line}\n`);
  }
  for (const { target, action } of actions) {
    if (action === 'removed') {
      process.stdout.write(
        `removed ${shown(target)} (no longer in the package, not selected, or its package is not listed)\n`,
      );
    }
  }
  for (const { skill, package: packageName } of first) {
    process.stdout.write(`installed the skill ${skill} (from ${packageName}) for the first time\n`);
  }
  const leftAlone = actions.filter(
    ({ action }) => action === 'conflict' || action === 'edited' || action === 'duplicate',
  ).length;
  if (missingField || targets.length === 0) return 1;
  const how = link ? `linked to ${sources.join(' and ') || 'node_modules'}` : 'copied';
  const from =
    Object.keys(packages).length > 1 ? ` from ${Object.keys(packages).length} packages` : '';
  const where = linked ? `${targets[0]} (which .claude/skills links to)` : targets.join(' and ');
  process.stdout.write(
    `package-skills: ${skills.length} skills${from} into ${where} of ${repository} (${how})${leftAlone === 0 ? '' : `; ${leftAlone} left alone`}\n`,
  );
  return leftAlone === 0 && problems.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
