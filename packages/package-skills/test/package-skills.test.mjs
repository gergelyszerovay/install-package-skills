// Specs of bin/package-skills.mjs: node --test test/
// Each runs the command as a consuming repository would: the script of this package, in a repository
// whose node_modules holds a fake skills package (two skills), as pnpm lays it out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'package-skills.mjs');

/** Writes a skill folder with its SKILL.md into a package. */
const writeSkill = (pkg, name, body = `# ${name}\n`) => {
  mkdirSync(join(pkg, 'skills', name), { recursive: true });
  writeFileSync(join(pkg, 'skills', name, 'SKILL.md'), body);
};

/** Where pnpm's store keeps a version of the package. */
const storePath = (base, version) =>
  join(
    base,
    'store',
    `@gergelyszerovay+architecture-skills@${version}`,
    'node_modules',
    '@gergelyszerovay',
    'architecture-skills',
  );

/** Writes a version of the package into the store, with the given skills. */
const writePackage = (base, version, skills) => {
  const pkg = storePath(base, version);
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@gergelyszerovay/architecture-skills',
      version,
      exports: { './skills/*': './skills/*' },
    }),
  );
  for (const [name, body] of Object.entries(skills)) writeSkill(pkg, name, body);
  return pkg;
};

/** Points the repository's node_modules entry at a version of the package. */
const installVersion = (repo, pkg) => {
  const link = join(repo, 'node_modules', '@gergelyszerovay', 'architecture-skills');
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(pkg, link, 'dir');
};

/** A store folder holding the package, and a repository with it under node_modules. */
const setUp = () => {
  const base = mkdtempSync(join(tmpdir(), 'package-skills-'));
  const pkg = writePackage(base, '0.1.0', { alpha: '# alpha\n', beta: '# beta\n' });
  mkdirSync(join(pkg, 'skills', 'not-a-skill'), { recursive: true });
  const repo = join(base, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  installVersion(repo, pkg);
  // devSkills is required, and a listed package must be declared: the fixture does both, as a lab does
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      devDependencies: { '@gergelyszerovay/architecture-skills': '*' },
      devSkills: ['@gergelyszerovay/architecture-skills'],
    }),
  );
  return { base, pkg, repo };
};

/** Runs the command from a folder. */
const run = (cwd, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const record = (repo, target) =>
  JSON.parse(readFileSync(join(repo, target, '.package-skills.json'), 'utf8'));

test('copies every skill into .claude/skills and .agents/skills by default, from the repository found above the current folder, and records each copy', () => {
  const { base, pkg, repo } = setUp();
  try {
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    const result = run(join(repo, 'packages', 'app'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /2 skills into \.claude\/skills and \.agents\/skills of .* \(copied\)/,
    );
    for (const target of ['.claude/skills', '.agents/skills']) {
      for (const skill of ['alpha', 'beta']) {
        const path = join(repo, target, skill);
        assert.ok(lstatSync(path).isDirectory());
        assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), `# ${skill}\n`);
      }
      assert.ok(!existsSync(join(repo, target, 'not-a-skill')));
      const written = record(repo, target);
      assert.deepEqual(written.packages, { '@gergelyszerovay/architecture-skills': '0.1.0' });
      assert.ok(!('package' in written) && !('version' in written), 'no installer package');
      assert.deepEqual(Object.keys(written.entries), ['alpha', 'beta']);
      assert.equal(written.entries.alpha.mode, 'copy');
      assert.match(written.entries.alpha.hash, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('links every skill through node_modules with --link', () => {
  const { base, pkg, repo } = setUp();
  try {
    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /\(linked to node_modules\/@gergelyszerovay\/architecture-skills\/skills\)/,
    );
    const path = join(repo, '.agents', 'skills', 'beta');
    assert.ok(lstatSync(path).isSymbolicLink());
    assert.equal(
      readlinkSync(path),
      '../../node_modules/@gergelyszerovay/architecture-skills/skills/beta',
    );
    assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), '# beta\n');
    assert.deepEqual(record(repo, '.agents/skills').entries.beta, {
      mode: 'link',
      package: '@gergelyszerovay/architecture-skills',
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a run after an upgrade refreshes the copies and removes a skill the package dropped', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    const next = writePackage(base, '0.2.0', { alpha: '# alpha, changed\n', gamma: '# gamma\n' });
    installVersion(repo, next);

    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed "\.claude\/skills\/beta" \(no longer in the package/);
    assert.match(result.stdout, /removed "\.agents\/skills\/beta"/);
    assert.equal(
      readFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '# alpha, changed\n',
    );
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'gamma', 'SKILL.md')));
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'beta')));
    assert.deepEqual(record(repo, '.claude/skills').packages, {
      '@gergelyszerovay/architecture-skills': '0.2.0',
    });
    assert.deepEqual(Object.keys(record(repo, '.claude/skills').entries), ['alpha', 'gamma']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('switches between links and copies it installed, and replaces a recorded link an upgrade left dangling', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo, ['--link']).status, 0);
    assert.equal(run(repo).status, 0);
    assert.ok(lstatSync(join(repo, '.claude', 'skills', 'beta')).isDirectory());
    assert.equal(run(repo, ['--link']).status, 0);
    assert.ok(lstatSync(join(repo, '.claude', 'skills', 'beta')).isSymbolicLink());

    // A recorded link into a store folder that no longer exists, and an unrecorded one into
    // the package under node_modules: both are the script's own.
    rmSync(join(repo, '.agents', 'skills', 'beta'));
    symlinkSync(
      join(storePath(base, '0.0.9'), 'skills', 'beta'),
      join(repo, '.agents', 'skills', 'beta'),
    );
    symlinkSync(
      '../../node_modules/@gergelyszerovay/architecture-skills/skills/retired',
      join(repo, '.agents', 'skills', 'retired'),
    );
    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed "\.agents\/skills\/retired"/);
    assert.equal(
      realpathSync(join(repo, '.agents', 'skills', 'beta')),
      realpathSync(join(pkg, 'skills', 'beta')),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('leaves a folder or link it did not install alone, a link shaped like its own included, names it and fails, and installs the rest', () => {
  const { base, pkg, repo } = setUp();
  try {
    writeSkill(join(repo, '.claude'), 'alpha', '# my own alpha\n');
    mkdirSync(join(repo, 'vendor', 'architecture-skills', 'skills', 'beta'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'skills'), { recursive: true });
    symlinkSync(
      '../../vendor/architecture-skills/skills/beta',
      join(repo, '.agents', 'skills', 'beta'),
    );
    symlinkSync(
      '../../vendor/architecture-skills/skills/mine',
      join(repo, '.agents', 'skills', 'mine'),
    );
    mkdirSync(join(repo, '.claude', 'skills', 'other'), { recursive: true });
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\.claude\/skills\/alpha exists and was not installed by package-skills; left alone/,
    );
    assert.match(result.stderr, /\.agents\/skills\/beta exists/);
    assert.match(result.stdout, /; 2 left alone/);
    assert.equal(
      readFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '# my own alpha\n',
    );
    assert.equal(
      readlinkSync(join(repo, '.agents', 'skills', 'beta')),
      '../../vendor/architecture-skills/skills/beta',
    );
    assert.ok(lstatSync(join(repo, '.agents', 'skills', 'mine')).isSymbolicLink());
    assert.ok(existsSync(join(repo, '.claude', 'skills', 'other')));
    assert.ok(lstatSync(join(repo, '.claude', 'skills', 'beta')).isDirectory());
    assert.deepEqual(Object.keys(record(repo, '.claude/skills').entries), ['beta']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('keeps a copy changed since it was installed, refreshing or pruning, with a warning, and replaces it with --force', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    appendFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'my note\n');
    writeFileSync(join(repo, '.agents', 'skills', 'beta', 'extra.md'), 'mine\n');
    const next = writePackage(base, '0.2.0', { alpha: '# alpha, changed\n' });
    installVersion(repo, next);

    const kept = run(repo);
    assert.equal(kept.status, 1);
    assert.match(
      kept.stderr,
      /"\.claude\/skills\/alpha" was changed since package-skills copied it; left alone \(--force replaces it\)/,
    );
    assert.match(kept.stderr, /"\.agents\/skills\/beta" was changed since/);
    assert.equal(
      readFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '# alpha\nmy note\n',
    );
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'beta', 'extra.md')));
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'beta')));

    const forced = run(repo, ['--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(
      readFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '# alpha, changed\n',
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'beta')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('takes --root, links through node_modules from another folder, installs nothing from a package that is not installed, and refuses an unknown argument', () => {
  const { base, repo } = setUp();
  try {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    const result = run(elsewhere, ['--link', '--root', repo]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readlinkSync(join(repo, '.claude', 'skills', 'alpha')),
      '../../node_modules/@gergelyszerovay/architecture-skills/skills/alpha',
    );
    // listed and declared, but not installed under the repository: nothing to link to, so the run fails
    rmSync(join(repo, 'node_modules'), { recursive: true });
    const missing = run(elsewhere, ['--root', repo]);
    assert.equal(missing.status, 1);
    assert.match(
      missing.stderr,
      /"@gergelyszerovay\/architecture-skills" is in devSkills but exports no skills/,
    );
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'alpha')));
    const refused = run(repo, ['--copies']);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /unknown argument --copies/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Installs a second package, `@lab/lab`, that exports its skills, into the repository's node_modules. */
const installOtherPackage = (
  repo,
  skills,
  { name = '@lab/lab', exportsSkills = true, declared = true, listed = exportsSkills } = {},
) => {
  const rootFile = join(repo, 'package.json');
  const rootPackage = existsSync(rootFile) ? JSON.parse(readFileSync(rootFile, 'utf8')) : {};
  if (declared) {
    rootPackage.devDependencies = { ...rootPackage.devDependencies, [name]: '*' };
    if (listed) rootPackage.devSkills = [...(rootPackage.devSkills ?? []), name];
  }
  writeFileSync(rootFile, JSON.stringify(rootPackage));
  const folder = join(repo, 'node_modules', ...name.split('/'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({
      name,
      version: '2.0.0',
      ...(exportsSkills ? { exports: { './skills/*': './skills/*' } } : {}),
    }),
  );
  for (const [skill, body] of Object.entries(skills)) writeSkill(folder, skill, body);
  return folder;
};

test("installs the skills of every installed package that exports ./skills/*, and records each skill's package", () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { lab: '# lab\n' });
    installOtherPackage(
      repo,
      { quiet: '# quiet\n' },
      { name: 'plain-package', exportsSkills: false },
    );
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 skills from 2 packages into/);
    for (const target of ['.claude/skills', '.agents/skills']) {
      assert.equal(readFileSync(join(repo, target, 'lab', 'SKILL.md'), 'utf8'), '# lab\n');
      assert.ok(!existsSync(join(repo, target, 'quiet')));
      const written = record(repo, target);
      assert.deepEqual(written.packages, {
        '@gergelyszerovay/architecture-skills': '0.1.0',
        '@lab/lab': '2.0.0',
      });
      assert.equal(written.entries.lab.package, '@lab/lab');
      assert.equal(written.entries.alpha.package, '@gergelyszerovay/architecture-skills');
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("links each skill through its own package's node_modules folder with --link, and removes a skill whose package is gone", () => {
  const { base, pkg, repo } = setUp();
  try {
    const other = installOtherPackage(repo, { lab: '# lab\n' });
    assert.equal(run(repo, ['--link']).status, 0);
    assert.equal(
      readlinkSync(join(repo, '.agents', 'skills', 'lab')),
      '../../node_modules/@lab/lab/skills/lab',
    );
    assert.equal(
      readlinkSync(join(repo, '.agents', 'skills', 'alpha')),
      '../../node_modules/@gergelyszerovay/architecture-skills/skills/alpha',
    );

    rmSync(other, { recursive: true });
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills']);
    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed "\.agents\/skills\/lab"/);
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'lab')));
    assert.deepEqual(Object.keys(record(repo, '.claude/skills').packages), [
      '@gergelyszerovay/architecture-skills',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('installs a skill two packages provide from neither, names both, fails, and keeps a copy it installed earlier', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    installOtherPackage(repo, { alpha: '# the other alpha\n', lab: '# lab\n' });
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /the skill alpha is provided by @gergelyszerovay\/architecture-skills and @lab\/lab; neither installs it, and what is installed stays/,
    );
    assert.match(result.stdout, /; 1 left alone/);
    for (const target of ['.claude/skills', '.agents/skills']) {
      assert.equal(readFileSync(join(repo, target, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
      assert.equal(
        record(repo, target).entries.alpha.package,
        '@gergelyszerovay/architecture-skills',
      );
      assert.ok(existsSync(join(repo, target, 'beta', 'SKILL.md')));
      assert.ok(existsSync(join(repo, target, 'lab', 'SKILL.md')));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("reads an old record, which names one package and no per-entry package, as that package's", () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo, ['--link']).status, 0);
    const path = join(repo, '.claude', 'skills', '.package-skills.json');
    const old = JSON.parse(readFileSync(path, 'utf8'));
    delete old.packages;
    for (const entry of Object.values(old.entries)) delete entry.package;
    writeFileSync(path, JSON.stringify(old));
    rmSync(join(pkg, 'skills', 'beta'), { recursive: true });

    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed "\.claude\/skills\/beta"/);
    const written = record(repo, '.claude/skills');
    assert.equal(written.entries.alpha.package, '@gergelyszerovay/architecture-skills');
    assert.deepEqual(written.packages, { '@gergelyszerovay/architecture-skills': '0.1.0' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ignores a ./skills/* export that leaves its package, and does not copy symbolic links of another package's skills", () => {
  const { base, pkg, repo } = setUp();
  try {
    for (const target of ['../outside/*', '/etc/*', './../outside/*']) {
      const folder = installOtherPackage(repo, {}, { name: 'escaper', listed: false });
      writeFileSync(
        join(folder, 'package.json'),
        JSON.stringify({ name: 'escaper', version: '1', exports: { './skills/*': target } }),
      );
      mkdirSync(join(repo, 'node_modules', 'outside', 'evil'), { recursive: true });
      writeFileSync(join(repo, 'node_modules', 'outside', 'evil', 'SKILL.md'), '# evil\n');
      const result = run(repo);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!existsSync(join(repo, '.claude', 'skills', 'evil')), target);
    }
    // a folder inside the package that is a link out of it
    const linked = installOtherPackage(repo, {}, { name: 'linker', listed: false });
    symlinkSync(join(repo, 'node_modules', 'outside'), join(linked, 'skills'));
    assert.equal(run(repo).status, 0);
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'evil')));

    // a skill of another package holding a symbolic link out of it
    rmSync(linked, { recursive: true });
    const holder = installOtherPackage(repo, { holder: '# holder\n' }, { name: 'holder' });
    writeFileSync(join(repo, 'secret.txt'), 'secret');
    symlinkSync(join(repo, 'secret.txt'), join(holder, 'skills', 'holder', 'leak.txt'));
    assert.equal(run(repo).status, 0);
    assert.ok(existsSync(join(repo, '.claude', 'skills', 'holder', 'SKILL.md')));
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'holder', 'leak.txt')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ignores a package with ./skills/* that the root package.json does not declare, and installs one it declares in dependencies', () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { hoisted: '# hoisted\n' }, { name: 'hoisted-dep', declared: false });
    installOtherPackage(repo, { lab: '# lab\n' }, { name: '@lab/lab', declared: false });
    const rootFile = join(repo, 'package.json');
    writeFileSync(
      rootFile,
      JSON.stringify({
        dependencies: { '@lab/lab': '*', '@gergelyszerovay/architecture-skills': '*' },
        devSkills: ['@gergelyszerovay/architecture-skills', '@lab/lab'],
      }),
    );
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(repo, '.claude', 'skills', 'lab', 'SKILL.md')));
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'hoisted')));
    assert.deepEqual(Object.keys(record(repo, '.claude/skills').packages).sort(), [
      '@gergelyszerovay/architecture-skills',
      '@lab/lab',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Makes the lab layout: `.claude/skills` a relative link to `../.agents/skills`. */
const linkClaudeSkills = (repo) => {
  mkdirSync(join(repo, '.claude'), { recursive: true });
  symlinkSync('../.agents/skills', join(repo, '.claude', 'skills'));
};

/** Sets the `devSkills` field of the repository's root package.json. */
const setDevSkills = (repo, list) => {
  const rootFile = join(repo, 'package.json');
  const rootPackage = existsSync(rootFile) ? JSON.parse(readFileSync(rootFile, 'utf8')) : {};
  rootPackage.devSkills = list;
  writeFileSync(rootFile, JSON.stringify(rootPackage));
};

const git = (repo, args) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout.trim();

test('installs once into .agents/skills when .claude/skills is a link to it, keeps one record, reports one target, and the link stays', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /2 skills into \.agents\/skills \(which \.claude\/skills links to\) of /,
    );
    assert.doesNotMatch(result.stdout, /\.claude\/skills and /);
    assert.equal(readlinkSync(join(repo, '.claude', 'skills')), '../.agents/skills');
    assert.equal(
      readFileSync(join(repo, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      '# alpha\n',
    );
    assert.deepEqual(Object.keys(record(repo, '.agents/skills').entries), ['alpha', 'beta']);
    assert.deepEqual(
      result.stdout.split('\n').filter((line) => line.startsWith('installed the skill')),
      [
        'installed the skill alpha (from @gergelyszerovay/architecture-skills) for the first time',
        'installed the skill beta (from @gergelyszerovay/architecture-skills) for the first time',
      ],
    );
    // a second run installs nothing for the first time and still reports one target
    const again = run(repo);
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /for the first time/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('writes a .gitignore that lists exactly what it installed: a skill of the person, the agent or skills.sh is never listed, a removed skill is dropped, and Git tracks the foreign skill only', () => {
  const { base, pkg, repo } = setUp();
  try {
    spawnSync('git', ['init', '-q', repo]);
    linkClaudeSkills(repo);
    mkdirSync(join(repo, '.agents', 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    const ignore = readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8');
    const lines = ignore.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines, ['/.package-skills.json', '/.gitignore', '/alpha/', '/beta/']);
    assert.match(ignore, /^# Generated by package-skills/);
    assert.equal(
      git(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.agents/skills']),
      '?? .agents/skills/my-skill/SKILL.md',
    );
    // the package drops beta: its line goes, the person's skill stays untouched
    rmSync(join(storePath(base, '0.1.0'), 'skills', 'beta'), { recursive: true });
    const after = run(repo);
    assert.equal(after.status, 0, after.stderr);
    assert.match(after.stdout, /removed "\.agents\/skills\/beta"/);
    const lines2 = readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines2, ['/.package-skills.json', '/.gitignore', '/alpha/']);
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'my-skill', 'SKILL.md')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lists a linked skill without a trailing slash, since a folder pattern does not match a link', () => {
  const { base, pkg, repo } = setUp();
  try {
    spawnSync('git', ['init', '-q', repo]);
    linkClaudeSkills(repo);
    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines, ['/.package-skills.json', '/.gitignore', '/alpha', '/beta']);
    assert.equal(
      git(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.agents']),
      '',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('without the link it installs into both folders as before and writes the same .gitignore in each', () => {
  const { base, pkg, repo } = setUp();
  try {
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /into \.claude\/skills and \.agents\/skills of /);
    const first = readFileSync(join(repo, '.claude', 'skills', '.gitignore'), 'utf8');
    assert.equal(first, readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8'));
    assert.match(first, /^\/alpha\/$/m);
    assert.ok(lstatSync(join(repo, '.claude', 'skills')).isDirectory());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('installs only from the packages devSkills lists: an unlisted package that exports skills is named with its skills and installs nothing, and the run succeeds', () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { lab: '# lab\n', portless: '# p\n' });
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills']);
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /@lab\/lab exports the skills lab, portless and is not in devSkills/,
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'lab')));
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'alpha')));
    assert.deepEqual(Object.keys(record(repo, '.agents/skills').packages), [
      '@gergelyszerovay/architecture-skills',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('lists the package later and the skills arrive; unlisting it again removes them and says so', () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { lab: '# lab\n' });
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills']);
    assert.equal(run(repo).status, 0);
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills', '@lab/lab']);
    const added = run(repo);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /installed the skill lab \(from @lab\/lab\) for the first time/);
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'lab', 'SKILL.md')));
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills']);
    const removed = run(repo);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /removed "\.agents\/skills\/lab"/);
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'lab')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('fails naming a listed package that is not declared or exports no skills, and still installs the listed ones', () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { quiet: '# q\n' }, { name: 'plain-package', exportsSkills: false });
    installOtherPackage(repo, { ghost: '# g\n' }, { name: 'hoisted-dep', declared: false });
    setDevSkills(repo, [
      '@gergelyszerovay/architecture-skills',
      'plain-package',
      'hoisted-dep',
      'missing-entirely',
    ]);
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"plain-package" is in devSkills but exports no skills/);
    assert.match(
      result.stderr,
      /"hoisted-dep" is in devSkills but package.json does not declare it/,
    );
    assert.match(
      result.stderr,
      /"missing-entirely" is in devSkills but package.json does not declare it/,
    );
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'alpha')));
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'ghost')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses an devSkills field that is not a list of names', () => {
  const { base, pkg, repo } = setUp();
  try {
    setDevSkills(repo, 'everything');
    const refused = run(repo);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /devSkills.* must be an array of package names/);
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'alpha')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** Removes the `devSkills` field from the repository's root package.json. */
const removeInstallSkills = (repo) => {
  const rootFile = join(repo, 'package.json');
  const rootPackage = JSON.parse(readFileSync(rootFile, 'utf8'));
  delete rootPackage.devSkills;
  writeFileSync(rootFile, JSON.stringify(rootPackage));
};

test('without devSkills nothing is installed from any package: it names the packages that export skills and fails', () => {
  const { base, pkg, repo } = setUp();
  try {
    installOtherPackage(repo, { lab: '# lab\n' });
    removeInstallSkills(repo);
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no `devSkills` field/);
    assert.match(result.stderr, /@lab\/lab exports the skills lab and is not in devSkills/);
    assert.match(
      result.stderr,
      /@gergelyszerovay\/architecture-skills exports the skills alpha, beta and is not in devSkills/,
    );
    assert.doesNotMatch(result.stdout, /installed the skill/);
    assert.ok(!existsSync(join(repo, '.agents')));
    assert.ok(!existsSync(join(repo, '.claude')));
    // no readable package.json at all fails the same way, with its own words
    rmSync(join(repo, 'package.json'));
    const bare = run(repo);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /no readable package\.json at/);
    assert.doesNotMatch(bare.stderr, /has no `devSkills` field/);
    assert.ok(!existsSync(join(repo, '.agents')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an empty devSkills list installs nothing, removes what an earlier run installed, and succeeds', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'alpha')));
    setDevSkills(repo, []);
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 skills into/);
    assert.match(
      result.stderr,
      /architecture-skills exports the skills alpha, beta and is not in devSkills/,
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'alpha')));
    assert.ok(!existsSync(join(repo, '.claude', 'skills', 'beta')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('when the devSkills field disappears, skills an earlier run recorded stay untouched: not removed, not refreshed, record and .gitignore unchanged', () => {
  const { base, pkg, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    const target = join(repo, '.agents', 'skills');
    const recordBefore = readFileSync(join(target, '.package-skills.json'), 'utf8');
    const ignoreBefore = readFileSync(join(target, '.gitignore'), 'utf8');
    removeInstallSkills(repo);
    // the package changes in the meantime: a missing field refreshes nothing
    writeFileSync(join(pkg, 'skills', 'alpha', 'SKILL.md'), '# alpha changed\n');
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /what an earlier run installed stays as it is/);
    assert.equal(readFileSync(join(target, 'alpha', 'SKILL.md'), 'utf8'), '# alpha\n');
    assert.ok(existsSync(join(target, 'beta', 'SKILL.md')));
    assert.equal(readFileSync(join(target, '.package-skills.json'), 'utf8'), recordBefore);
    assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), ignoreBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses a .claude/skills link that does not point at ../.agents/skills, writing and deleting nothing', () => {
  const { base, pkg, repo } = setUp();
  try {
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'precious'), { recursive: true });
    writeFileSync(join(outside, 'precious', 'SKILL.md'), 'keep\n');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    symlinkSync(outside, join(repo, '.claude', 'skills'));
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /\.claude\/skills is a link to .*outside; a lab links it to \.\.\/\.agents\/skills/,
    );
    assert.deepEqual(readdirSync(outside), ['precious']);
    assert.ok(!existsSync(join(repo, '.agents', 'skills')));
    // the same for a relative link that merely resolves to the same folder another way
    rmSync(join(repo, '.claude', 'skills'));
    symlinkSync('../x/../.agents/skills', join(repo, '.claude', 'skills'));
    assert.equal(run(repo).status, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses a .claude, .agents or .agents/skills that is a link, so nothing is written through it', () => {
  for (const planted of ['.agents', '.claude', '.agents/skills']) {
    const { base, pkg, repo } = setUp();
    try {
      const outside = join(base, 'outside');
      mkdirSync(outside, { recursive: true });
      mkdirSync(dirname(join(repo, planted)), { recursive: true });
      symlinkSync(outside, join(repo, planted));
      const result = run(repo);
      assert.equal(result.status, 1, planted);
      assert.match(result.stderr, /symbolic link/);
      assert.deepEqual(readdirSync(outside), [], planted);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('does not write or delete through a link planted inside the folder: a skill name, the record and the .gitignore', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'folder'), { recursive: true });
    writeFileSync(join(outside, 'folder', 'keep.txt'), 'keep\n');
    writeFileSync(join(outside, 'record.json'), 'untouched\n');
    writeFileSync(join(outside, 'ignore.txt'), 'untouched\n');
    const skills = join(repo, '.agents', 'skills');
    mkdirSync(skills, { recursive: true });
    // a link where a package skill goes: foreign, left alone, nothing written into its target
    symlinkSync(join(outside, 'folder'), join(skills, 'alpha'));
    symlinkSync(join(outside, 'record.json'), join(skills, '.package-skills.json'));
    symlinkSync(join(outside, 'ignore.txt'), join(skills, '.gitignore'));
    // a planted record that claims the link is ours, as a copy and as a link
    const first = run(repo);
    assert.equal(first.status, 1);
    assert.match(
      first.stderr,
      /\.agents\/skills\/alpha exists and was not installed by package-skills/,
    );
    assert.deepEqual(readdirSync(join(outside, 'folder')), ['keep.txt']);
    assert.equal(readFileSync(join(outside, 'record.json'), 'utf8'), 'untouched\n');
    assert.equal(readFileSync(join(outside, 'ignore.txt'), 'utf8'), 'untouched\n');
    assert.ok(lstatSync(join(skills, '.package-skills.json')).isFile());
    assert.ok(lstatSync(join(skills, '.gitignore')).isFile());
    assert.ok(lstatSync(join(skills, 'alpha')).isSymbolicLink());
    // the record (now a real file) is edited to list the planted link as a recorded link: only the link is replaced
    const planted = record(repo, '.agents/skills');
    planted.entries.alpha = { mode: 'link', package: '@gergelyszerovay/architecture-skills' };
    writeFileSync(join(skills, '.package-skills.json'), JSON.stringify(planted));
    const second = run(repo);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readdirSync(join(outside, 'folder')), ['keep.txt']);
    assert.ok(lstatSync(join(skills, 'alpha')).isDirectory());
    // a planted link in place of a skill the package dropped is removed itself, never through
    rmSync(join(storePath(base, '0.1.0'), 'skills', 'beta'), { recursive: true });
    rmSync(join(skills, 'beta'), { recursive: true });
    symlinkSync(join(outside, 'folder'), join(skills, 'beta'));
    const dropped = record(repo, '.agents/skills');
    dropped.entries.beta = { mode: 'link' };
    writeFileSync(join(skills, '.package-skills.json'), JSON.stringify(dropped));
    const third = run(repo);
    assert.equal(third.status, 0, third.stderr);
    assert.ok(!existsSync(join(skills, 'beta')));
    assert.deepEqual(readdirSync(join(outside, 'folder')), ['keep.txt']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('reads no record through a link either: a record that is a link lists nothing, so nothing is claimed as ours', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    const outside = join(base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, 'record.json'),
      JSON.stringify({ entries: { mine: { mode: 'copy', hash: 'x' } } }),
    );
    const skills = join(repo, '.agents', 'skills');
    mkdirSync(join(skills, 'mine'), { recursive: true });
    writeFileSync(join(skills, 'mine', 'SKILL.md'), '# mine\n');
    symlinkSync(join(outside, 'record.json'), join(skills, '.package-skills.json'));
    const result = run(repo, ['--force']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(skills, 'mine', 'SKILL.md')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('matches devSkills against the declared key: a manifest that names another package is skipped, reported with both names, and fails the run', () => {
  const { base, pkg, repo } = setUp();
  try {
    const evil = installOtherPackage(repo, { sneaky: '# s\n' }, { name: 'evil' });
    writeFileSync(
      join(evil, 'package.json'),
      JSON.stringify({
        name: '@gergelyszerovay/lab',
        version: '9.9.9',
        exports: { './skills/*': './skills/*' },
      }),
    );
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills', '@gergelyszerovay/lab']);
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /evil is installed in node_modules but its package\.json names "@gergelyszerovay\/lab"; it is skipped/,
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'sneaky')));
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'alpha')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('reads no manifest outside node_modules for a declared key like ../../x', () => {
  const { base, pkg, repo } = setUp();
  try {
    const outside = join(base, 'x');
    mkdirSync(join(outside, 'skills', 'planted'), { recursive: true });
    writeFileSync(join(outside, 'skills', 'planted', 'SKILL.md'), '# p\n');
    writeFileSync(
      join(outside, 'package.json'),
      JSON.stringify({ name: '../../x', exports: { './skills/*': './skills/*' } }),
    );
    // base/repo/node_modules/../../x is base/x
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        devDependencies: { '../../x': '*', '@gergelyszerovay/architecture-skills': '*' },
        devSkills: ['@gergelyszerovay/architecture-skills'],
      }),
    );
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'planted')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses a skill name that is not letters, digits, . _ - : it is not installed, not listed in .gitignore, and the run fails', () => {
  const { base, pkg, repo } = setUp();
  try {
    spawnSync('git', ['init', '-q', repo]);
    linkClaudeSkills(repo);
    for (const bad of ['*', '!alpha', 'a\u001b[2Jb', '-x_', '#c', 'line\n/*']) writeSkill(pkg, bad);
    const mine = join(repo, '.agents', 'skills', 'my-skill');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), '# mine\n');
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /has a skill named "\*", which is refused/);
    assert.ok(!result.stderr.includes('\u001b'), 'no raw escape reaches the terminal');
    const ignore = readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8');
    const lines = ignore.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines, ['/.package-skills.json', '/.gitignore', '/alpha/', '/beta/']);
    assert.match(
      git(repo, ['status', '--porcelain', '--untracked-files=all', '--', '.agents']),
      /my-skill\/SKILL\.md/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses a recorded entry with an unsafe name too: a planted record does not put it into .gitignore', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    const skills = join(repo, '.agents', 'skills');
    mkdirSync(join(skills, '*'), { recursive: true });
    writeFileSync(join(skills, '*', 'SKILL.md'), '# star\n');
    writeFileSync(
      join(skills, '.package-skills.json'),
      JSON.stringify({
        package: '@gergelyszerovay/architecture-skills',
        entries: {
          '*': { mode: 'copy', hash: 'wrong', package: '@gergelyszerovay/architecture-skills' },
        },
      }),
    );
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"\*" has a name that is refused/);
    assert.ok(!('*' in record(repo, '.agents/skills').entries));
    assert.ok(!/^\/\*/m.test(readFileSync(join(skills, '.gitignore'), 'utf8')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('keeps a link the person made into an exporter that was never listed, and still cleans up the links of an earlier install', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    installOtherPackage(repo, { lab: '# lab\n' });
    installOtherPackage(repo, { portless: '# p\n' }, { name: '@lab/other' });
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills', '@lab/lab']);
    assert.equal(run(repo, ['--link']).status, 0);
    const skills = join(repo, '.agents', 'skills');
    assert.ok(lstatSync(join(skills, 'lab')).isSymbolicLink());
    // the person links one skill of the never-listed exporter by hand; then @lab/lab is unlisted
    symlinkSync('../../node_modules/@lab/other/skills/portless', join(skills, 'portless'), 'dir');
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills']);
    const result = run(repo, ['--link']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(skills, 'lab')), 'the recorded link is removed');
    assert.ok(lstatSync(join(skills, 'portless')).isSymbolicLink(), 'the hand link stays');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('quotes every name it prints: a removed link, an edited copy and an devSkills entry with an escape character show no raw control character', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    const skills = join(repo, '.agents', 'skills');
    mkdirSync(skills, { recursive: true });
    const odd = 'q\u001b[2J';
    symlinkSync(
      '../../node_modules/@gergelyszerovay/architecture-skills/skills/alpha',
      join(skills, odd),
      'dir',
    );
    writeFileSync(
      join(skills, '.package-skills.json'),
      JSON.stringify({
        package: '@gergelyszerovay/architecture-skills',
        entries: {
          [odd]: { mode: 'link', package: '@gergelyszerovay/architecture-skills' },
        },
      }),
    );
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills', 'nodecl\u001b]0;pwn\u0007']);
    const result = run(repo);
    assert.ok(!result.stdout.includes('\u001b'), result.stdout);
    assert.ok(
      !result.stderr.includes('\u001b') && !result.stderr.includes('\u0007'),
      result.stderr,
    );
    assert.match(result.stdout, /removed ".*q\\u001b\[2J"/);
    assert.match(result.stderr, /"nodecl\\u001b\]0;pwn\\u0007" is in devSkills/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a run after an upgrade that renames a skill installs the new name and removes the old one', () => {
  const { base, pkg, repo } = setUp();
  try {
    linkClaudeSkills(repo);
    assert.equal(run(repo).status, 0);
    // the next version ships beta as gamma, with the same content
    const next = writePackage(base, '0.2.0', { alpha: '# alpha\n', gamma: '# beta\n' });
    installVersion(repo, next);

    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stdout.split('\n').filter((line) => line.startsWith('installed the skill')),
      ['installed the skill gamma (from @gergelyszerovay/architecture-skills) for the first time'],
    );
    assert.match(result.stdout, /removed "\.agents\/skills\/beta" \(no longer in the package/);
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'gamma', 'SKILL.md')));
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'beta')));
    assert.equal(readlinkSync(join(repo, '.claude', 'skills')), '../.agents/skills');
    const lines = readFileSync(join(repo, '.agents', 'skills', '.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(lines, ['/.package-skills.json', '/.gitignore', '/alpha/', '/gamma/']);
    assert.deepEqual(record(repo, '.agents/skills').packages, {
      '@gergelyszerovay/architecture-skills': '0.2.0',
    });
    assert.deepEqual(Object.keys(record(repo, '.agents/skills').entries), ['alpha', 'gamma']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Specs of architecture-skills plan 0001 (decisions 3 and 4): no own package, and --check.

test(
  'installs the architecture skills through node_modules like any listed package, run from the installer’s own package',
  {
    tags: ['scenario'],
    meta: {
      spec: 'installs-listed-package-through-node-modules',
      arrange:
        'the installer in a package of its own beside the repository, and the architecture skills declared, installed under node_modules and listed in devSkills',
      act: 'package-skills runs, then package-skills --link',
      assert:
        'the copies and then the links point into node_modules/@gergelyszerovay/architecture-skills/skills, and the record names the package in packages and in each entry, with no package or version of the installer',
    },
  },
  () => {
    const { base, repo } = setUp();
    try {
      const copied = run(repo);
      assert.equal(copied.status, 0, copied.stderr);
      const written = record(repo, '.agents/skills');
      assert.deepEqual(written.packages, { '@gergelyszerovay/architecture-skills': '0.1.0' });
      assert.ok(!('package' in written) && !('version' in written));
      assert.equal(written.entries.alpha.package, '@gergelyszerovay/architecture-skills');

      const linked = run(repo, ['--link']);
      assert.equal(linked.status, 0, linked.stderr);
      for (const target of ['.claude/skills', '.agents/skills']) {
        assert.equal(
          readlinkSync(join(repo, target, 'alpha')),
          '../../node_modules/@gergelyszerovay/architecture-skills/skills/alpha',
        );
        assert.deepEqual(record(repo, target).entries.beta, {
          mode: 'link',
          package: '@gergelyszerovay/architecture-skills',
        });
        assert.deepEqual(record(repo, target).packages, {
          '@gergelyszerovay/architecture-skills': '0.1.0',
        });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  'installs nothing of the architecture skills when devSkills does not list them, and names the package to list',
  {
    tags: ['edge-case'],
    meta: {
      spec: 'unlisted-skills-package-not-special',
      arrange:
        'the architecture skills declared and installed, and an devSkills list that names only another package, then one that is empty',
      act: 'package-skills runs each time',
      assert:
        'the unlisted report names @gergelyszerovay/architecture-skills with its skills, none of them is installed, and an earlier install of them is removed as for any unlisted package',
    },
  },
  () => {
    const { base, repo } = setUp();
    try {
      assert.equal(run(repo).status, 0);
      assert.ok(existsSync(join(repo, '.agents', 'skills', 'alpha')));
      installOtherPackage(repo, { lab: '# lab\n' });
      setDevSkills(repo, ['@lab/lab']);
      const other = run(repo);
      assert.equal(other.status, 0, other.stderr);
      assert.match(
        other.stderr,
        /@gergelyszerovay\/architecture-skills exports the skills alpha, beta and is not in devSkills/,
      );
      assert.match(other.stdout, /removed "\.agents\/skills\/alpha"/);
      assert.ok(!existsSync(join(repo, '.agents', 'skills', 'alpha')));
      assert.ok(!existsSync(join(repo, '.claude', 'skills', 'beta')));
      assert.ok(existsSync(join(repo, '.agents', 'skills', 'lab', 'SKILL.md')));

      setDevSkills(repo, []);
      const empty = run(repo);
      assert.equal(empty.status, 0, empty.stderr);
      assert.match(
        empty.stderr,
        /@gergelyszerovay\/architecture-skills exports the skills alpha, beta and is not in devSkills/,
      );
      assert.ok(!existsSync(join(repo, '.agents', 'skills', 'lab')));
      assert.match(empty.stdout, /0 skills into/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  'copies no symbolic link out of any package’s skills, the architecture skills included',
  {
    tags: ['edge-case'],
    meta: {
      spec: 'copies-no-link-from-any-package',
      arrange:
        'a skill of the listed architecture skills holding a symbolic link to a file outside the package',
      act: 'package-skills runs',
      assert: 'the copy holds the skill’s regular files and no link, as for every other package',
    },
  },
  () => {
    const { base, pkg, repo } = setUp();
    try {
      writeFileSync(join(base, 'secret.txt'), 'secret');
      symlinkSync(join(base, 'secret.txt'), join(pkg, 'skills', 'alpha', 'leak.txt'));
      mkdirSync(join(pkg, 'skills', 'alpha', 'refs'));
      writeFileSync(join(pkg, 'skills', 'alpha', 'refs', 'one.md'), '# one\n');
      symlinkSync(base, join(pkg, 'skills', 'alpha', 'refs', 'up'), 'dir');
      const result = run(repo);
      assert.equal(result.status, 0, result.stderr);
      for (const target of ['.claude/skills', '.agents/skills']) {
        const copy = join(repo, target, 'alpha');
        assert.ok(existsSync(join(copy, 'SKILL.md')));
        assert.equal(readFileSync(join(copy, 'refs', 'one.md'), 'utf8'), '# one\n');
        assert.ok(!existsSync(join(copy, 'leak.txt')) && !hasLink(join(copy, 'leak.txt')));
        assert.ok(!hasLink(join(copy, 'refs', 'up')));
        assert.ok(readdirSync(join(copy, 'refs')).every((name) => name === 'one.md'));
      }
      // the copy matches its record, so the next run and --check see no change
      assert.equal(run(repo).status, 0);
      const check = run(repo, ['--check']);
      assert.equal(check.status, 0, check.stdout);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

/** Tells whether a path is a symbolic link (a missing path is not). */
const hasLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Lists every path below a folder with what it is: its type and permission bits, a file's bytes
 * and a link's text. Nothing is followed, and times are left out (reading changes them).
 */
const snapshot = (folder) => {
  const found = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) found[path] = { type: 'link', to: readlinkSync(path) };
      else if (stat.isDirectory()) {
        found[path] = { type: 'dir', mode };
        walk(path);
      } else found[path] = { type: 'file', mode, bytes: readFileSync(path).toString('base64') };
    }
  };
  walk(folder);
  return found;
};

/** Runs `package-skills --check` and asserts that it changed nothing below `base`: files, modes, contents, links. */
const runCheck = (base, cwd, args = []) => {
  const before = snapshot(base);
  const result = run(cwd, ['--check', ...args]);
  assert.deepEqual(snapshot(base), before, 'package-skills --check wrote something');
  return result;
};

/** The lines a --check printed. */
const linesOf = (result) => result.stdout.split('\n').filter((line) => line !== '');

test(
  '--check on a fresh repository reports every install and exits 1',
  {
    tags: ['scenario'],
    meta: {
      spec: 'check-reports-fresh-install',
      arrange: 'a repository with a listed package of two skills and nothing installed',
      act: 'package-skills --check runs',
      assert:
        'it prints one line per skill to install in each target and one per .gitignore to write, exits 1, and the skill folders stay absent',
    },
  },
  () => {
    const { base, repo } = setUp();
    try {
      const result = runCheck(base, repo);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(linesOf(result), [
        'would install ".claude/skills/alpha" (copied from @gergelyszerovay/architecture-skills)',
        'would install ".claude/skills/beta" (copied from @gergelyszerovay/architecture-skills)',
        'would write ".claude/skills/.package-skills.json"',
        'would write ".claude/skills/.gitignore"',
        'would install ".agents/skills/alpha" (copied from @gergelyszerovay/architecture-skills)',
        'would install ".agents/skills/beta" (copied from @gergelyszerovay/architecture-skills)',
        'would write ".agents/skills/.package-skills.json"',
        'would write ".agents/skills/.gitignore"',
      ]);
      assert.ok(!existsSync(join(repo, '.claude')) && !existsSync(join(repo, '.agents')));

      // the lab's layout has one target; --link names the other mode
      linkClaudeSkills(repo);
      const lab = runCheck(base, repo, ['--link']);
      assert.equal(lab.status, 1);
      assert.deepEqual(linesOf(lab), [
        'would install ".agents/skills/alpha" (linked from @gergelyszerovay/architecture-skills)',
        'would install ".agents/skills/beta" (linked from @gergelyszerovay/architecture-skills)',
        'would write ".agents/skills/.package-skills.json"',
        'would write ".agents/skills/.gitignore"',
      ]);
      assert.ok(!existsSync(join(repo, '.agents')));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  '--check after an install exits 0 and prints no change',
  {
    tags: ['scenario'],
    meta: {
      spec: 'check-clean-after-install',
      arrange: 'a repository where package-skills ran, once with copies and once with --link',
      act: 'package-skills --check runs, with --link after the linked install',
      assert: 'it prints no change line and exits 0 each time',
    },
  },
  () => {
    const { base, repo } = setUp();
    try {
      assert.equal(run(repo).status, 0);
      const copied = runCheck(base, repo);
      assert.equal(copied.status, 0, copied.stdout);
      assert.equal(copied.stdout, '');
      assert.equal(copied.stderr, '');

      assert.equal(run(repo, ['--link']).status, 0);
      const linked = runCheck(base, repo, ['--link']);
      assert.equal(linked.status, 0, linked.stdout);
      assert.equal(linked.stdout, '');

      // the lab's layout, and a second package, are clean after their install too
      rmSync(join(repo, '.claude'), { recursive: true });
      rmSync(join(repo, '.agents'), { recursive: true });
      linkClaudeSkills(repo);
      installOtherPackage(repo, { lab: '# lab\n' });
      assert.equal(run(repo).status, 0);
      assert.equal(runCheck(base, repo).status, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  '--check reports a changed copy, a removed skill and a stale .gitignore on one line each',
  {
    tags: ['edge-case'],
    meta: {
      spec: 'check-one-line-per-change',
      arrange:
        'an installed repository, then an edited copy, a skill the package dropped after an upgrade and a .gitignore edited by hand',
      act: 'package-skills --check runs',
      assert:
        'each is one quoted line naming its target, and the run exits 1; a copy installed where --link would link is a change too',
    },
  },
  () => {
    // an edited copy: left alone by a run, which fails on it
    let { base, pkg, repo } = setUp();
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      appendFileSync(join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'), 'my note\n');
      const edited = runCheck(base, repo);
      assert.equal(edited.status, 1);
      assert.deepEqual(linesOf(edited), [
        'would fail: ".agents/skills/alpha" was changed since package-skills copied it; left alone (--force replaces it)',
      ]);
      // --force replaces it
      const forced = runCheck(base, repo, ['--force']);
      assert.deepEqual(linesOf(forced), [
        'would refresh ".agents/skills/alpha" (copied from @gergelyszerovay/architecture-skills)',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // a skill the package dropped: removed, and the record and .gitignore follow
    ({ base, pkg, repo } = setUp());
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      rmSync(join(pkg, 'skills', 'beta'), { recursive: true });
      const dropped = runCheck(base, repo);
      assert.equal(dropped.status, 1);
      assert.deepEqual(linesOf(dropped), [
        'would remove ".agents/skills/beta" (no longer in the package, not selected, or its package is not listed)',
        'would rewrite ".agents/skills/.package-skills.json"',
        'would rewrite ".agents/skills/.gitignore"',
      ]);
      // a run does what --check said, and then --check is clean
      assert.equal(run(repo).status, 0);
      assert.equal(runCheck(base, repo).status, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // a stale .gitignore, edited by hand
    ({ base, pkg, repo } = setUp());
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      appendFileSync(join(repo, '.agents', 'skills', '.gitignore'), '/mine/\n');
      const stale = runCheck(base, repo);
      assert.equal(stale.status, 1);
      assert.deepEqual(linesOf(stale), ['would rewrite ".agents/skills/.gitignore"']);
      assert.equal(run(repo).status, 0);
      assert.equal(runCheck(base, repo).status, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // an upgrade moves the record's version, and a copy installed where --link would link is a change
    ({ base, pkg, repo } = setUp());
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      const next = writePackage(base, '0.2.0', { alpha: '# alpha\n', beta: '# beta\n' });
      installVersion(repo, next);
      const upgraded = runCheck(base, repo);
      assert.deepEqual(linesOf(upgraded), ['would rewrite ".agents/skills/.package-skills.json"']);

      const linking = runCheck(base, repo, ['--link']);
      assert.equal(linking.status, 1);
      assert.deepEqual(linesOf(linking), [
        'would refresh ".agents/skills/alpha" (linked from @gergelyszerovay/architecture-skills)',
        'would refresh ".agents/skills/beta" (linked from @gergelyszerovay/architecture-skills)',
        'would rewrite ".agents/skills/.package-skills.json"',
        'would rewrite ".agents/skills/.gitignore"',
      ]);
      assert.equal(run(repo, ['--link']).status, 0);
      assert.equal(runCheck(base, repo, ['--link']).status, 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  '--check reports what a run would leave alone and fail on: an unlisted package, a conflict, a missing devSkills',
  {
    tags: ['edge-case'],
    meta: {
      spec: 'check-reports-run-failures',
      arrange:
        'a repository with a folder of the person’s under a skill’s name, an unlisted package that exports skills, then one without devSkills; a record planted to claim the person’s folder, a skill two packages provide, a skill and a recorded entry with an unsafe name',
      act: 'package-skills --check runs',
      assert:
        'each is one line, names from the files are quoted, the person’s folder is never reported as one to replace or refresh, and the run exits 1',
    },
  },
  () => {
    // a folder of the person's under a skill's name, and an unlisted package
    let { base, pkg, repo } = setUp();
    try {
      linkClaudeSkills(repo);
      writeSkill(join(repo, '.agents'), 'alpha', '# my own alpha\n');
      installOtherPackage(repo, { portless: '# p\n' }, { name: '@lab/other', listed: false });
      const result = runCheck(base, repo);
      assert.equal(result.status, 1);
      assert.deepEqual(linesOf(result), [
        'would install ".agents/skills/beta" (copied from @gergelyszerovay/architecture-skills)',
        'would write ".agents/skills/.package-skills.json"',
        'would write ".agents/skills/.gitignore"',
        "would fail: @lab/other exports the skills portless and is not in devSkills of package.json, so nothing of it is installed (adding it to the list is the person's decision)",
        'would fail: .agents/skills/alpha exists and was not installed by package-skills; left alone',
      ]);
      assert.equal(
        readFileSync(join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
        '# my own alpha\n',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // no devSkills: nothing is read from a package, the field is named missing
    ({ base, repo } = setUp());
    try {
      installOtherPackage(repo, { lab: '# lab\n' });
      removeInstallSkills(repo);
      const result = runCheck(base, repo);
      assert.equal(result.status, 1);
      const lines = linesOf(result);
      assert.ok(
        lines.every((line) => line.startsWith('would fail: ')),
        lines.join('\n'),
      );
      assert.ok(lines.some((line) => line.includes('has no `devSkills` field')));
      assert.ok(lines.some((line) => line.includes('@lab/lab exports the skills lab')));
      assert.ok(
        lines.some((line) =>
          line.includes('@gergelyszerovay/architecture-skills exports the skills alpha, beta'),
        ),
      );
      assert.ok(!lines.some((line) => line.startsWith('would install')));
      rmSync(join(repo, 'package.json'));
      const bare = runCheck(base, repo);
      assert.equal(bare.status, 1);
      assert.match(bare.stdout, /would fail: no readable package\.json at/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // (a) a record planted to claim the person's own skill folder: a conflict or a changed copy,
    // left alone, never a refresh or a replacement
    for (const claim of [
      { mode: 'copy', hash: 'f'.repeat(64), package: '@gergelyszerovay/architecture-skills' },
      { mode: 'link', package: '@gergelyszerovay/architecture-skills' },
    ]) {
      ({ base, repo } = setUp());
      try {
        linkClaudeSkills(repo);
        const skills = join(repo, '.agents', 'skills');
        writeSkill(join(repo, '.agents'), 'alpha', '# the person’s alpha\n');
        writeFileSync(
          join(skills, '.package-skills.json'),
          JSON.stringify({
            packages: { '@gergelyszerovay/architecture-skills': '0.1.0' },
            entries: { alpha: claim },
          }),
        );
        const result = runCheck(base, repo);
        assert.equal(result.status, 1, claim.mode);
        const about = linesOf(result).filter((line) => line.includes('alpha'));
        assert.equal(about.length, 1, about.join('\n'));
        assert.match(
          about[0],
          /^would fail: .*alpha.* (exists and was not installed|was changed since).*left alone/,
        );
        assert.ok(
          !linesOf(result).some((line) => /^would (refresh|install|remove) .*alpha/.test(line)),
        );
        // a run agrees: it leaves the folder alone
        assert.equal(run(repo).status, 1);
        assert.equal(
          readFileSync(join(skills, 'alpha', 'SKILL.md'), 'utf8'),
          '# the person’s alpha\n',
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }

    // (b) a skill two packages provide: from neither, both named
    ({ base, pkg, repo } = setUp());
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      installOtherPackage(repo, { alpha: '# the other alpha\n', lab: '# lab\n' });
      const result = runCheck(base, repo);
      assert.equal(result.status, 1);
      const lines = linesOf(result);
      assert.ok(
        lines.includes(
          'would fail: the skill alpha is provided by @gergelyszerovay/architecture-skills and @lab/lab; neither installs it, and what is installed stays',
        ),
        lines.join('\n'),
      );
      assert.ok(lines.includes('would install ".agents/skills/lab" (copied from @lab/lab)'));
      assert.ok(!lines.some((line) => /^would (refresh|remove) .*alpha/.test(line)));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }

    // (b) unsafe names: a skill folder named with an escape character or a pattern, and a recorded
    // entry named ../x (a folder cannot be named so; a planted record can); quoted, never a path
    ({ base, pkg, repo } = setUp());
    try {
      linkClaudeSkills(repo);
      assert.equal(run(repo).status, 0);
      writeSkill(pkg, 'a\u001b[2Jb');
      writeSkill(pkg, '*');
      const skills = join(repo, '.agents', 'skills');
      const planted = record(repo, '.agents/skills');
      planted.entries['../x'] = {
        mode: 'link',
        package: '@gergelyszerovay/architecture-skills',
      };
      writeFileSync(join(skills, '.package-skills.json'), JSON.stringify(planted));
      writeFileSync(join(base, 'x'), 'outside\n');
      const result = runCheck(base, repo);
      assert.equal(result.status, 1);
      assert.ok(!result.stdout.includes('\u001b'), 'no raw escape reaches the terminal');
      const lines = linesOf(result);
      assert.ok(
        lines.some((line) => line.includes('has a skill named "a\\u001b[2Jb", which is refused')),
      );
      assert.ok(lines.some((line) => line.includes('has a skill named "*", which is refused')));
      // the planted entry is dropped from the record, which a run would rewrite
      assert.ok(lines.includes('would rewrite ".agents/skills/.package-skills.json"'));
      assert.ok(!lines.some((line) => line.includes('../x')));
      assert.equal(readFileSync(join(base, 'x'), 'utf8'), 'outside\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  '--check exits 2 on a usage error or a layout it refuses, writing nothing',
  {
    tags: ['edge-case'],
    meta: {
      spec: 'check-layout-problem-exits-2',
      arrange:
        'an unknown argument, a .agents that is a link, and a .claude/skills that links somewhere else than ../.agents/skills',
      act: 'package-skills --check runs in each',
      assert: 'it prints the problem and exits 2, and nothing is read or written through the links',
    },
  },
  () => {
    const { base, repo } = setUp();
    try {
      const outside = join(base, 'outside');
      mkdirSync(join(outside, 'skills'), { recursive: true });
      writeFileSync(join(outside, 'skills', 'keep.txt'), 'keep\n');

      const usage = runCheck(base, repo, ['--bogus']);
      assert.equal(usage.status, 2);
      assert.match(usage.stderr, /unknown argument --bogus/);
      assert.equal(usage.stdout, '');

      symlinkSync(outside, join(repo, '.agents'));
      const agents = runCheck(base, repo);
      assert.equal(agents.status, 2);
      assert.match(agents.stderr, /\.agents is a symbolic link/);
      assert.equal(agents.stdout, '');
      rmSync(join(repo, '.agents'));

      mkdirSync(join(repo, '.claude'));
      symlinkSync(join(outside, 'skills'), join(repo, '.claude', 'skills'));
      const claude = runCheck(base, repo);
      assert.equal(claude.status, 2);
      assert.match(
        claude.stderr,
        /\.claude\/skills is a link to .*; a lab links it to \.\.\/\.agents\/skills/,
      );
      assert.equal(claude.stdout, '');
      rmSync(join(repo, '.claude', 'skills'));

      // a link planted at .agents/skills, and --link or --force do not change the verdict
      mkdirSync(join(repo, '.agents'));
      symlinkSync(outside, join(repo, '.agents', 'skills'));
      const skillsLink = runCheck(base, repo, ['--link', '--force']);
      assert.equal(skillsLink.status, 2);
      assert.match(skillsLink.stderr, /\.agents\/skills is a symbolic link/);
      assert.deepEqual(readdirSync(join(outside, 'skills')), ['keep.txt']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  '--check writes nothing and reads nothing through a link planted in a target folder',
  {
    tags: ['invariant'],
    meta: {
      spec: 'check-writes-nothing',
      arrange:
        'an installed repository with links planted in the target folder (a skill name, the record and the .gitignore), a folder the person owns, and a fresh repository',
      act: 'package-skills --check runs in each, with and without --link and --force',
      assert:
        'the files, modes and contents of the whole tree below the fixture are equal before and after every run, and a record or .gitignore that is a link is read as nothing',
    },
  },
  () => {
    const { base, pkg, repo } = setUp();
    try {
      const outside = join(base, 'outside');
      mkdirSync(join(outside, 'folder'), { recursive: true });
      writeFileSync(join(outside, 'folder', 'keep.txt'), 'keep\n');
      writeFileSync(
        join(outside, 'record.json'),
        JSON.stringify({ entries: { mine: { mode: 'copy', hash: 'x' } } }),
      );
      writeFileSync(join(outside, 'ignore.txt'), 'untouched\n');
      // the tree is read-only for the check, whatever its modes
      chmodSync(join(outside, 'ignore.txt'), 0o600);

      // a fresh repository: every variant plans, none creates a folder
      for (const args of [[], ['--link'], ['--force'], ['--root', repo]]) {
        runCheck(base, repo, args);
        assert.ok(!existsSync(join(repo, '.claude')) && !existsSync(join(repo, '.agents')));
      }

      // links planted where a skill, the record and the .gitignore go
      linkClaudeSkills(repo);
      const skills = join(repo, '.agents', 'skills');
      mkdirSync(join(skills, 'mine'), { recursive: true });
      writeFileSync(join(skills, 'mine', 'SKILL.md'), '# mine\n');
      symlinkSync(join(outside, 'folder'), join(skills, 'alpha'));
      symlinkSync(join(outside, 'record.json'), join(skills, '.package-skills.json'));
      symlinkSync(join(outside, 'ignore.txt'), join(skills, '.gitignore'));
      for (const args of [[], ['--link'], ['--force'], ['--link', '--force']]) {
        const result = runCheck(base, repo, args);
        assert.equal(result.status, 1, args.join(' '));
        // the planted link is the person's: a conflict, never replaced; the record that is a link claims nothing,
        // so the person's folder is not ours to remove either
        assert.ok(
          linesOf(result).includes(
            'would fail: .agents/skills/alpha exists and was not installed by package-skills; left alone',
          ),
          result.stdout,
        );
        assert.ok(
          !linesOf(result).some((line) => line.includes('"mine"') || line.includes('/mine')),
        );
        // the record and the .gitignore are regular files in a run's eyes only: both would be replaced
        assert.ok(linesOf(result).includes('would rewrite ".agents/skills/.package-skills.json"'));
        assert.ok(linesOf(result).includes('would rewrite ".agents/skills/.gitignore"'));
      }
      assert.equal(readFileSync(join(outside, 'ignore.txt'), 'utf8'), 'untouched\n');

      // the same after a real install (and an upgrade), in the copy and the link mode
      rmSync(join(skills, 'alpha'));
      rmSync(join(skills, '.package-skills.json'));
      rmSync(join(skills, '.gitignore'));
      assert.equal(run(repo, ['--link']).status, 0);
      writeFileSync(join(pkg, 'skills', 'alpha', 'SKILL.md'), '# alpha, changed\n');
      for (const args of [[], ['--link'], ['--force']]) runCheck(base, repo, args);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);

// The `devSkills` list, its selection forms, the old key and the rename of the record file.

const PACKAGE = '@gergelyszerovay/architecture-skills';
const ALL_TARGETS = ['.claude/skills', '.agents/skills'];

/** The skills a target folder holds, without the record and the `.gitignore`. */
const installedIn = (repo, target) =>
  readdirSync(join(repo, target))
    .filter((name) => !name.startsWith('.'))
    .sort();

test('an array devSkills installs every skill of each listed package', () => {
  const { base, repo } = setUp();
  try {
    installOtherPackage(repo, { lab: '# lab\n', more: '# more\n' });
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    for (const target of ALL_TARGETS) {
      assert.deepEqual(installedIn(repo, target), ['alpha', 'beta', 'lab', 'more']);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('"*" installs every skill, and a skill the package adds later is installed on the next run', () => {
  const { base, pkg, repo } = setUp();
  try {
    setDevSkills(repo, { [PACKAGE]: '*' });
    assert.equal(run(repo).status, 0);
    assert.deepEqual(installedIn(repo, '.agents/skills'), ['alpha', 'beta']);
    writeSkill(pkg, 'gamma');
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /installed the skill gamma \(from @gergelyszerovay\/architecture-skills\)/,
    );
    for (const target of ALL_TARGETS) {
      assert.deepEqual(installedIn(repo, target), ['alpha', 'beta', 'gamma']);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a list installs only the named skills; --check reports a shipped skill the list leaves out as available, and exits 0', () => {
  const { base, repo } = setUp();
  try {
    setDevSkills(repo, { [PACKAGE]: ['alpha'] });
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    for (const target of ALL_TARGETS) {
      assert.deepEqual(installedIn(repo, target), ['alpha']);
      assert.deepEqual(Object.keys(record(repo, target).entries), ['alpha']);
    }
    const check = run(repo, ['--check']);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(check.stderr, '');
    assert.equal(
      check.stdout,
      'available, not selected: "beta" of @gergelyszerovay/architecture-skills (add it to its devSkills entry to install it)\n',
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a list or an exclude naming a skill the package does not ship fails, naming the package skills, and changes nothing', () => {
  const { base, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    const before = readFileSync(join(repo, '.agents/skills/.package-skills.json'), 'utf8');
    for (const [selection, word] of [
      [['alpha', 'gama'], 'names'],
      [{ exclude: ['gama'] }, 'excludes'],
    ]) {
      setDevSkills(repo, { [PACKAGE]: selection });
      const result = run(repo);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `package-skills: ${PACKAGE.replace('/', '\\/')} does not ship the skill "gama" that devSkills ${word}; it ships alpha, beta`,
        ),
      );
      const check = run(repo, ['--check']);
      assert.equal(check.status, 1);
      assert.match(check.stdout, /would fail: .* does not ship the skill "gama"/);
      // nothing installed earlier is removed
      for (const target of ALL_TARGETS) {
        assert.deepEqual(installedIn(repo, target), ['alpha', 'beta']);
      }
      assert.equal(readFileSync(join(repo, '.agents/skills/.package-skills.json'), 'utf8'), before);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('exclude installs all but the named skills', () => {
  const { base, repo } = setUp();
  try {
    setDevSkills(repo, { [PACKAGE]: { exclude: ['beta'] } });
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    for (const target of ALL_TARGETS) assert.deepEqual(installedIn(repo, target), ['alpha']);
    const check = run(repo, ['--check']);
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /available, not selected: "beta" of/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a skill no longer selected is removed, like one the package dropped', () => {
  const { base, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    setDevSkills(repo, { [PACKAGE]: ['alpha'] });
    const check = run(repo, ['--check']);
    assert.equal(check.status, 1);
    assert.match(check.stdout, /would remove "\.agents\/skills\/beta"/);
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /removed "\.agents\/skills\/beta"/);
    for (const target of ALL_TARGETS) {
      assert.ok(!existsSync(join(repo, target, 'beta')));
      assert.deepEqual(Object.keys(record(repo, target).entries), ['alpha']);
      assert.ok(!readFileSync(join(repo, target, '.gitignore'), 'utf8').includes('/beta/'));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a name two packages ship is refused, unless the selection leaves it to one package', () => {
  const { base, repo } = setUp();
  try {
    installOtherPackage(repo, { alpha: '# the other alpha\n', lab: '# lab\n' });
    const refused = run(repo);
    assert.equal(refused.status, 1);
    assert.match(
      refused.stderr,
      /the skill alpha is provided by .* and @lab\/lab; neither installs it/,
    );
    assert.ok(!existsSync(join(repo, '.agents/skills/alpha')));

    // the exclude form leaves alpha to the first package, the list form to the second
    setDevSkills(repo, { [PACKAGE]: '*', '@lab/lab': ['lab'] });
    const first = run(repo);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(repo, '.agents/skills/alpha/SKILL.md'), 'utf8'), '# alpha\n');
    assert.deepEqual(installedIn(repo, '.agents/skills'), ['alpha', 'beta', 'lab']);

    setDevSkills(repo, { [PACKAGE]: { exclude: ['alpha'] }, '@lab/lab': '*' });
    const second = run(repo);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      readFileSync(join(repo, '.agents/skills/alpha/SKILL.md'), 'utf8'),
      '# the other alpha\n',
    );
    assert.equal(record(repo, '.agents/skills').entries.alpha.package, '@lab/lab');
    assert.equal(run(repo, ['--check']).status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('installSkills without devSkills installs as before and warns once; both keys fail the run', () => {
  const { base, repo } = setUp();
  try {
    const rootFile = join(repo, 'package.json');
    const rootPackage = JSON.parse(readFileSync(rootFile, 'utf8'));
    writeFileSync(
      rootFile,
      JSON.stringify({
        devDependencies: rootPackage.devDependencies,
        installSkills: [PACKAGE],
      }),
    );
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    const warnings = result.stderr.split('\n').filter((line) => line.includes('warning'));
    assert.equal(warnings.length, 1, result.stderr);
    assert.match(warnings[0], /`installSkills` in package.json is the old name of `devSkills`/);
    for (const target of ALL_TARGETS)
      assert.deepEqual(installedIn(repo, target), ['alpha', 'beta']);

    const check = run(repo, ['--check']);
    assert.equal(check.status, 0, check.stdout);
    assert.equal(check.stdout, '');
    assert.match(check.stderr, /warning: `installSkills`/);

    // both keys: the run fails and touches nothing
    const before = readFileSync(join(repo, '.agents/skills/.package-skills.json'), 'utf8');
    writeFileSync(
      rootFile,
      JSON.stringify({
        devDependencies: rootPackage.devDependencies,
        installSkills: [PACKAGE],
        devSkills: [PACKAGE],
      }),
    );
    const both = run(repo);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /holds both `devSkills` and `installSkills`/);
    assert.equal(readFileSync(join(repo, '.agents/skills/.package-skills.json'), 'utf8'), before);
    assert.equal(run(repo, ['--check']).status, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('refuses a devSkills that is neither an array nor an object of selections', () => {
  const { base, repo } = setUp();
  try {
    for (const bad of [
      'alpha',
      [1],
      { [PACKAGE]: 'alpha' },
      { [PACKAGE]: { include: ['alpha'] } },
      { [PACKAGE]: { exclude: ['alpha'], extra: true } },
      { [PACKAGE]: [''] },
    ]) {
      setDevSkills(repo, bad);
      const result = run(repo);
      assert.equal(result.status, 1, JSON.stringify(bad));
      assert.match(result.stderr, /`devSkills` in package.json must be an array of package names/);
      assert.deepEqual(readdirSync(join(repo)).includes('.agents'), false);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a target holding .install-skills.json is read and rewritten as .package-skills.json, reinstalling nothing', () => {
  const { base, repo } = setUp();
  try {
    assert.equal(run(repo).status, 0);
    const marks = {};
    for (const target of ALL_TARGETS) {
      const folder = join(repo, target);
      // what the 0.8 line left: the record under its old name, and a .gitignore naming it
      renameSync(join(folder, '.package-skills.json'), join(folder, '.install-skills.json'));
      writeFileSync(
        join(folder, '.gitignore'),
        readFileSync(join(folder, '.gitignore'), 'utf8').replace(
          '/.package-skills.json',
          '/.install-skills.json',
        ),
      );
      marks[target] = lstatSync(join(folder, 'alpha', 'SKILL.md')).mtimeMs;
    }
    const check = run(repo, ['--check']);
    assert.equal(check.status, 1);
    assert.match(
      check.stdout,
      /would remove "\.agents\/skills\/\.install-skills\.json" \(the record of install-skills, replaced by \.package-skills\.json\)/,
    );
    assert.match(check.stdout, /would write "\.agents\/skills\/\.package-skills\.json"/);
    assert.doesNotMatch(check.stdout, /would (install|refresh)/);

    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /for the first time|removed/);
    for (const target of ALL_TARGETS) {
      const folder = join(repo, target);
      assert.ok(!existsSync(join(folder, '.install-skills.json')));
      assert.deepEqual(Object.keys(record(repo, target).entries), ['alpha', 'beta']);
      assert.match(readFileSync(join(folder, '.gitignore'), 'utf8'), /^\/\.package-skills\.json$/m);
      assert.equal(lstatSync(join(folder, 'alpha', 'SKILL.md')).mtimeMs, marks[target]);
    }
    assert.equal(run(repo, ['--check']).status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the bin is install-package-skills, package-skills is its second name, and its usage and messages name devSkills', () => {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'install-package-skills');
  assert.deepEqual(Object.keys(manifest.bin), ['install-package-skills', 'package-skills']);
  assert.equal(manifest.bin['install-package-skills'], 'bin/package-skills.mjs');
  assert.equal(manifest.bin['package-skills'], 'bin/package-skills.mjs');
  assert.equal(manifest.releaseTools.npmName, 'install-package-skills');

  const help = run(process.cwd(), ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: install-package-skills \[--check\]/);
  assert.match(help.stdout, /devSkills/);
  const unknown = run(process.cwd(), ['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^package-skills: unknown argument --nope/);

  const { base, repo } = setUp();
  try {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ devDependencies: { [PACKAGE]: '*' } }),
    );
    const missing = run(repo);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /package-skills: package\.json at .* has no `devSkills` field/);
    assert.match(missing.stderr, /is not in devSkills of package\.json/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Installs a package as pnpm lays out an npm alias: declared under `key` as `npm:<target>@<range>`,
 * placed at `node_modules/<key>`, its manifest named `name` (the target by default).
 */
const installAlias = (
  repo,
  skills,
  { key = 'markdown-schema', spec = 'npm:@acme/markdown-schema@^0.13.8', name, listed } = {},
) => {
  const rootFile = join(repo, 'package.json');
  const rootPackage = JSON.parse(readFileSync(rootFile, 'utf8'));
  rootPackage.devDependencies = { ...rootPackage.devDependencies, [key]: spec };
  if (listed !== undefined) rootPackage.devSkills = [...rootPackage.devSkills, listed];
  writeFileSync(rootFile, JSON.stringify(rootPackage));
  const folder = join(repo, 'node_modules', key);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'package.json'),
    JSON.stringify({
      name: name ?? spec.slice('npm:'.length).replace(/(?<=.)@[^@/]*$/, ''),
      version: '0.13.8',
      exports: { './skills/*': './skills/*' },
    }),
  );
  for (const [skill, body] of Object.entries(skills)) writeSkill(folder, skill, body);
  return folder;
};

test('an npm alias in devDependencies installs its skills under the declared key, copied and linked, and records the key', () => {
  const { base, repo } = setUp();
  try {
    installAlias(repo, { schema: '# schema\n' }, { listed: 'markdown-schema' });
    const copied = run(repo);
    assert.equal(copied.status, 0, copied.stderr);
    assert.match(copied.stdout, /installed the skill schema \(from markdown-schema\)/);
    for (const target of ALL_TARGETS) {
      assert.ok(existsSync(join(repo, target, 'schema', 'SKILL.md')));
      assert.equal(record(repo, target).entries.schema.package, 'markdown-schema');
      assert.equal(record(repo, target).packages['markdown-schema'], '0.13.8');
    }
    const linked = run(repo, ['--link', '--force']);
    assert.equal(linked.status, 0, linked.stderr);
    for (const target of ALL_TARGETS) {
      assert.equal(
        readlinkSync(join(repo, target, 'schema')),
        join('..', '..', 'node_modules', 'markdown-schema', 'skills', 'schema'),
      );
    }
    assert.match(linked.stdout, /schema/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an npm alias without a range, and an unscoped target, are accepted', () => {
  const { base, repo } = setUp();
  try {
    installAlias(
      repo,
      { one: '# one\n' },
      { key: 'ms', spec: 'npm:@acme/markdown-schema', listed: 'ms' },
    );
    installAlias(
      repo,
      { two: '# two\n' },
      { key: 'plain', spec: 'npm:left-pad@1.0.0', listed: 'plain' },
    );
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(installedIn(repo, '.agents/skills'), ['alpha', 'beta', 'one', 'two']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the selection forms work on an alias key, and a clash between an alias and another package names the key', () => {
  const { base, repo } = setUp();
  try {
    installAlias(repo, { a: '# a\n', b: '# b\n', alpha: '# other alpha\n' });
    setDevSkills(repo, {
      '@gergelyszerovay/architecture-skills': '*',
      'markdown-schema': ['a'],
    });
    assert.equal(run(repo).status, 0);
    assert.deepEqual(installedIn(repo, '.agents/skills'), ['a', 'alpha', 'beta']);
    setDevSkills(repo, {
      '@gergelyszerovay/architecture-skills': '*',
      'markdown-schema': { exclude: ['a', 'alpha'] },
    });
    assert.equal(run(repo).status, 0);
    assert.deepEqual(installedIn(repo, '.agents/skills'), ['alpha', 'b', 'beta']);
    setDevSkills(repo, ['@gergelyszerovay/architecture-skills', 'markdown-schema']);
    const clash = run(repo);
    assert.equal(clash.status, 1);
    assert.match(
      clash.stderr,
      /the skill alpha is provided by @gergelyszerovay\/architecture-skills and markdown-schema/,
    );
    setDevSkills(repo, { 'markdown-schema': ['nope'] });
    const unknown = run(repo);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /markdown-schema does not ship the skill "nope"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an alias whose installed manifest names another package than its target is refused, naming both', () => {
  const { base, repo } = setUp();
  try {
    installAlias(
      repo,
      { sneaky: '# s\n' },
      { name: '@gergelyszerovay/lab', listed: 'markdown-schema' },
    );
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /markdown-schema is installed in node_modules but its package\.json names "@gergelyszerovay\/lab", not "@acme\/markdown-schema", the package it is declared as an alias of; it is skipped/,
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'sneaky')));
    // a manifest that names the key itself is no better than a plain mismatch: the target is what counts
    installAlias(repo, { sneaky: '# s\n' }, { name: 'markdown-schema' });
    const keyNamed = run(repo);
    assert.equal(keyNamed.status, 1);
    assert.match(keyNamed.stderr, /names "markdown-schema", not "@acme\/markdown-schema"/);
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'sneaky')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a plain key whose manifest names another package is still refused, even when another key is an alias', () => {
  const { base, repo } = setUp();
  try {
    installAlias(repo, { schema: '# schema\n' }, { listed: 'markdown-schema' });
    const evil = installOtherPackage(repo, { sneaky: '# s\n' }, { name: 'evil' });
    writeFileSync(
      join(evil, 'package.json'),
      JSON.stringify({
        name: '@acme/markdown-schema',
        exports: { './skills/*': './skills/*' },
      }),
    );
    const result = run(repo);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /evil is installed in node_modules but its package\.json names "@acme\/markdown-schema"; it is skipped \(a declared package must carry the name it is declared under\)/,
    );
    assert.ok(existsSync(join(repo, '.agents', 'skills', 'schema')));
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'sneaky')));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--check after an alias install reports nothing to change, for copies and for links', () => {
  const { base, repo } = setUp();
  try {
    installAlias(repo, { schema: '# schema\n' }, { listed: 'markdown-schema' });
    assert.equal(run(repo).status, 0);
    const copied = runCheck(base, repo);
    assert.equal(copied.status, 0, copied.stdout + copied.stderr);
    assert.deepEqual(linesOf(copied), []);
    assert.equal(run(repo, ['--link', '--force']).status, 0);
    const linked = runCheck(base, repo, ['--link']);
    assert.equal(linked.status, 0, linked.stdout + linked.stderr);
    assert.deepEqual(linesOf(linked), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an unlisted alias that exports skills is reported under its key and installs nothing', () => {
  const { base, repo } = setUp();
  try {
    installAlias(repo, { schema: '# schema\n', extra: '# extra\n' });
    const result = run(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /markdown-schema exports the skills extra, schema and is not in devSkills/,
    );
    assert.ok(!existsSync(join(repo, '.agents', 'skills', 'schema')));
    const check = runCheck(base, repo);
    assert.ok(
      linesOf(check).some((line) =>
        line.includes('markdown-schema exports the skills extra, schema and is not in devSkills'),
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
