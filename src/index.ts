#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { checkbox, input } from '@inquirer/prompts';
import { scanImages, parseSize, formatSize, resolveOutputDir } from './utils.js';

type StoredOptions = {
  format?: string;
  size?: string;
  length?: string;
  recursive?: boolean;
  keep?: boolean;
  name?: string;
  pick?: boolean;
  directory?: string;
  confirm?: boolean;
};

type EffectiveOptions = StoredOptions;

const program = new Command();
const stateFilePath = path.join(os.homedir(), '.imsq.json');

program
  .name('imsq')
  .description('IMG Squeeze CLI - 画像最適化CLIツール (カレントディレクトリ内の画像を最適化して出力します)')
  .version('IMG Squeeze CLI v0.1.0', '-v, --version')
  .option('-f, --format <type>', '出力形式指定 (jpg, png, gif, webp)')
  .option('-s, --size <size>', '最大ファイルサイズ指定 (例: 50kb, 100kb, 1mb)')
  .option('-l, --length <dimensions>', 'リサイズ指定 (例: w:600, h:400, w:600,h:400, w:50%, h:50%)')
  .option('-r, --recursive', 'サブディレクトリ内の画像も処理する')
  .option('-k, --keep', 'メタデータを保持する (Exif, ICC profileなど)')
  .option('-n, --name <pattern>', 'リネームパターン (* = 1桁連番, ** = 2桁, *** = 3桁)')
  .option('-p, --pick', '対話モード: 処理対象の画像を選択する')
  .option('-d, --directory <dir>', '出力先ディレクトリ指定 (例: ./output, . で現在のディレクトリ)')
  .option('-c, --confirm', '処理を開始する前に確認を挟む')
  .parse(process.argv);

function parseLengthOption(length: string): {
  widthSpec?: number | string;
  heightSpec?: number | string;
  stretchMode: boolean;
} {
  let widthSpec: number | string | undefined;
  let heightSpec: number | string | undefined;

  const parts = length.trim().toLowerCase().split(/[\s,;]+/).filter(Boolean);
  for (const part of parts) {
    const [axis, raw] = part.split(':', 2);
    if ((axis !== 'w' && axis !== 'h') || !raw) {
      throw new Error(`無効な長さ指定です: "${part}"。 "w:600", "h:400", "w:50%" の形式で指定してください。`);
    }

    const label = axis === 'w' ? '横幅' : '高さ';
    let spec: number | string;
    if (raw.endsWith('%')) {
      const pct = Number.parseFloat(raw);
      if (Number.isNaN(pct) || pct <= 0) {
        throw new Error(`${label}のパーセント値が不正です: "${part}"`);
      }
      spec = raw;
    } else {
      const value = Number.parseInt(raw, 10);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error(`${label}の値が不正です: "${part}"`);
      }
      spec = value;
    }

    if (axis === 'w') {
      widthSpec = spec;
    } else {
      heightSpec = spec;
    }
  }

  return {
    widthSpec,
    heightSpec,
    stretchMode: typeof widthSpec === 'number' && typeof heightSpec === 'number',
  };
}

function formatResizeSpec(raw: string, stretchMode: boolean): string {
  const value = raw
    .trim()
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('w:')) {
        const val = part.slice(2);
        return val.endsWith('%') ? `width:${val}` : `width:${val}px`;
      }
      if (part.startsWith('h:')) {
        const val = part.slice(2);
        return val.endsWith('%') ? `height:${val}` : `height:${val}px`;
      }
      return part;
    })
    .join(', ');

  return stretchMode ? `${value} (ストレッチ)` : value;
}

function collectOptimizedDirs(cwd: string): string[] {
  try {
    return fs
      .readdirSync(cwd)
      .filter((file) => file.startsWith('optimized'))
      .filter((file) => fs.statSync(path.join(cwd, file)).isDirectory());
  } catch {
    return [];
  }
}

function displayOutputDir(cwd: string, outputDir: string, directoryOption?: string): string {
  if (directoryOption === '.') {
    return '現在のディレクトリ (.)';
  }
  return path.relative(cwd, outputDir) || outputDir;
}

function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padVisual(text: string, targetWidth: number): string {
  return text + ' '.repeat(Math.max(0, targetWidth - visualWidth(text)));
}

function printOptionSummary(rows: Array<{ label: string; flag: string; value?: string }>): void {
  const labelWidth = Math.max(...rows.map((row) => visualWidth(row.label)));

  console.log(chalk.gray('-'.repeat(44)));
  console.log(chalk.bold('オプション:'));
  for (const row of rows) {
    const label = padVisual(row.label, labelWidth);
    const flag = chalk.gray(`(${row.flag})`);
    if (row.value !== undefined) {
      console.log(`  ${chalk.white(label)}  ${flag} : ${chalk.cyan(row.value)}`);
    } else {
      console.log(`  ${chalk.gray(label)}  ${flag} : ${chalk.gray('--')}`);
    }
  }
  console.log(chalk.gray('-'.repeat(44)));
}

function readStoredOptions(): StoredOptions {
  try {
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as { options?: StoredOptions };
    return parsed.options ?? {};
  } catch {
    return {};
  }
}

function writeStoredOptions(options: StoredOptions): void {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify({ options }, null, 2));
  } catch {
    // 状態保存は失敗しても処理を継続する
  }
}

function isInitToken(value?: string): boolean {
  return value?.trim().toLowerCase() === 'init';
}

function normalizeOptionValue(value?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isInitToken(value) ? undefined : value;
}

function normalizeOptions(raw: Record<string, unknown>): StoredOptions {
  return {
    format: normalizeOptionValue(typeof raw.format === 'string' ? raw.format : undefined),
    size: normalizeOptionValue(typeof raw.size === 'string' ? raw.size : undefined),
    length: normalizeOptionValue(typeof raw.length === 'string' ? raw.length : undefined),
    recursive: !!raw.recursive,
    keep: !!raw.keep,
    name: normalizeOptionValue(typeof raw.name === 'string' ? raw.name : undefined),
    pick: !!raw.pick,
    directory: normalizeOptionValue(typeof raw.directory === 'string' ? raw.directory : undefined),
    confirm: !!raw.confirm,
  };
}

function mergeOptions(base: StoredOptions, override: StoredOptions): StoredOptions {
  return {
    format: override.format !== undefined ? override.format : base.format,
    size: override.size !== undefined ? override.size : base.size,
    length: override.length !== undefined ? override.length : base.length,
    recursive: override.recursive ?? base.recursive ?? false,
    keep: override.keep ?? base.keep ?? false,
    name: override.name !== undefined ? override.name : base.name,
    pick: override.pick ?? base.pick ?? false,
    directory: override.directory !== undefined ? override.directory : base.directory,
    confirm: override.confirm ?? base.confirm ?? false,
  };
}

function parseOptionTokens(tokens: string[]): StoredOptions {
  const parsed: StoredOptions = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case '-f':
      case '--format':
        parsed.format = normalizeOptionValue(tokens[++i]);
        break;
      case '-s':
      case '--size':
        parsed.size = normalizeOptionValue(tokens[++i]);
        break;
      case '-l':
      case '--length':
        parsed.length = normalizeOptionValue(tokens[++i]);
        break;
      case '-r':
      case '--recursive':
        parsed.recursive = true;
        break;
      case '-k':
      case '--keep':
        parsed.keep = true;
        break;
      case '-n':
      case '--name':
        parsed.name = normalizeOptionValue(tokens[++i]);
        break;
      case '-p':
      case '--pick':
        parsed.pick = true;
        break;
      case '-d':
      case '--directory':
        parsed.directory = normalizeOptionValue(tokens[++i]);
        break;
      case '-c':
      case '--confirm':
        parsed.confirm = true;
        break;
      default:
        throw new Error(`無効な追加オプションです: ${token}`);
    }
  }

  return parsed;
}

function tokenizeArgString(argString: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(argString)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }

  return tokens;
}

function extractEffectiveOptions(): StoredOptions {
  const cliProvided = normalizeOptions(program.opts());
  const hasUserArgs = process.argv.slice(2).length > 0;
  const stored = readStoredOptions();
  return hasUserArgs ? mergeOptions(stored, cliProvided) : stored;
}

async function loadProcessingDeps(): Promise<{
  ora: typeof import('ora').default;
  optimizeImage: typeof import('./optimizer.js').optimizeImage;
}> {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = (() => undefined) as typeof process.emitWarning;
    const [oraModule, optimizerModule] = await Promise.all([
      import('ora'),
      import('./optimizer.js'),
    ]);
    return {
      ora: oraModule.default,
      optimizeImage: optimizerModule.optimizeImage,
    };
  } finally {
    process.emitWarning = emitWarning;
  }
}

function onlyRenameRequested(options: EffectiveOptions): boolean {
  return !!options.name
    && !options.format
    && !options.size
    && !options.length
    && !options.keep;
}

function isPromptAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const name = (err as { name?: string }).name;
  const message = (err as { message?: string }).message ?? '';
  return name === 'ExitPromptError'
    || message.includes('User force closed the prompt')
    || message.includes('SIGINT');
}

async function promptForConfirmation(options: EffectiveOptions): Promise<EffectiveOptions | null> {
  let current = options;

  while (true) {
    printOptionSummary([
      { label: 'フォーマット', flag: '-f', value: current.format },
      { label: '最大サイズ', flag: '-s', value: current.size },
      { label: 'リサイズ', flag: '-l', value: current.length },
      { label: 'メタデータ保持', flag: '-k', value: current.keep ? '有効' : undefined },
      { label: 'リネーム', flag: '-n', value: current.name },
      { label: '対話モード', flag: '-p', value: current.pick ? '有効' : undefined },
      { label: '再帰処理', flag: '-r', value: current.recursive ? '有効' : undefined },
      { label: '出力先指定', flag: '-d', value: current.directory },
      { label: '確認モード', flag: '-c', value: current.confirm ? '有効' : undefined },
    ]);

    let answer: string;
    try {
      answer = (await input({
        message: '処理を開始しますか？ ( y / n / <option> )',
        default: '',
      })).trim();
    } catch (err) {
      if (isPromptAbortError(err)) {
        return null;
      }
      throw err;
    }

    if (!answer || /^y(es)?$/i.test(answer)) {
      return current;
    }

    if (/^n(o)?$/i.test(answer)) {
      return null;
    }

    const tokens = tokenizeArgString(answer);
    if (tokens.length === 0) {
      continue;
    }

    try {
      const overrides = parseOptionTokens(tokens);
      current = mergeOptions(current, overrides);
    } catch (err: any) {
      console.error(chalk.red(`エラー: ${err.message}`));
    }
  }
}

async function main(): Promise<void> {
  let options = extractEffectiveOptions();
  const cwd = process.cwd();

  if (options.confirm) {
    const confirmed = await promptForConfirmation(options);
    if (confirmed === null) {
      console.log(chalk.yellow('処理をキャンセルしました。'));
      return;
    }
    options = confirmed;
  }

  const allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  let format = options.format?.toLowerCase();
  if (format) {
    if (!allowedFormats.includes(format)) {
      console.error(chalk.red(`エラー: サポートされていないフォーマットです: ${options.format}`));
      console.log(chalk.gray(`サポートされている形式: ${allowedFormats.join(', ')}`));
      process.exit(1);
    }
  }

  let targetSize: number | undefined;
  if (options.size) {
    try {
      targetSize = parseSize(options.size);
    } catch (err: any) {
      console.error(chalk.red(`エラー: ${err.message}`));
      process.exit(1);
    }
  }

  let widthSpec: number | string | undefined;
  let heightSpec: number | string | undefined;
  let stretchMode = false;
  if (options.length) {
    try {
      const parsed = parseLengthOption(options.length);
      widthSpec = parsed.widthSpec;
      heightSpec = parsed.heightSpec;
      stretchMode = parsed.stretchMode;
    } catch (err: any) {
      console.error(chalk.red(`エラー: ${err.message}`));
      process.exit(1);
    }
  }

  const outputDir = resolveOutputDir(cwd, options.directory);
  const ignoreDirs = collectOptimizedDirs(cwd);
  const outputDirName = path.basename(outputDir);
  if (path.dirname(outputDir) === cwd && !ignoreDirs.includes(outputDirName)) {
    ignoreDirs.push(outputDirName);
  }

  let imageFiles = await scanImages(cwd, !!options.recursive, ignoreDirs);
  if (imageFiles.length === 0) {
    console.log(chalk.yellow('処理対象の画像が見つかりませんでした。'));
    return;
  }

  const resizeValue = options.length
    ? formatResizeSpec(options.length, stretchMode)
    : undefined;

  printOptionSummary([
    { label: 'フォーマット', flag: '-f', value: format },
    { label: '最大サイズ', flag: '-s', value: targetSize !== undefined ? formatSize(targetSize) : undefined },
    { label: 'リサイズ', flag: '-l', value: resizeValue },
    { label: 'メタデータ保持', flag: '-k', value: options.keep ? '有効' : undefined },
    { label: 'リネーム', flag: '-n', value: options.name },
    { label: '対話モード', flag: '-p', value: options.pick ? '有効' : undefined },
    { label: '再帰処理', flag: '-r', value: options.recursive ? '有効' : undefined },
    { label: '出力先指定', flag: '-d', value: options.directory },
    { label: '確認モード', flag: '-c', value: options.confirm ? '有効' : undefined },
  ]);

  if (options.pick) {
    console.log(chalk.cyan('\n対話モード: スペースキーで選択/解除、Enterで確定、Escでキャンセル\n'));
    try {
      const selected = await checkbox({
        message: '処理する画像を選択してください:',
        choices: imageFiles.map((file) => ({ name: file, value: file, checked: true })),
        pageSize: 20,
      });
      if (selected.length === 0) {
        console.log(chalk.yellow('画像が選択されませんでした。処理を中断します。'));
        return;
      }
      imageFiles = selected;
    } catch {
      console.log(chalk.yellow('\n選択がキャンセルされました。'));
      return;
    }
  }

  const outputDirLabel = displayOutputDir(cwd, outputDir, options.directory);
  console.log(chalk.blue(`\n出力先ディレクトリ: ${outputDirLabel}/\n`));
  const { ora, optimizeImage } = await loadProcessingDeps();
  const copyOnly = onlyRenameRequested(options);

  let successCount = 0;
  let failureCount = 0;
  let totalOriginalSize = 0;
  let totalOutputSize = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const displayIndex = `[${i + 1}/${imageFiles.length}]`;
    const spinner = ora(`${displayIndex} ${file} を処理中...`).start();

    const result = await optimizeImage(file, outputDir, {
      format,
      size: targetSize,
      widthSpec,
      heightSpec,
      stretchMode,
      keepMetadata: !!options.keep,
      namePattern: options.name,
      fileIndex: i + 1,
      recursive: !!options.recursive,
      cwd,
      copyOnly,
    });

    if (result.success) {
      successCount++;
      totalOriginalSize += result.originalSize;
      totalOutputSize += result.outputSize || 0;

      const reduction = result.originalSize - (result.outputSize || 0);
      const reductionRate = result.originalSize > 0
        ? Math.max(0, (reduction / result.originalSize) * 100).toFixed(1)
        : '0.0';

      spinner.succeed(chalk.green(`${displayIndex} ${file}`));
      console.log(`  元サイズ   : ${formatSize(result.originalSize)}`);
      console.log(`  出力サイズ : ${formatSize(result.outputSize || 0)}`);
      console.log(`  削減率     : ${reductionRate}%`);
      console.log(`  出力先     : ${result.outputPath}`);
      if (result.warning) {
        console.log(chalk.yellow(`  警告       : ${result.warning}`));
      }
      console.log('');
    } else {
      failureCount++;
      totalOriginalSize += result.originalSize;
      totalOutputSize += result.originalSize;

      spinner.fail(chalk.red(`${displayIndex} ${file} - 失敗`));
      console.log(chalk.red(`  エラー     : ${result.error}\n`));
    }
  }

  const totalReduction = Math.max(0, totalOriginalSize - totalOutputSize);

  console.log(chalk.bold.green('処理完了\n'));
  console.log(`対象ファイル数 : ${imageFiles.length}`);
  console.log(`成功           : ${successCount}`);
  console.log(`失敗           : ${failureCount}`);
  console.log(`総削減容量     : ${formatSize(totalReduction)}`);

  writeStoredOptions(options);
}

main().catch((err: any) => {
  if (isPromptAbortError(err)) {
    process.exit(0);
  }
  console.error(chalk.red(`致命的なエラーが発生しました: ${err.message}`));
  process.exit(1);
});
