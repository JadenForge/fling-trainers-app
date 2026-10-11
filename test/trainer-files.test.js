import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectFileKind, extractZip, findExecutable, findTrainerBinary } from '../src/trainer-files.js';
import { createTrainerLaunchGuard } from '../src/trainer-launch-guard.js';

const execFile = promisify(execFileCallback);

test('finds the trainer matching the game name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trainer-files-'));
  try {
    const exe = path.join(root, 'Black.Myth.Wukong.Plus.44.Trainer.exe');
    await writeFile(exe, 'fixture');
    assert.equal(await findExecutable(root, ['黑神话：悟空', 'Black Myth: Wukong Trainer']), exe);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses a single executable as a fallback when its name is generic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trainer-files-'));
  try {
    const exe = path.join(root, 'FLiNGTrainer.exe');
    await writeFile(exe, 'fixture');
    assert.equal(await findTrainerBinary(root, ['Hogwarts Legacy']), exe);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not guess when an archive contains multiple unrelated executables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trainer-files-'));
  try {
    await writeFile(path.join(root, 'Trainer.exe'), 'fixture');
    await writeFile(path.join(root, 'Updater.exe'), 'fixture');
    assert.equal(await findTrainerBinary(root, ['Hogwarts Legacy']), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extracts a ZIP and locates the game trainer inside it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trainer-files-'));
  try {
    const source = path.join(root, 'source');
    const archive = path.join(root, 'trainer.zip');
    const destination = path.join(root, 'extracted');
    const exe = path.join(source, 'Black Myth Wukong', 'Black.Myth.Wukong.Plus.44.Trainer.exe');
    await mkdir(path.dirname(exe), { recursive: true });
    await writeFile(exe, 'fixture');
    await execFile('tar', ['-a', '-c', '-f', archive, '-C', source, '.']);

    assert.deepEqual(await extractZip(archive, destination), { ok: true });
    const found = await findTrainerBinary(destination, ['Black Myth: Wukong']);
    assert.ok(found);
    assert.equal(await readFile(found, 'utf8'), 'fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects a PE executable returned with a ZIP filename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trainer-files-'));
  try {
    const file = path.join(root, 'download.zip');
    await writeFile(file, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
    assert.equal(await detectFileKind(file), 'exe');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks a second instance of the same trainer while allowing a different trainer', () => {
  const guard = createTrainerLaunchGuard({}, () => true);
  assert.deepEqual(guard.claim('hogwarts-legacy-trainers'), { ok: true });
  assert.deepEqual(guard.claim('hogwarts-legacy-trainers'), { ok: false, pending: true });
  assert.deepEqual(guard.claim('black-myth-wukong-trainer'), { ok: true });
});

test('blocks a tracked live trainer and releases a stale process record', () => {
  const alive = new Set([101]);
  const guard = createTrainerLaunchGuard({
    'hogwarts-legacy-trainers': { pid: 101, file: 'hogwarts.exe' },
    'black-myth-wukong-trainer': { pid: 202, file: 'wukong.exe' },
  }, (pid) => alive.has(pid));

  assert.deepEqual(guard.claim('hogwarts-legacy-trainers'), {
    ok: false,
    record: { pid: 101, file: 'hogwarts.exe' },
  });
  assert.deepEqual(guard.claim('black-myth-wukong-trainer'), { ok: true });
  assert.deepEqual(guard.snapshot(), { 'hogwarts-legacy-trainers': { pid: 101, file: 'hogwarts.exe' } });
});
