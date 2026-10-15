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
const wslTrashLoaderPath = path.join(repoDir, 'test', 'fixtures', 'wsl-trash-loader.mjs');
const wslTrashProbePath = path.join(repoDir, 'test', 'fixtures', 'wsl-trash-probe.mjs');
const wslExistsRacePreloadPath = path.join(repoDir, 'test', 'fixtures', 'wsl-exists-race-preload.mjs');
const wslPowerShellPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const windowsPowerShellRoot = String.raw`C:\Windows`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const resizePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8DwHxkDAEPNB/nd70idAAAAAElFTkSuQmCC',
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

function runNodeScript({ cwd, scriptPath, env, nodeArgs = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, scriptPath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
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
  const trashCases = [
    {
      env: { IMSQ_TEST_TRASH_STDERR: 'PowerShell: Access is denied' },
      reason: 'PowerShell: Access is denied',
    },
    {
      env: {
        IMSQ_TEST_TRASH_MESSAGE: 'PowerShell failed: C:\\Windows\\System32\\powershell.exe -EncodedCommand VERY_LONG_ENCODED_COMMAND',
      },
      reason: 'PowerShell failed: C:\\Windows\\System32\\powershell.exe -EncodedCommand (省略)',
      hidden: 'VERY_LONG_ENCODED_COMMAND',
    },
    {
      env: { IMSQ_TEST_TRASH_NOOP: '1' },
      reason: '元ファイルがゴミ箱へ移動されませんでした',
    },
  ];
  for (const trashCase of trashCases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputPath = path.join(root, 'input.png');
    writePng(inputPath);
    try {
      const result = await runCli({
        cwd: root,
        args: ['-d', '.'],
        input: 'input.png\n',
        env: { ...makeEnv(root), ...trashCase.env },
        nodeArgs: ['--loader', failTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const backupNames = fs.readdirSync(root).filter((name) => name.startsWith('.imsq-backup-'));

      assert.match(output, /成功\s+: 1/);
      assert.equal(fs.existsSync(inputPath), true);
      assert.equal(backupNames.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(root, backupNames[0])), png);
      assert.match(output, /ゴミ箱へ移動できなかったため.*バックアップ.*\.imsq-backup-/);
      const flattenedOutput = output.replace(/\s+/gu, ' ');
      assert.ok(flattenedOutput.includes(trashCase.reason), flattenedOutput);
      if (trashCase.hidden) assert.doesNotMatch(output, new RegExp(trashCase.hidden));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('WSL Windows-local trash passes the WSL PowerShell path and preserves literal paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const env = {
    ...makeEnv(root),
    IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
    SYSTEMROOT: windowsPowerShellRoot,
  };
  try {
    const result = await runNodeScript({
      cwd: repoDir,
      scriptPath: wslTrashProbePath,
      env,
      nodeArgs: ['--loader', wslTrashLoaderPath],
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /WSL trash boundary passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WSL trash handles same-path and separate-output CLI flows without a backup warning', async () => {
  for (const outputDir of ['.', 'out']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputName = 'input.png';
    const inputPath = path.join(root, inputName);
    writePng(inputPath);
    try {
      const result = await runCli({
        cwd: root,
        args: ['--trash', '-d', outputDir],
        input: `${inputName}\n`,
        env: {
          ...makeEnv(root),
          IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
          SYSTEMROOT: windowsPowerShellRoot,
          IMSQ_TEST_WSL_SOURCE_PATH: inputPath,
        },
        nodeArgs: ['--loader', wslTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 0, output);
      assert.match(output, /成功\s+: 1/);
      assert.doesNotMatch(output, /バックアップ/);
      assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.imsq-backup-')), false);
      assert.equal(fs.existsSync(path.join(root, outputDir, inputName)), true);
      if (outputDir === 'out') {
        assert.equal(fs.existsSync(inputPath), false);
      }
    } finally {
    fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('WSL trash keeps same-path output when the original reaches the bin before PowerShell rejects', async () => {
  for (const staleExists of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputPath = path.join(root, 'input.png');
    const binPath = path.join(root, 'simulated-recycle-bin', 'input.png');
    fs.writeFileSync(inputPath, resizePng);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    try {
      const result = await runCli({
        cwd: root,
        args: ['--trash', '-l', 'w:2', '-d', '.'],
        input: 'input.png\n',
        env: {
          ...makeEnv(root),
          IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
          SYSTEMROOT: windowsPowerShellRoot,
          IMSQ_TEST_WSL_SOURCE_PATH: inputPath,
          IMSQ_TEST_WSL_BIN_PATH: binPath,
          IMSQ_TEST_WSL_REJECT_AFTER_DELETE: '1',
        },
        nodeArgs: staleExists
          ? ['--import', wslExistsRacePreloadPath, '--loader', wslTrashLoaderPath]
          : ['--loader', wslTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 0, output);
      assert.match(output, /成功\s+: 1/);
      assert.doesNotMatch(output, /ゴミ箱へ移動できなかったため/);
      assert.equal(fs.existsSync(inputPath), true);
      assert.equal(fs.existsSync(path.join(root, 'simulated-recycle-bin', 'input.png')), true);
      assert.deepEqual(fs.readFileSync(binPath), resizePng);
      assert.equal(fs.readFileSync(binPath).readUInt32BE(16), 4);
      assert.equal(fs.readFileSync(inputPath).readUInt32BE(16), 2);
      assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.imsq-backup-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('same-path output survives a WSL boundary that removes its temp file', async () => {
  const cases = [
    { args: ['--trash', '-l', 'w:2', '-d', '.'], outputPath: 'input.png', outputWidth: 2, inputRemains: true },
    { args: ['--trash', '-n', '?', '-d', '.'], outputPath: 'input.png', outputWidth: 4, inputRemains: true },
  ];
  for (const testCase of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputPath = path.join(root, 'input.png');
    const binPath = path.join(root, 'simulated-recycle-bin', 'input.png');
    fs.writeFileSync(inputPath, resizePng);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    try {
      const result = await runCli({
        cwd: root,
        args: testCase.args,
        input: 'input.png\n',
        env: {
          ...makeEnv(root),
          IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
          SYSTEMROOT: windowsPowerShellRoot,
          IMSQ_TEST_WSL_SOURCE_PATH: inputPath,
          IMSQ_TEST_WSL_BIN_PATH: binPath,
          IMSQ_TEST_WSL_DELETE_TEMP: '1',
        },
        nodeArgs: ['--loader', wslTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 0, output);
      assert.match(output, /成功\s+: 1/);
      assert.doesNotMatch(output, /画像処理エラー|バックアップ/);
      const outputPath = path.join(root, testCase.outputPath);
      assert.equal(fs.existsSync(outputPath), true);
      assert.equal(fs.readFileSync(outputPath).readUInt32BE(16), testCase.outputWidth);
      if (testCase.outputWidth === 4) {
        assert.deepEqual(fs.readFileSync(outputPath), resizePng);
      }
      assert.equal(fs.existsSync(inputPath), testCase.inputRemains);
      assert.deepEqual(fs.readFileSync(binPath), resizePng);
      assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.imsq-tmp-')), false);
      assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.imsq-backup-')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('separate compressed output writes the final buffer before trash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
  const inputPath = path.join(root, 'input.png');
  const binPath = path.join(root, 'simulated-recycle-bin', 'input.png');
  fs.writeFileSync(inputPath, resizePng);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  try {
    const result = await runCli({
      cwd: root,
      args: ['--trash', '-l', 'w:2', '-d', 'out'],
      input: 'input.png\n',
      env: {
        ...makeEnv(root),
        IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
        SYSTEMROOT: windowsPowerShellRoot,
        IMSQ_TEST_WSL_SOURCE_PATH: inputPath,
        IMSQ_TEST_WSL_BIN_PATH: binPath,
        IMSQ_TEST_WSL_DELETE_TEMP: '1',
      },
      nodeArgs: ['--loader', wslTrashLoaderPath],
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 0, output);
    assert.match(output, /成功\s+: 1/);
    assert.doesNotMatch(output, /画像処理エラー|バックアップ/);
    const outputPath = path.join(root, 'out', 'input.png');
    assert.equal(fs.readFileSync(outputPath).readUInt32BE(16), 2);
    assert.equal(fs.existsSync(inputPath), false);
    assert.deepEqual(fs.readFileSync(binPath), resizePng);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WSL trash does not report success when conversion fails or PowerShell leaves the input', async () => {
  for (const mode of ['conversion', 'noop']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgsqueeze-'));
    const inputPath = path.join(root, 'input.png');
    writePng(inputPath);
    try {
      const result = await runCli({
        cwd: root,
        args: ['--trash', '-d', 'out'],
        input: 'input.png\n',
        env: {
          ...makeEnv(root),
          IMSQ_TEST_EXPECTED_PS_PATH: wslPowerShellPath,
          SYSTEMROOT: windowsPowerShellRoot,
          IMSQ_TEST_WSL_SOURCE_PATH: inputPath,
          ...(mode === 'conversion' ? {IMSQ_TEST_WSL_CONVERSION_FAILURE: '1'} : {IMSQ_TEST_WSL_NOOP: '1'}),
        },
        nodeArgs: ['--loader', wslTrashLoaderPath],
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 0, output);
      assert.match(output, /成功\s+: 0/);
      assert.equal(fs.existsSync(inputPath), true);
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
