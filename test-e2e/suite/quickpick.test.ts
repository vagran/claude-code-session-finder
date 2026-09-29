import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.resolve(__dirname, '../../../package.json'));

// An onDidChangeActive-based wait was tried first and measured flaky here: it can
// resolve on an intermediate event (e.g. the initial item becoming active) before
// VS Code has finished re-filtering against the new qp.value, giving a false
// "still active" reading for the control case below. A fixed delay, verified
// against this VS Code build, settles reliably; see task-12-report.md.
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

suite('Quick Pick surface', () => {
  // launchArgs: ['--disable-extensions'] (below, in runTest.ts) disables
  // anthropic.claude-code, and our extensionDependencies makes activation of THIS
  // extension depend on that one — so sessionOrganizer.search is never actually
  // registered in this test run. That is correct product behaviour (a hard
  // dependency really is required), just unobservable under --disable-extensions.
  // Assert on the installed manifest instead, which VS Code loads regardless of
  // activation. Do not "fix" this by removing --disable-extensions.
  test('the extension is installed and declares the search command + its hard dependency', () => {
    const id = `${pkg.publisher}.${pkg.name}`;
    const ext = vscode.extensions.getExtension(id);
    assert.ok(ext, `extension ${id} should be installed`);
    const manifest = ext!.packageJSON;
    const commands: Array<{ command: string }> = manifest.contributes?.commands ?? [];
    assert.ok(
      commands.some(c => c.command === 'sessionOrganizer.search'),
      'manifest must contribute the sessionOrganizer.search command',
    );
    assert.ok(
      (manifest.extensionDependencies ?? []).includes('anthropic.claude-code'),
      'manifest must declare anthropic.claude-code as a hard extensionDependency',
    );
  });

  // F7: VS Code re-filters QuickPick items by label; alwaysShow is the documented
  // opt-out. qp.items is just what we assigned — it is never mutated by the
  // filter — so the only place the filter's effect is observable is
  // qp.activeItems (the items VS Code currently considers "shown"). The two
  // cases below are a deliberate contrast: if VS Code ever stops honouring
  // alwaysShow, the first case fails; if the test setup itself were wrong, the
  // second (control) case would fail and say so.
  test('alwaysShow:true keeps a non-matching item active after VS Code filters', async () => {
    const qp = vscode.window.createQuickPick();
    qp.items = [{ label: 'Paste-image handling in the composer', alwaysShow: true }];
    qp.show();
    qp.value = 'zzz-not-in-the-label';
    await delay(500);
    assert.strictEqual(qp.activeItems.length, 1, 'alwaysShow item must remain active after a non-matching filter');
    qp.dispose();
  });

  test('control: the same item WITHOUT alwaysShow is filtered out of active', async () => {
    const qp = vscode.window.createQuickPick();
    qp.items = [{ label: 'Paste-image handling in the composer' }]; // no alwaysShow
    qp.show();
    qp.value = 'zzz-not-in-the-label';
    await delay(500);
    assert.strictEqual(qp.activeItems.length, 0, 'without alwaysShow, VS Code must filter the item out of active');
    qp.dispose();
  });
});
