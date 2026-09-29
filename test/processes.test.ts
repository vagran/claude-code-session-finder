import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toolRunning, startedAfter, procIoForTest, readProcSnapshot, type ToolRunningIo,
  parseRegistryEntry, isLive, readLiveProcesses, openConflict, describeProcess, procInfo, type ProcInfo,
} from '../src/core/processes.js';

const entry = (o: object) => JSON.stringify({ pid: 100, sessionId: 's1', procStart: '42', entrypoint: 'claude-vscode',
                                              kind: 'interactive', status: 'idle', ...o });

describe('parseRegistryEntry', () => {
  it('keeps the fields it knows', () => {
    expect(parseRegistryEntry(entry({ name: 'x', cwd: '/w', peerProtocol: 1 }))).toEqual({
      pid: 100, sessionId: 's1', procStart: '42', entrypoint: 'claude-vscode', kind: 'interactive',
      status: 'idle', name: 'x', cwd: '/w' });
  });
  it('rejects what it cannot use', () => {
    expect(parseRegistryEntry('not json')).toBeNull();
    expect(parseRegistryEntry('null')).toBeNull();
    expect(parseRegistryEntry(entry({ pid: '100' }))).toBeNull();
    expect(parseRegistryEntry(entry({ pid: -1 }))).toBeNull();
    expect(parseRegistryEntry(entry({ sessionId: '' }))).toBeNull();
  });
  it('drops fields of the wrong type rather than the entry', () => {
    expect(parseRegistryEntry(entry({ status: 3 }))?.status).toBeUndefined();
  });
});

describe('isLive', () => {
  const p = parseRegistryEntry(entry({}))!;
  it('is the pid, when the start time agrees', () => {
    expect(isLive(p, { alive: true, start: '42' })).toBe(true);
    expect(isLive(p, { alive: false })).toBe(false);
  });
  it('is not a reused pid: same number, later start', () => {
    expect(isLive(p, { alive: true, start: '99' })).toBe(false);
  });
  it('trusts the pid alone where either side has no start time', () => {
    expect(isLive(p, { alive: true })).toBe(true);
    expect(isLive({ pid: 1, sessionId: 's' }, { alive: true, start: '7' })).toBe(true);
  });
});

describe('procInfo', () => {
  it('sees this very process, with its parent and a start time on Linux', () => {
    const i = procInfo(process.pid);
    expect(i.alive).toBe(true);
    if (process.platform === 'linux') {
      expect(i.ppid).toBe(process.ppid);
      expect(i.start).toMatch(/^\d+$/);
    }
  });
});

describe('readLiveProcesses', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'ccsf-reg-'));
  it('is null, not empty, when there is no registry', async () => {
    expect(await readLiveProcesses(join(tmpdir(), 'ccsf-no-such-dir-' + process.pid))).toBeNull();
  });
  it('lists live entries with their parent, and skips dead ones, junk and the .key files', async () => {
    const d = dir();
    writeFileSync(join(d, '100.json'), entry({}));
    writeFileSync(join(d, '200.json'), entry({ pid: 200, sessionId: 's2' }));
    writeFileSync(join(d, '300.json'), 'garbage');
    writeFileSync(join(d, '100.abc.key'), JSON.stringify({ pid: 100, sessionId: 'from-key' }));
    const seen: number[] = [];
    const info = (pid: number): ProcInfo => { seen.push(pid); return pid === 100 ? { alive: true, start: '42', ppid: 7 } : { alive: false }; };
    const live = await readLiveProcesses(d, info);
    expect(live?.map(p => [p.pid, p.sessionId, p.ppid])).toEqual([[100, 's1', 7]]);
    expect(seen.sort()).toEqual([100, 200]);
  });
});

describe('openConflict', () => {
  const SELF = 7;
  const vsc = (o: object) => ({ ...parseRegistryEntry(entry(o))!, ppid: SELF });
  it('is unknown without a registry — the caller opens as before', () => {
    expect(openConflict(null, 's1', SELF)).toEqual({ kind: 'unknown' });
  });
  it('is none when nothing runs the session', () => {
    expect(openConflict([vsc({ sessionId: 'other', ppid: 99 })], 's1', SELF)).toEqual({ kind: 'none' });
  });
  it("is none for this window's own tab — Claude Code focuses it", () => {
    expect(openConflict([vsc({})], 's1', SELF, 'tab', true)).toEqual({ kind: 'none' });
    expect(openConflict([vsc({})], 's1', SELF, 'right', true)).toEqual({ kind: 'none' });
  });
  it("is a conflict for this window's side panel: editor.open focuses tabs only, and starts a second process", () => {
    const r = openConflict([vsc({})], 's1', SELF, 'tab', false);
    expect(r.kind === 'elsewhere' && r.processes.map(p => p.pid)).toEqual([100]);
    expect(openConflict([vsc({})], 's1', SELF).kind).toBe('elsewhere');       // hasTabHere defaults to "no"
  });
  it("is none when opened in the side panel: it reuses a session it holds, or Claude Code focuses the tab", () => {
    // the panel keeps every session it has shown alive, each a process of this window with no tab
    expect(openConflict([vsc({})], 's1', SELF, 'right', false)).toEqual({ kind: 'none' });
  });
  it('is still a conflict in the side panel for another window or a terminal', () => {
    const term = { ...parseRegistryEntry(entry({ pid: 101, entrypoint: 'cli' }))!, ppid: 55 };
    const r = openConflict([vsc({}), { ...vsc({ pid: 102 }), ppid: 99 }, term], 's1', SELF, 'right', false);
    expect(r.kind === 'elsewhere' && r.processes.map(p => p.pid)).toEqual([102, 101]);
  });
  it('is a conflict for another window, and for a terminal', () => {
    const other = { ...vsc({}), ppid: 99 };
    const term = { ...parseRegistryEntry(entry({ pid: 101, entrypoint: 'cli' }))!, ppid: 55 };
    const r = openConflict([vsc({}), other, term], 's1', SELF, 'tab', true);
    expect(r.kind === 'elsewhere' && r.processes.map(p => p.pid)).toEqual([100, 101]);
  });
  it('with no parent known, only what is certainly not a VS Code tab counts', () => {
    const noParent = (o: object) => parseRegistryEntry(entry(o))!;
    expect(openConflict([noParent({})], 's1', SELF)).toEqual({ kind: 'none' });
    expect(openConflict([noParent({})], 's1', SELF, 'tab', true)).toEqual({ kind: 'none' });
    expect(openConflict([noParent({ entrypoint: 'cli' })], 's1', SELF).kind).toBe('elsewhere');
    expect(openConflict([noParent({ entrypoint: undefined })], 's1', SELF).kind).toBe('elsewhere');
  });
});

describe('describeProcess', () => {
  it('says where, what and which pid', () => {
    expect(describeProcess({ pid: 5, sessionId: 's', entrypoint: 'cli', status: 'busy' })).toBe('a terminal (busy, pid 5)');
    expect(describeProcess({ pid: 6, sessionId: 's', entrypoint: 'claude-vscode' })).toBe('another VS Code window (pid 6)');
    expect(describeProcess({ pid: 7, sessionId: 's' })).toBe('another Claude Code process (pid 7)');
    expect(describeProcess({ pid: 8, sessionId: 's', entrypoint: 'claude-vscode', status: 'idle', ppid: 3 }, 3))
      .toBe("this window's Claude Code side panel (idle, pid 8)");
    expect(describeProcess({ pid: 9, sessionId: 's', entrypoint: 'claude-vscode', ppid: 4 }, 3)).toBe('another VS Code window (pid 9)');
  });
});

describe('toolRunning — is the pending tool call running a command?', () => {
  const BOOT = 1_000_000_000_000;                            // ms; a child's start is ticks (1/100 s) after it
  const at = (ms: number) => String((ms - BOOT) / 10);
  const SINCE = BOOT + 5_000_000;                            // the tool_use record
  const io = (children: Record<number, number[]>, starts: Record<number, number>, live = [{ pid: 10, sessionId: 's1' }]): ToolRunningIo => ({
    live: async () => live,
    children: pid => children[pid] ?? [],
    info: pid => starts[pid] !== undefined ? { alive: true, start: at(starts[pid]) } : { alive: false },
    cmdline: () => '',
    bootMs: () => BOOT,
  });
  it('yes for a child that started with the tool call', async () => {
    expect(await toolRunning('s1', SINCE, io({ 10: [11] }, { 11: SINCE + 300 }))).toBe(true);
    expect(await toolRunning('s1', SINCE, io({ 10: [11] }, { 11: SINCE - 500 }))).toBe(true);    // within the spawn slack
  });
  it('no for a background task started before it — it would hide a permission prompt', async () => {
    expect(await toolRunning('s1', SINCE, io({ 10: [11] }, { 11: SINCE - 16 * 60_000 }))).toBe(false);
  });
  it("no without children, for another session's process, and without a registry or boot time", async () => {
    expect(await toolRunning('s1', SINCE, io({}, {}))).toBe(false);
    expect(await toolRunning('s2', SINCE, io({ 10: [11] }, { 11: SINCE + 300 }))).toBe(false);
    expect(await toolRunning('s1', SINCE, { ...io({ 10: [11] }, { 11: SINCE + 300 }), live: async () => null })).toBe(false);
    expect(await toolRunning('s1', SINCE, { ...io({ 10: [11] }, { 11: SINCE + 300 }), bootMs: () => undefined })).toBe(false);
  });
  it('any of the session\'s processes counts', async () => {
    const two = [{ pid: 10, sessionId: 's1' }, { pid: 20, sessionId: 's1' }];
    expect(await toolRunning('s1', SINCE, io({ 20: [21] }, { 21: SINCE + 1 }, two))).toBe(true);
  });
  it('startedAfter converts ticks since boot to wall time', () => {
    expect(startedAfter('100', BOOT, BOOT + 1_000)).toBe(true);       // 1 s after boot, since exactly then
    expect(startedAfter('100', BOOT, BOOT + 2_001)).toBe(false);      // more than the slack before
    expect(startedAfter('x', BOOT, BOOT)).toBe(false);
  });
  it('on this machine: a child this test spawns is seen as started after "now"', async () => {
    if (process.platform !== 'linux') return;
    const { spawn } = await import('node:child_process');
    const since = Date.now();
    const child = spawn('sleep', ['5']);
    try {
      await new Promise(r => setTimeout(r, 100));
      const live = async () => [{ pid: process.pid, sessionId: 'me' }];
      const ioReal: ToolRunningIo = { ...procIoForTest, live };
      expect(await toolRunning('me', since, ioReal)).toBe(true);
      expect(await toolRunning('me', since + 60_000, ioReal)).toBe(false);
    } finally { child.kill(); }
  });
});

describe('readProcSnapshot — background tasks', () => {
  const shell = '/usr/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-x.sh 2>/dev/null || true && eval \'tail -f run.out\'';
  const io = (cmd: Record<number, string>, children: Record<number, number[]>): ToolRunningIo => ({
    live: async () => [{ pid: 10, sessionId: 's1' }, { pid: 20, sessionId: 's2' }],
    children: pid => children[pid] ?? [],
    info: () => ({ alive: true, start: '1' }),
    cmdline: pid => cmd[pid] ?? '',
    bootMs: () => 0,
  });
  it('counts the Bash tool shells under the session, and nothing else', async () => {
    const snap = (await readProcSnapshot(io({ 11: shell, 12: shell, 13: 'node /opt/mcp-server/index.js', 21: 'npx some-mcp' },
                                          { 10: [11, 12, 13], 20: [21] })))!;
    expect(snap.backgroundTasks('s1')).toBe(2);
    expect(snap.backgroundTasks('s2')).toBe(0);                 // a stdio MCP server is a child, not a task
    expect(snap.backgroundTasks('nobody')).toBe(0);
  });
  it('is null without a registry', async () => {
    expect(await readProcSnapshot({ ...io({}, {}), live: async () => null })).toBeNull();
  });
  it('on this machine: a Bash-tool-shaped child is seen', async () => {
    if (process.platform !== 'linux') return;
    const { spawn } = await import('node:child_process');
    const child = spawn('sh', ['-c', 'sleep 5; true', '/x/.claude/shell-snapshots/snapshot-test']);   // $0 lands in cmdline; `; true` keeps sh from exec-ing sleep
    try {
      await new Promise(r => setTimeout(r, 100));
      const snap = (await readProcSnapshot({ ...procIoForTest, live: async () => [{ pid: process.pid, sessionId: 'me' }] }))!;
      expect(snap.backgroundTasks('me')).toBeGreaterThanOrEqual(1);
    } finally { child.kill(); }
  });
});

describe('readProcSnapshot — status', () => {
  const io = (live: Array<{ pid: number; sessionId: string; status?: string }>): ToolRunningIo =>
    ({ live: async () => live, children: () => [], info: () => ({ alive: true }), cmdline: () => '', bootMs: () => 0 });
  it("reports the registry's status, and with two processes the one that needs you", async () => {
    const snap = (await readProcSnapshot(io([
      { pid: 1, sessionId: 's1', status: 'idle' }, { pid: 2, sessionId: 's1', status: 'waiting' },
      { pid: 3, sessionId: 's2', status: 'busy' }, { pid: 4, sessionId: 's3' },
    ])))!;
    expect(snap.status('s1')).toBe('waiting');
    expect(snap.status('s2')).toBe('busy');
    expect(snap.status('s3')).toBeUndefined();
    expect(snap.status('nobody')).toBeUndefined();
  });
});
