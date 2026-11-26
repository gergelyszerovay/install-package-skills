# Changelog: install-package-skills

Release notes for those who consume a version. The rules are in the `changelog` skill.

## Unreleased

## 0.9.3

### Changed

- **On npm the package is `install-package-skills`, and so is its command.** Install it with
  `npm i -D install-package-skills` and run `install-package-skills`; `package-skills` stays as a second name of the
  same command, so existing scripts keep working.

## 0.9.2

### Changed

- **The README's opening is shorter**: what a skill is, where agents look for it, and what `package-skills` does.

### Fixed

- **An npm alias in `devDependencies` works.** A dependency declared as `"<key>": "npm:<package>@<range>"` (or
  `npm:<package>`) is listed in `devSkills` by its key, and its skills are installed, selected and recorded under that
  key, whether copied or linked; the installed package must be the alias's target, and one that is anything else is
  refused, naming both. Before, such a package was skipped as one whose `package.json` names another package, and
  reported as exporting no skills. Every other name mismatch is refused as before.

## 0.9.1

### Changed

- **The npm name is `package-skills`.** The package is published to npm as `package-skills` (`npm i -D package-skills`);
  the command is `package-skills` as before.
- **The README is the user guide.** It covers the quick start, the `devSkills` forms and their rules, the command and
  its options, where skills are installed, how a package ships skills, and the security rules.

## 0.9.0

### Added

- **`devSkills` can select skills.** Besides the array of package names (every skill of each), it takes an object of
  package names to `"*"` (every skill, those the package adds later too), a list of the skills to install, or
  `{ "exclude": [names] }` (all but those). A name the package does not ship fails the run, naming the skills it
  ships, and changes nothing, so a renamed skill never vanishes silently. A skill an earlier run installed and the list
  no longer selects is removed, like one its package dropped. `--check` reports a skill a listed package ships and the
  list leaves out as `available, not selected`, on standard output, without failing.
- **A selection settles a clash.** A skill name two packages ship is still refused, but only when the selection
  leaves it in both: select it from one package (or exclude it from the other) and it installs from that one.

### Changed

- **Breaking:** **The package is `@gergelyszerovay/package-skills`, and its bin `package-skills`.** It was
  `@gergelyszerovay/install-skills` with the bin `install-skills`, in the release group of the architecture skills; it
  is now developed and released on its own, and the version line continues (0.8.2 was the last `install-skills`, the
  next release is 0.9.0). A repository that ran `install-skills` replaces the dependency
  (`pnpm remove @gergelyszerovay/install-skills && pnpm add -D @gergelyszerovay/package-skills`) and calls
  `package-skills` in its scripts. Its options and exit codes are the same.
- **Breaking:** **The list in the root `package.json` is `devSkills`.** It names the skills a repository's agents use
  while developing it; `installSkills` was the same list under its old name. Rename the key: `package-skills` 0.9.x
  still reads `installSkills` when `devSkills` is absent, installs as before and prints one warning that names
  `devSkills`; a root with both keys fails the run. A later minor release drops `installSkills`.
- **Breaking:** **The record file of a target folder is `.package-skills.json`.** A target that holds the old
  `.install-skills.json` is read once and rewritten under the new name, so an upgrade neither reinstalls nor orphans a
  skill. The generated `.gitignore` of a target lists the new name.

## 0.8.1

### Changed

- **The package is developed in a repository of its own.** The `repository` field of the manifest names it, and the release group is now called `architecture-skills` (it was `block-architecture`; tags `architecture-skills@<version>` from the next release).

## 0.6.0

### Added

- **`install-skills` is a package of its own.** It was a bin of
  `@gergelyszerovay/architecture-skills`; a repository that installs the skills of any package no longer needs the architecture
  skills to get the installer. Same command, same options. A repository that ran the bin of the architecture skills adds this
  package (`pnpm add -D @gergelyszerovay/install-skills`).
- **`install-skills --check [--link] [--force]`.** It computes what a run would do and writes nothing: exit 0 and no output when
  nothing would change, exit 1 with one line per change (`would install`, `would refresh`, `would remove`, `would write` or
  `would rewrite` a record or a `.gitignore`) and per finding a run would leave alone and fail on (`would fail: …`: a conflict, a
  changed copy, a skill two packages provide, an unlisted package, a refused name, a missing `installSkills`), exit 2 on a usage error
  or a layout a run refuses. A doctor or a hook can ask without writing.

### Changed

- **Breaking:** **No package is special.** The installer installs the skills of the packages `installSkills` lists and of no other,
  the architecture skills included: they must be declared and listed like any other (they already had to be listed). A repository
  that listed nothing and relied on the installer's own package gets the report of an unlisted package naming it.
- **Breaking:** **The record has no `package` and `version` at its top level.** Its `packages` (name to version) and the `package` of
  each entry say what was installed; an older record still reads, and is rewritten by the next run.
- **A skill is copied without any symbolic link, whatever its package.** The installer's own package was trusted to copy its links;
  the filter now applies to every package.
- **A run installs only what differs.** It plans first, then applies the plan; a copy or link that already matches, a record and a
  `.gitignore` with the same text are left as they are, so their times stay.

## 0.5.0

No changes for users of the package.
