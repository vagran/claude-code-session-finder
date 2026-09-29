// scripts/try-local.mjs
// Try a change in this VS Code.
//   npm run try       packages the working tree exactly as a release would (vscode:prepublish,
//                     .vscodeignore), stamped with a dev version, and installs it over the
//                     installed copy on this machine. The extension is not on the Marketplace,
//                     so this is also how it is installed: run it again for the next build.
// A window keeps running the old build until its extensions restart.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devVersion, devBuildLabel } from '../src/core/dev-build.ts';   // Node strips the types

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const RESTART = 'Restart extensions in each window you want on it: Developer: Restart Extension Host, or reload the window.';

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });

// `code` is the CLI of the VS Code window whose terminal (or Claude Code session) runs this.
function code(args, { mayFail = false } = {}) {
  try {
    run('code', args);
  } catch {
    if (mayFail) return;
    throw new Error(`\`code ${args.join(' ')}\` failed. Run this from a terminal inside VS Code, where \`code\` reaches the window.`);
  }
}

// A version tagged in git is released, so the dev build has to sort above it.
function released(version) {
  try {
    return execFileSync('git', ['tag', '--list', `v${version}`], { cwd: root, encoding: 'utf8' }).trim() !== '';
  } catch {
    return true;                                    // no git: assume released, the safe side
  }
}

function tryBuild() {
  const version = devVersion(pkg.version, released(pkg.version), new Date());
  const dir = mkdtempSync(join(tmpdir(), 'ccsf-try-'));
  const vsix = join(dir, `${pkg.name}-${version}.vsix`);
  try {
    run('npx', ['--no', '@vscode/vsce', 'package', version,
                '--no-git-tag-version', '--no-update-package-json', '--no-dependencies', '-o', vsix]);
    code(['--install-extension', vsix, '--force']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nInstalled ${id} ${version}.`);
  console.log(`${RESTART} Its status bar then shows "${devBuildLabel(version)}".`);
}

try {
  tryBuild();
} catch (err) {
  console.error(`\n${err.message}`);             // the failing command has already said why
  process.exitCode = 1;
}
