import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoDir, 'dist', 'index.js');
const failTrashLoaderPath = path.join(repoDir, 'test', 'fixtures', 'fail-trash-loader.mjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function makeEnv(configHome) {
  const primaryDir = path.join(configHome, 'imsq');
  fs.mkdirSync(primaryDir, { recursive: true });
  fs.writeFileSync(path.join(primaryDir, 'options.json'), '{"options":{}}');
  return {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    FORCE_COLOR: '0',
    COLORTERM: '',
  };
}

function runCli({ cwd, args, input = '', env = makeEnv(cwd), timeout = 10000, nodeArgs = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cliPath, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function startWatch({ cwd, args, configHome = cwd }) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: makeEnv(configHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, getOutput: () => ({ stdout, stderr }) };
}

async function waitFor(predicate, timeout = 7000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
}

function writePng(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, png);
}

test('same-path output keeps a hidden backup when trash fails or does nothing', async () => {
  for (const trashMode of ['throw', 'noop']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputPath = path.join(root, 'input.png');
    writePng(inputPath);
    try {
      const result = await runCli({
        cwd: root,
        args: ['-d', '.'],
        input: 'input.png\n',
        env: { ...makeEnv(root), ...(trashMode === 'noop' ? { IMSQ_TEST_TRASH_NOOP: '1' } : {}) },
        nodeArgs: ['--loader', failTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const backupNames = fs.readdirSync(root).filter((name) => name.startsWith('.imsq-backup-'));

      assert.match(output, /成功\s+: 1/);
      assert.equal(fs.existsSync(inputPath), true);
      assert.equal(backupNames.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(root, backupNames[0])), png);
      assert.match(output, /ゴミ箱へ移動できなかったため.*バックアップ.*\.imsq-backup-/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('pipe recursive input outside cwd is rejected without writing outside outputDir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const cwd = path.join(root, 'cwd');
  const outside = path.join(root, 'outside', 'source.png');
  fs.mkdirSync(cwd, { recursive: true });
  writePng(outside);
  try {
    const result = await runCli({ cwd, args: ['-r', '-d', 'out'], input: '../outside/source.png\n' });
    assert.match(`${result.stdout}\n${result.stderr}`, /カレントディレクトリ外|outside|拒否/);
    assert.equal(fs.existsSync(path.join(cwd, 'outside', 'source.png')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch allocates rename indexes monotonically across initial failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const bad = path.join(root, 'bad.png');
  const good = path.join(root, 'good.png');
  fs.writeFileSync(bad, 'not an image');
  writePng(good);
  const running = startWatch({ cwd: root, args: ['-w', '--poll', '-d', 'out', '-n', 'seq_*', '-f', 'webp'] });
  try {
    await waitFor(() => fs.existsSync(path.join(root, 'out', 'seq_2.webp')));
    writePng(path.join(root, 'new.png'));
    await waitFor(() => fs.existsSync(path.join(root, 'out', 'seq_3.webp')));
    assert.equal(fs.existsSync(path.join(root, 'out', 'seq_1.webp')), false);
  } finally {
    await stop(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch rejects unsupported output formats before generating files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  writePng(path.join(root, 'input.png'));
  const running = startWatch({ cwd: root, args: ['-w', '-f', 'bmp', '-d', 'out'] });
  try {
    await waitFor(() => running.child.exitCode !== null);
    const output = running.getOutput();
    assert.equal(running.child.exitCode, 1);
    assert.match(`${output.stdout}\n${output.stderr}`, /サポートされていないフォーマットです: bmp/);
    assert.doesNotMatch(output.stdout, /監視モードを起動しました。/);
    assert.equal(fs.existsSync(path.join(root, 'out', 'input.bmp')), false);
  } finally {
    await stop(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pipe line-level pick and confirm options are explicit errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  writePng(path.join(root, 'input.png'));
  try {
    const result = await runCli({
      cwd: root,
      args: ['-d', 'out'],
      input: 'input.png -p\ninput.png -c\n',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /行.*(-p|--pick).*使用できません/);
    assert.match(output, /行.*(-c|--confirm).*使用できません/);
    assert.equal(fs.existsSync(path.join(root, 'out', 'input.png')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch tracks generated files only when the output directory is monitored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  try {
    const { shouldTrackGeneratedFile } = await import('../dist/utils.js');
    assert.equal(shouldTrackGeneratedFile(root, path.join(root, 'out'), 'out/input.png', 'input.png'), false);
    assert.equal(shouldTrackGeneratedFile(root, root, 'input.webp', 'input.png'), true);
    assert.equal(shouldTrackGeneratedFile(root, root, 'input.png', 'input.png'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deletion option overrides clear the opposite mode but preserve direct conflicts', async () => {
  const { resolveDeletionOptions } = await import('../dist/utils.js');
  assert.deepEqual(resolveDeletionOptions({ hard: true }, { trash: true }), { hard: false, trash: true });
  assert.deepEqual(resolveDeletionOptions({ trash: true }, { hard: true }), { hard: true, trash: false });
  assert.deepEqual(resolveDeletionOptions({ hard: true }, { hard: true, trash: true }), { hard: true, trash: true });
});

test('nested watch output directory is excluded from initial recursive scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const outputDir = path.join(root, 'out', 'sub');
  writePng(path.join(outputDir, 'existing.png'));
  const running = startWatch({ cwd: root, args: ['-w', '-r', '-d', 'out/sub'] });
  try {
    await waitFor(() => running.getOutput().stdout.includes('監視モードを起動しました。'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(fs.existsSync(path.join(outputDir, 'out', 'sub', 'existing.png')), false);
  } finally {
    await stop(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('numeric-only preset names are not parsed as indexes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const configDir = path.join(root, 'imsq');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'options.json'), '{"options":{}}');
  fs.writeFileSync(path.join(configDir, 'presets.toml'), '[alpha]\nformat = "png"\n');
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const { getPreset, deletePreset } = await import('../dist/preset.js');
    assert.equal(getPreset('1abc'), undefined);
    assert.equal(getPreset('1')?.presetName, 'alpha');
    assert.equal(deletePreset('1abc'), undefined);
    assert.equal(deletePreset('1'), 'alpha');
  } finally {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI deletion option overrides a conflicting preset option', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const configDir = path.join(root, 'imsq');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'presets.toml'), '[hardpreset]\nhard = true\n');
  try {
    const result = await runCli({
      cwd: root,
      args: ['preset', 'hardpreset', '--trash', '-d', 'out'],
      input: 'missing.png\n',
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /--hard と --trash は同時に指定できません/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config poll remains enabled when loading a preset', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const configDir = path.join(root, 'imsq');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'options.toml'), '[watch]\npoll = true\n');
  fs.writeFileSync(path.join(configDir, 'presets.toml'), '[preset]\nformat = "png"\n');
  const running = startWatch({
    cwd: root,
    configHome: root,
    args: ['preset', 'preset', '-w', '--no-initial'],
  });
  try {
    await waitFor(() => running.getOutput().stdout.includes('監視方式         : ポーリング (usePolling)'));
  } finally {
    await stop(running.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
