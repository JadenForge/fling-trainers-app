import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function findExecutable(dir, names) {
  if (!dir || !fs.existsSync(dir)) return null;
  const keys = names
    .map((n) => String(n || '').toLowerCase().replace(/trainer|修改器/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, ''))
    .filter((key) => key.length >= 3);
  if (!keys.length) return null;

  const skipDir = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);
  const exts = process.platform === 'win32'
    ? ['.exe', '.bat', '.cmd']
    : process.platform === 'darwin'
      ? ['.app', '.exe', '.command', '.sh']
      : ['.exe', '.sh', '.appimage'];
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = await fsp.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 3 && !skipDir.has(entry.name)) queue.push({ dir: full, depth: current.depth + 1 });
        if (exts.includes(path.extname(entry.name).toLowerCase()) && matches(entry.name, keys)) return full;
      } else if (exts.includes(path.extname(entry.name).toLowerCase()) && matches(entry.name, keys)) {
        return full;
      }
    }
  }
  return null;
}

function matches(name, keys) {
  const value = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  return keys.some((key) => value.includes(key) || key.includes(value));
}

export function extractZip(file, destination) {
  return new Promise((resolve) => {
    const start = async () => {
      try {
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.mkdir(destination, { recursive: true });
        const child = spawn('tar', ['-xf', file, '-C', destination], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
        child.once('error', async (error) => {
          await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
          resolve({ ok: false, error: String(error.message || error) });
        });
        child.once('close', async (code) => {
          if (code === 0) resolve({ ok: true });
          else {
            await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
            resolve({ ok: false, error: stderr.trim() || `解压失败（退出码 ${code}）` });
          }
        });
      } catch (error) {
        resolve({ ok: false, error: String(error.message || error) });
      }
    };
    start();
  });
}

export async function findTrainerBinary(dir, names) {
  const matched = await findExecutable(dir, names);
  if (matched) return matched;

  const candidates = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    let entries = [];
    try { entries = await fsp.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 4) queue.push({ dir: full, depth: current.depth + 1 });
      else if (entry.isFile() && ['.exe', '.app', '.command', '.sh'].includes(path.extname(entry.name).toLowerCase())) {
        candidates.push(full);
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function detectFileKind(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return 'exe';
    if (bytesRead >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3])) return 'zip';
    return 'unknown';
  } finally {
    await handle.close();
  }
}
