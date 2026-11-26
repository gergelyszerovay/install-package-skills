# package-skills

Install the agent skills that your npm dependencies ship into your repository, where Claude Code, Codex and other
coding agents find them. You choose the packages, and optionally the skills of each, in a `devSkills` list in your
root `package.json`. Plain Node 20 or later, no dependencies, one command: `package-skills`.

Some packages ship skills: instructions that teach an agent how to use the package. Agents don't look for them in
`node_modules`, only in `.claude/skills/` and `.agents/skills/`. `package-skills` copies the skills you list there,
updates them when you upgrade a package, and removes them when you take them off the list.

## Quick start

```sh
pnpm add -D package-skills @acme/agent-skills     # or npm i -D …
```

Add the list to the root `package.json`, and run the installer from a script so every install refreshes the skills:

```json
{
  "scripts": {
    "prepare": "package-skills"
  },
  "devSkills": ["@acme/agent-skills"]
}
```

```sh
pnpm exec package-skills            # copies the skills into .claude/skills/ and .agents/skills/
pnpm exec package-skills --check    # reports what a run would change and writes nothing
```

The installed skills are not committed: each skills folder gets a generated `.gitignore` that lists exactly the
skills `package-skills` installed, so Git ignores those and still tracks every skill of your own. Running the
command from `prepare` installs them again on every `pnpm install` or `npm install`.

## The `devSkills` list

`devSkills` names the skills your repository's agents use while developing it, as `devDependencies` name the tools
you use while developing. It is required: without it `package-skills` installs nothing, lists the declared
packages that ship skills, and exits 1. So a new dependency, or an upgrade, never adds instructions for your agents
without a change to this list.

The short form lists packages, and installs every skill of each:

```json
{ "devSkills": ["@acme/agent-skills", "@acme/docs-skills"] }
```

The long form chooses skills per package:

```json
{
  "devSkills": {
    "@acme/agent-skills": "*",
    "@acme/docs-skills": ["writing-guides", "changelog"],
    "@acme/framework": { "exclude": ["framework-testing"] }
  }
}
```

| Value                  | Installs                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| `"*"`                  | every skill the package ships, including skills it adds in a later version |
| `["a", "b"]`           | only the skills named; a skill the package adds later is not installed     |
| `{ "exclude": ["a"] }` | every skill but those named                                                |

Rules:

- Each listed package must be declared in the root's `dependencies` or `devDependencies` and installed. A
  transitive or hoisted package is ignored.
- A package declared as an npm alias (`"<key>": "npm:<package>@<range>"`) is listed by its key, as in
  `"devSkills": ["<key>"]`; its skills are installed, selected and recorded under that key, and the installed
  package must be the alias's target `<package>`.
- A name in a list or an `exclude` that the package does not ship fails the run, naming the skills the package
  ships; nothing is installed or removed, so a typo or a renamed skill never deletes anything silently.
- A skill the package ships that your selection leaves out is reported by `--check` as `available, not selected`,
  so you notice new skills after an upgrade.
- A skill a run installed earlier that is no longer selected (or that the package no longer ships) is removed.
- Two packages that ship a skill of the same name are refused, unless your selection leaves it to one of them.
- A declared package that ships skills and is not listed is reported and installs nothing.
- `[]` or `{}` installs nothing and removes what earlier runs installed.

## The command

```sh
package-skills [--check] [--link] [--force] [--root <dir>]
```

| Option         | Does                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| (none)         | copies the selected skills into `.claude/skills/` and `.agents/skills/`, refreshes and removes as needed |
| `--link`       | links each skill to `node_modules/<package>/skills/<skill>` instead of copying it                        |
| `--check`      | prints what a run would change and writes nothing; exit 0 when nothing would change, 1 otherwise         |
| `--force`      | replaces an installed copy that was edited since it was installed                                        |
| `--root <dir>` | the repository's root (default: the nearest folder above with `.git`)                                    |

Every run prints the skills installed for the first time and those removed. A run fails (exit 1) and names the
problem when it would overwrite something it did not install, when an installed copy was edited, on a refused
selection, a clash or a missing list.

`--check` prints one line per change (`would install`, `would refresh`, `would remove`, `would write`,
`would rewrite`) and per problem (`would fail: …`), then one `available, not selected` line per skill your
selection leaves out. Those last lines do not change the exit code, so a hook or a doctor can run `--check` on every
call and look only at the exit code. It exits 2 on a usage error or a folder layout it refuses.

**Copies or links.** Copies are the default: they work with every tool, while some tools do not read files through
a symbolic link (for example templates a skill ships, or TypeScript files under `node_modules`, which Node does not
strip). Use `--link` when you want the skills to follow `node_modules` without running the command again.

## Where it installs

Into `.claude/skills/<skill>` and `.agents/skills/<skill>` of the repository. When `.claude/skills` is a relative
link to `../.agents/skills`, it installs once, into `.agents/skills/`. Any other symbolic link at `.claude`,
`.agents`, `.claude/skills` or `.agents/skills` is refused before anything is written, so the command never writes
or deletes outside those folders.

Each target folder gets two generated files:

- `.package-skills.json`, the record of what was installed there: each skill, its package and a hash of the copy.
  It is how a later run knows what to refresh or remove, and which copies were edited by hand.
- `.gitignore`, listing the record, itself and one line per skill installed there, and nothing else.

Anything in those folders that `package-skills` did not install (your own skills, ones `npx skills add` installed)
is never touched: a skill of the same name is reported instead.

## Shipping skills in a package

A package ships skills by exporting a folder of them as `./skills/*`, one folder per skill with a `SKILL.md`:

```json
{
  "name": "@acme/agent-skills",
  "exports": { "./skills/*": "./skills/*" },
  "files": ["skills"]
}
```

```text
skills/
  writing-guides/SKILL.md
  changelog/SKILL.md
```

Skill names are letters, digits, `.`, `_` and `-`, starting with a letter or a digit. A skill's own symbolic links
are not copied.

## Security

- Only packages you list, and that your root declares, can install skills; the declared key is what counts, so a
  package whose installed `package.json` claims another name is refused. For an npm alias
  (`"<key>": "npm:<package>@<range>"`) the key is listed, and the installed package must be the alias's target
  `<package>`; an alias that installs anything else is refused, naming both.
- Nothing outside the two skills folders is written or deleted, and no link is followed on the way there.
- An edited copy is never overwritten without `--force`.
