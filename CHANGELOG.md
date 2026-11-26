# Changelog: package-skills

Release notes of the package-skills group, one section per release, generated from the changelogs of its packages by `release-changelog --group`. Do not edit it by hand.

## Unreleased

## 0.9.2

### Changed

- **package-skills: The README's opening is shorter**: what a skill is, where agents look for it, and what
  `package-skills` does.

### Fixed

- **package-skills: An npm alias in `devDependencies` works.** A dependency declared as `"<key>": "npm:<package>@<range>"` (or
  `npm:<package>`) is listed in `devSkills` by its key, and its skills are installed, selected and recorded under that
  key, whether copied or linked; the installed package must be the alias's target, and one that is anything else is
  refused, naming both. Before, such a package was skipped as one whose `package.json` names another package, and
  reported as exporting no skills. Every other name mismatch is refused as before.

## 0.9.1

### Changed

- **package-skills: The npm name is `package-skills`.** The package is published to npm as `package-skills`
  (`npm i -D package-skills`); the command is `package-skills` as before.

- **package-skills: The README is the user guide.** It covers the quick start, the `devSkills` forms and their rules, the command and
  its options, where skills are installed, how a package ships skills, and the security rules.

## 0.9.0

### Added

- **package-skills: `devSkills` can select skills.** Besides the array of package names (every skill of each), it takes an object of
  package names to `"*"` (every skill, those the package adds later too), a list of the skills to install, or
  `{ "exclude": [names] }` (all but those). A name the package does not ship fails the run, naming the skills it
  ships, and changes nothing, so a renamed skill never vanishes silently. A skill an earlier run installed and the list
  no longer selects is removed, like one its package dropped. `--check` reports a skill a listed package ships and the
  list leaves out as `available, not selected`, on standard output, without failing.

- **package-skills: A selection settles a clash.** A skill name two packages ship is still refused, but only when the selection
  leaves it in both: select it from one package (or exclude it from the other) and it installs from that one.

### Changed

- **Breaking:** **package-skills: The package is `@gergelyszerovay/package-skills`, and its bin `package-skills`.** It was
  `@gergelyszerovay/install-skills` with the bin `install-skills`, in the release group of the architecture skills; it
  is now developed and released on its own, and the version line continues (0.8.2 was the last `install-skills`, the
  next release is 0.9.0). A repository that ran `install-skills` replaces the dependency
  (`pnpm remove @gergelyszerovay/install-skills && pnpm add -D @gergelyszerovay/package-skills`) and calls
  `package-skills` in its scripts. Its options and exit codes are the same.

- **Breaking:** **package-skills: The list in the root `package.json` is `devSkills`.** It names the skills a repository's agents use
  while developing it; `installSkills` was the same list under its old name. Rename the key: `package-skills` 0.9.x
  still reads `installSkills` when `devSkills` is absent, installs as before and prints one warning that names
  `devSkills`; a root with both keys fails the run. A later minor release drops `installSkills`.

- **Breaking:** **package-skills: The record file of a target folder is `.package-skills.json`.** A target that holds the old
  `.install-skills.json` is read once and rewritten under the new name, so an upgrade neither reinstalls nor orphans a
  skill. The generated `.gitignore` of a target lists the new name.
