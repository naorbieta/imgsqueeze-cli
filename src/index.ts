#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { checkbox, input } from '@inquirer/prompts';
import { scanImages, parseSize, formatSize, resolveOutputDir, getImsqDir } from './utils.js';
import { getPreset, savePreset, deletePreset, listPresets } from './preset.js';
import { readUserConfig } from './config.js';

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
  hard?: boolean;
  trash?: boolean;
  watch?: boolean;
  initial?: boolean;
  poll?: boolean;
};

type EffectiveOptions = StoredOptions;

const program = new Command();

function getStateFilePath(): string {
  return path.join(getImsqDir(), 'options.json');
}

// ----- preset サブコマンド -----
program
  .command('preset', { isDefault: false })
  .description('プリセット管理 (引数なし: 一覧表示, <name>: 読み込み, save <name>: 保存, delete <name>: 削除)')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async () => {
    const args = process.argv.slice(3);
    const first = args[0];
    const second = args[1];

    if (!first) {
      // imsq preset → 一覧表示
      if (listPresets()) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    }

    if (first === 'save') {
      // imsq preset save <name> [options]
      if (!second) {
        console.error(chalk.red('エラー: プリセット名を指定してください。例: imsq preset save mypreset'));
        process.exit(1);
      }
      
      const optionTokens = args.slice(2);
      let stored: StoredOptions;
      if (optionTokens.length > 0) {
        try {
          stored = parseOptionTokens(optionTokens);
        } catch (err: any) {
          console.error(chalk.red(`エラー: オプションのパースに失敗しました: ${err.message}`));
          process.exit(1);
        }
      } else {
        stored = readStoredOptions(true);
      }

      if (stored.hard && stored.trash) {
        console.error(chalk.red('エラー: --hard と --trash は同時に指定できません。'));
        process.exit(1);
      }

      if (savePreset(second, stored)) {
        console.log(chalk.green(`プリセット "${second}" を保存しました。`));
        process.exit(0);
      } else {
        process.exit(1);
      }
    }

    if (first === 'delete' || first === 'del' || first === 'rm') {
      // imsq preset delete <name|index>
      if (!second) {
        console.error(chalk.red('エラー: プリセット名または番号を指定してください。例: imsq preset delete 1'));
        process.exit(1);
      }
      const deleted = deletePreset(second);
      if (deleted) {
        console.log(chalk.green(`プリセット "${deleted}" を削除しました。`));
      } else {
        console.error(chalk.red(`エラー: プリセット "${second}" が見つかりません。`));
        process.exit(1);
      }
      process.exit(0);
    }

    // imsq preset <name|index> → プリセット読み込みで main() へ続行
    process.env.__IMSQ_PRESET__ = first;
  });

// ----- メインコマンド -----
program
  .name('imsq')
  .description('IMG Squeeze CLI - 画像最適化CLIツール (カレントディレクトリ内の画像を最適化して出力します)')
  .version('IMG Squeeze CLI v0.2.0', '-v, --version')
  .option('-f, --format <type>', '出力形式指定 (jpg, png, gif, webp)')
  .option('-s, --size <size>', '最大ファイルサイズ指定 (例: 50kb, 100kb, 1mb)')
  .option('-l, --length <dimensions>', 'リサイズ指定 (例: w:600, h:400, w:600,h:400, w:50%, h:50%)')
  .option('-r, --recursive', 'サブディレクトリ内の画像も処理する')
  .option('-k, --keep', 'メタデータを保持する (Exif, ICC profileなど)')
  .option('-n, --name <pattern>', 'リネームパターン (? = 元ファイル名, * = 1桁連番, ** = 2桁, *** = 3桁)')
  .option('-p, --pick', '対話モード: 処理対象の画像を選択する')
  .option('-d, --directory <dir>', '出力先ディレクトリ指定 (例: ./output, . で現在のディレクトリ)')
  .option('-c, --confirm', '処理を開始する前に確認を挟む')
  .option('--hard', '出力成功後に元ファイルをゴミ箱へ送らず削除する')
  .option('--trash', '出力成功後に元ファイルをゴミ箱へ送る')
  .option('-w, --watch', '監視モード: ディレクトリ内を監視して、新しい画像が増えたら自動で処理する')
  .option('--no-initial', '監視モード時、起動時に存在するファイルの処理をスキップする')
  .option('--poll', '監視モードでポーリング方式(usePolling)を使用する (WSLやネットワークドライブ環境向け)')
  .action(() => {});

const firstArg = process.argv[2];
if (firstArg && !firstArg.startsWith('-') && firstArg !== 'preset' && firstArg !== 'help') {
  const found = getPreset(firstArg);
  if (found) {
    process.env.__IMSQ_PRESET__ = firstArg;
    process.argv.splice(2, 1);
  } else {
    console.error(chalk.red(`エラー: 未知のコマンドまたはプリセットです: "${firstArg}"`));
    console.log(chalk.gray('  imsq preset  で登録済みのプリセット一覧を確認できます。'));
    process.exit(1);
  }
}

await program.parseAsync(process.argv);

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

function formatDirectoryForSummary(directoryOption?: string): string | undefined {
  if (directoryOption === '.') {
    return '現在のディレクトリ';
  }
  return directoryOption;
}

function formatSizeForSummary(size?: string): string | undefined {
  if (!size) {
    return undefined;
  }
  const normalized = size.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!match) {
    return size;
  }
  const value = match[1];
  const unit = (match[2] || 'b').toUpperCase();
  return `${value}${unit}`;
}

function formatLengthForSummary(length?: string): string | undefined {
  if (!length) {
    return undefined;
  }
  const parts = length
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
    });

  return parts.join(', ');
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

function printFileResult(result: { originalSize: number; outputSize?: number; outputPath?: string; warning?: string }, label: string): void {
  const outputSize = result.outputSize ?? 0;
  const reduction = result.originalSize - outputSize;
  const increased = reduction < 0;
  const rateRaw = result.originalSize > 0 ? (reduction / result.originalSize) * 100 : 0;
  const reductionRate = increased
    ? chalk.yellow(`+${Math.abs(rateRaw).toFixed(1)}%（増加）`)
    : `${rateRaw.toFixed(1)}%`;

  console.log(`  元サイズ   : ${formatSize(result.originalSize)}`);
  console.log(`  出力サイズ : ${formatSize(outputSize)}`);
  console.log(`  削減率     : ${reductionRate}`);
  console.log(`  出力先     : ${result.outputPath}`);
  if (result.warning) {
    console.log(chalk.yellow(`  警告       : ${result.warning}`));
  }
  console.log('');
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

function printSelectedFilesSummary(fileNames: string[]): void {
  console.log(chalk.bold('対象ファイル:'));
  console.log(chalk.cyan(`  ${fileNames.length}件`));
  for (const fileName of fileNames) {
    console.log(`  - ${fileName}`);
  }
  console.log('');
}

function readStoredOptions(raw = false): StoredOptions {
  const defaultPoll = getConfiguredPoll();

  try {
    const fileRaw = fs.readFileSync(getStateFilePath(), 'utf8');
    const parsed = JSON.parse(fileRaw) as { options?: StoredOptions };
    const opts = parsed.options ?? {};
    if (raw) {
      return opts;
    }
    return {
      ...opts,
      pick: false,
      confirm: false,
      hard: false,
      trash: false,
      watch: false,
      initial: true,
      poll: opts.poll ?? defaultPoll,
    };
  } catch {
    return {
      poll: defaultPoll,
    };
  }
}

function getConfiguredPoll(): boolean | undefined {
  const userConfig = readUserConfig();
  return userConfig.watch?.poll ?? userConfig.poll;
}

function writeStoredOptions(options: StoredOptions): void {
  try {
    const persisted: StoredOptions = {
      format: options.format,
      size: options.size,
      length: options.length,
      recursive: options.recursive,
      keep: options.keep,
      name: options.name,
      directory: options.directory,
      hard: options.hard,
      trash: options.trash,
      poll: options.poll,
    };
    const imsqDir = getImsqDir();
    fs.mkdirSync(imsqDir, { recursive: true });
    fs.writeFileSync(getStateFilePath(), JSON.stringify({ options: persisted }, null, 2));
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
    recursive: raw.recursive !== undefined ? !!raw.recursive : undefined,
    keep: raw.keep !== undefined ? !!raw.keep : undefined,
    name: normalizeOptionValue(typeof raw.name === 'string' ? raw.name : undefined),
    pick: raw.pick !== undefined ? !!raw.pick : undefined,
    directory: normalizeOptionValue(typeof raw.directory === 'string' ? raw.directory : undefined),
    confirm: raw.confirm !== undefined ? !!raw.confirm : undefined,
    hard: raw.hard !== undefined ? !!raw.hard : undefined,
    trash: raw.trash !== undefined ? !!raw.trash : undefined,
    watch: raw.watch !== undefined ? !!raw.watch : undefined,
    initial: raw.initial !== undefined ? raw.initial !== false : undefined,
    poll: raw.poll !== undefined ? !!raw.poll : undefined,
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
    hard: override.hard ?? base.hard ?? false,
    trash: override.trash ?? base.trash ?? false,
    watch: override.watch ?? base.watch ?? false,
    initial: override.initial ?? base.initial ?? true,
    poll: override.poll ?? base.poll ?? false,
  };
}

function applyPromptOverrides(base: StoredOptions, override: StoredOptions): StoredOptions {
  const next = { ...base };

  for (const key of Object.keys(override) as Array<keyof StoredOptions>) {
    (next as Record<keyof StoredOptions, StoredOptions[keyof StoredOptions]>)[key] = override[key];
  }

  return next;
}

function resetPromptOptions(current: EffectiveOptions): EffectiveOptions {
  return {
    pick: current.pick,
    confirm: current.confirm,
    hard: current.hard,
    trash: current.trash,
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
      case '--hard':
        parsed.hard = true;
        break;
      case '--trash':
        parsed.trash = true;
        break;
      case '-w':
      case '--watch':
        parsed.watch = true;
        break;
      case '--no-initial':
        parsed.initial = false;
        break;
      case '--poll':
        parsed.poll = true;
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

  if (!hasUserArgs) {
    return stored;
  }

  const onlyPickAndConfirm =
    !!cliProvided.pick &&
    !!cliProvided.confirm &&
    !cliProvided.format &&
    !cliProvided.size &&
    !cliProvided.length &&
    !cliProvided.recursive &&
    !cliProvided.keep &&
    !cliProvided.name &&
    !cliProvided.directory &&
    !cliProvided.hard &&
    !cliProvided.trash &&
    !cliProvided.watch;

  const onlyPick =
    !!cliProvided.pick &&
    !cliProvided.confirm &&
    !cliProvided.format &&
    !cliProvided.size &&
    !cliProvided.length &&
    !cliProvided.recursive &&
    !cliProvided.keep &&
    !cliProvided.name &&
    !cliProvided.directory &&
    !cliProvided.hard &&
    !cliProvided.trash &&
    !cliProvided.watch;

  const onlyConfirm =
    !!cliProvided.confirm &&
    !cliProvided.pick &&
    !cliProvided.format &&
    !cliProvided.size &&
    !cliProvided.length &&
    !cliProvided.recursive &&
    !cliProvided.keep &&
    !cliProvided.name &&
    !cliProvided.directory &&
    !cliProvided.hard &&
    !cliProvided.trash &&
    !cliProvided.watch;

  return (onlyPickAndConfirm || onlyPick || onlyConfirm)
    ? mergeOptions(stored, cliProvided)
    : {
      ...cliProvided,
      poll: cliProvided.poll ?? getConfiguredPoll(),
    };
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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        content += chunk;
      }
    });
    process.stdin.on('end', () => resolve(content));
    process.stdin.on('error', (err) => reject(err));
  });
}

function formatWatchModeForSummary(options: EffectiveOptions): string | undefined {
  if (!options.watch) {
    return undefined;
  }
  const parts: string[] = ['有効'];
  if (options.poll) {
    parts.push('ポーリング');
  }
  if (options.initial === false) {
    parts.push('初期処理をスキップ');
  }
  return parts.join('/');
}

function buildOptionSummaryRows(options: EffectiveOptions): Array<{ label: string; flag: string; value?: string }> {
  let stretchModeGlobal = false;
  if (options.length) {
    try {
      const parsed = parseLengthOption(options.length);
      stretchModeGlobal = parsed.stretchMode;
    } catch {}
  }
  const resizeValue = options.length
    ? formatLengthForSummary(options.length) + (stretchModeGlobal ? ' (ストレッチ)' : '')
    : undefined;

  return [
    { label: 'フォーマット', flag: '-f', value: options.format?.toLowerCase() },
    { label: '最大サイズ', flag: '-s', value: options.size ? formatSizeForSummary(options.size) : undefined },
    { label: 'リサイズ', flag: '-l', value: resizeValue },
    { label: 'メタデータ保持', flag: '-k', value: options.keep ? '有効' : undefined },
    { label: 'リネーム', flag: '-n', value: options.name },
    { label: '対話モード', flag: '-p', value: options.pick ? '有効' : undefined },
    { label: '再帰処理', flag: '-r', value: options.recursive ? '有効' : undefined },
    { label: '出力先指定', flag: '-d', value: formatDirectoryForSummary(options.directory) },
    { label: '確認モード', flag: '-c', value: options.confirm ? '有効' : undefined },
    { label: '監視モード', flag: '-w', value: formatWatchModeForSummary(options) },
  ];
}

async function promptForConfirmation(
  options: EffectiveOptions,
  selectedFiles?: string[]
): Promise<EffectiveOptions | null> {
  let current = options;

  while (true) {
    if (selectedFiles && selectedFiles.length > 0) {
      printSelectedFilesSummary(selectedFiles);
    }

    printOptionSummary(buildOptionSummaryRows(current));

    let answer: string;
    try {
      answer = (await input({
        message: '処理を開始しますか？ [ y / n / <option> ]',
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

    if (isInitToken(answer)) {
      current = resetPromptOptions(current);
      continue;
    }

    const tokens = tokenizeArgString(answer);
    if (tokens.length === 0) {
      continue;
    }

    try {
      const overrides = parseOptionTokens(tokens);
      const next = applyPromptOverrides(current, overrides);
      if (next.hard && next.trash) {
        console.error(chalk.red('エラー: --hard と --trash は同時に指定できません。'));
        continue;
      }
      current = next;
    } catch (err: any) {
      console.error(chalk.red(`エラー: ${err.message}`));
    }
  }
}

async function main(): Promise<void> {
  const isPipe = !process.stdin.isTTY;
  let options = extractEffectiveOptions();

  // プリセット読み込み (imsq preset <name> で起動された場合)
  const presetArg = process.env.__IMSQ_PRESET__;
  if (presetArg) {
    const found = getPreset(presetArg);
    if (!found) {
      console.error(chalk.red(`エラー: プリセット "${presetArg}" が見つかりません。`));
      console.log(chalk.gray('  imsq preset  で一覧を確認できます。'));
      process.exit(1);
    }
    console.log(chalk.cyan(`プリセット "${found.presetName}" を読み込みました。`));
    // CLIで明示指定されたオプションをプリセットより優先してマージ
    const cliExplicit = normalizeOptions(program.opts());
    options = mergeOptions(found.options, cliExplicit);
  }

  const cwd = process.cwd();
  const hadConfirmPrompt = options.confirm;

  if (isPipe) {
    if (options.pick) {
      console.error(chalk.red('エラー: 標準入力からのパイプ接続時は対話モード (-p, --pick) を使用できません。'));
      process.exit(1);
    }
    if (options.confirm) {
      console.error(chalk.red('エラー: 標準入力からのパイプ接続時は確認モード (-c, --confirm) を使用できません。'));
      process.exit(1);
    }
  }

  if (options.hard && options.trash) {
    console.error(chalk.red('エラー: --hard と --trash は同時に指定できません。'));
    process.exit(1);
  }

  if (options.watch && options.pick) {
    console.error(chalk.red('エラー: 監視モード (-w, --watch) と対話モード (-p, --pick) は同時に指定できません。'));
    process.exit(1);
  }

  if (options.confirm && !options.pick) {
    const confirmed = await promptForConfirmation(options);
    if (confirmed === null) {
      console.log(chalk.yellow('処理をキャンセルしました。'));
      return;
    }
    options = confirmed;
  }

  let outputDir = resolveOutputDir(cwd, options.directory);
  const ignoreDirs = collectOptimizedDirs(cwd);
  const outputDirName = path.basename(outputDir);
  if (path.dirname(outputDir) === cwd && !ignoreDirs.includes(outputDirName)) {
    ignoreDirs.push(outputDirName);
  }

  if (!hadConfirmPrompt && !isPipe) {
    printOptionSummary(buildOptionSummaryRows(options));
  }

  outputDir = resolveOutputDir(cwd, options.directory);
  if (!isPipe) {
    const outputDirLabel = displayOutputDir(cwd, outputDir, options.directory);
    console.log(chalk.blue(`\n出力先ディレクトリ: ${outputDirLabel}/\n`));
  }
  const { ora, optimizeImage } = await loadProcessingDeps();

  let successCount = 0;
  let failureCount = 0;
  let totalOriginalSize = 0;
  let totalOutputSize = 0;

  if (options.watch) {
    let watchSuccessCount = 0;

    // 1. 起動時処理 (options.initial !== false の場合のみ)
    if (options.initial !== false) {
      console.log(chalk.cyan('起動時処理を開始します...'));
      const imageFiles = await scanImages(cwd, !!options.recursive, ignoreDirs);
      if (imageFiles.length > 0) {
        let format: string | undefined;
        let targetSize: number | undefined;
        let widthSpec: number | string | undefined;
        let heightSpec: number | string | undefined;
        let stretchMode = false;

        if (options.format) format = options.format.toLowerCase();
        if (options.size) targetSize = parseSize(options.size);
        if (options.length) {
          const parsed = parseLengthOption(options.length);
          widthSpec = parsed.widthSpec;
          heightSpec = parsed.heightSpec;
          stretchMode = parsed.stretchMode;
        }

        const copyOnly = onlyRenameRequested(options);

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
            hardDelete: !!options.hard,
            trashOriginal: !!options.trash,
          });

          if (result.success) {
            successCount++;
            watchSuccessCount++;
            totalOriginalSize += result.originalSize;
            totalOutputSize += result.outputSize || 0;

            spinner.succeed(chalk.green(`${displayIndex} ${file}`));
            printFileResult(result, file);
          } else {
            failureCount++;
            spinner.fail(chalk.red(`${displayIndex} ${file} - 失敗`));
            console.log(chalk.red(`  エラー     : ${result.error}\n`));
          }
        }

        const netReductionWatch = totalOriginalSize - totalOutputSize;
        const totalReductionWatchLabel = netReductionWatch >= 0
          ? formatSize(netReductionWatch)
          : chalk.yellow(`-${formatSize(Math.abs(netReductionWatch))}（増加）`);
        console.log(chalk.bold.green('起動時処理完了\n'));
        console.log(`対象ファイル数 : ${imageFiles.length}`);
        console.log(`成功           : ${successCount}`);
        console.log(`失敗           : ${failureCount}`);
        console.log(`総削減容量     : ${totalReductionWatchLabel}\n`);
      } else {
        console.log(chalk.yellow('処理対象の画像が見つかりませんでした。\n'));
      }
    }

    // 2. 監視の開始
    console.log(chalk.green.bold('監視モードを起動しました。'));
    console.log(chalk.gray(`監視ディレクトリ : ${cwd}`));
    if (options.poll) {
      console.log(chalk.gray('監視方式         : ポーリング (usePolling)'));
    }
    if (!options.recursive) {
      console.log(chalk.gray('※サブディレクトリは監視されません。'));
    }
    console.log(chalk.gray('新しい画像が追加されるのを待っています... (終了するには Ctrl+C を押してください)\n'));

    const { default: chokidar } = await import('chokidar');
    const queue: string[] = [];
    let processing = false;

    let formatWatch: string | undefined;
    let targetSizeWatch: number | undefined;
    let widthSpecWatch: number | string | undefined;
    let heightSpecWatch: number | string | undefined;
    let stretchModeWatch = false;

    if (options.format) formatWatch = options.format.toLowerCase();
    if (options.size) targetSizeWatch = parseSize(options.size);
    if (options.length) {
      const parsed = parseLengthOption(options.length);
      widthSpecWatch = parsed.widthSpec;
      heightSpecWatch = parsed.heightSpec;
      stretchModeWatch = parsed.stretchMode;
    }
    const copyOnlyWatch = onlyRenameRequested(options);

    const generatedFiles = new Set<string>();

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const file = queue.shift()!;
        watchSuccessCount++;
        const spinner = ora(`${file} を処理中...`).start();

        const result = await optimizeImage(file, outputDir, {
          format: formatWatch,
          size: targetSizeWatch,
          widthSpec: widthSpecWatch,
          heightSpec: heightSpecWatch,
          stretchMode: stretchModeWatch,
          keepMetadata: !!options.keep,
          namePattern: options.name,
          fileIndex: watchSuccessCount,
          recursive: !!options.recursive,
          cwd,
          copyOnly: copyOnlyWatch,
          hardDelete: !!options.hard,
          trashOriginal: !!options.trash,
        });

        if (result.success) {
          if (result.outputPath) {
            const absOutput = path.resolve(cwd, result.outputPath);
            const absInput = path.resolve(cwd, file);
            if (absOutput !== absInput) {
              generatedFiles.add(absOutput);
            }
          }
          spinner.succeed(chalk.green(`[新規追加] ${file}`));
          printFileResult(result, file);
        } else {
          spinner.fail(chalk.red(`[新規追加] ${file} - 失敗`));
          console.log(chalk.red(`  エラー     : ${result.error}\n`));
        }
      }

      processing = false;
    };

    const enqueue = (file: string) => {
      queue.push(file);
      processQueue();
    };

    const userConfig = readUserConfig();
    const watchOptions: any = {
      ignored: (filePath: string) => {
        const absPath = path.resolve(filePath);
        const parts = absPath.split(path.sep);
        if (parts.includes('node_modules') || parts.includes('.git')) {
          return true;
        }
        if (outputDir !== cwd && (absPath === outputDir || absPath.startsWith(outputDir + path.sep))) {
          return true;
        }
        for (const dir of ignoreDirs) {
          const ignoreAbs = path.resolve(cwd, dir);
          if (absPath === ignoreAbs || absPath.startsWith(ignoreAbs + path.sep)) {
            return true;
          }
        }
        const base = path.basename(absPath);
        if (base !== '.' && base !== '..' && base.startsWith('.')) {
          return true;
        }
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      usePolling: !!options.poll,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    };

    if (!options.recursive) {
      watchOptions.depth = 0;
    }

    if (userConfig.watch?.interval !== undefined) {
      watchOptions.interval = userConfig.watch.interval;
      watchOptions.binaryInterval = userConfig.watch.interval;
    }

    const watcher = chokidar.watch(cwd, watchOptions);

    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

    watcher.on('add', (filePath) => {
      const absPath = path.resolve(filePath);
      if (generatedFiles.has(absPath)) {
        generatedFiles.delete(absPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (allowedExtensions.includes(ext)) {
        const relativePath = path.relative(cwd, filePath);
        enqueue(relativePath);
      }
    });

    await new Promise<void>((_resolve) => {
      process.on('SIGINT', () => {
        watcher.close();
        console.log(chalk.yellow('\n監視を終了しました。'));
        process.exit(0);
      });
    });

    return;
  }

  const targetFiles: Array<{ file: string; fileOptions: StoredOptions }> = [];

  if (isPipe) {
    const stdinContent = await readStdin();
    const lines = stdinContent.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const tokens = tokenizeArgString(trimmed);
      if (tokens.length === 0) {
        continue;
      }

      const file = tokens[0];
      let fileOptions = options;

      if (tokens.length > 1) {
        try {
          const overrideOptions = parseOptionTokens(tokens.slice(1));
          fileOptions = mergeOptions(options, overrideOptions);
        } catch (err: any) {
          console.error(chalk.red(`行のパースエラー ("${trimmed}"): ${err.message}`));
          continue;
        }
      }

      targetFiles.push({ file, fileOptions });
    }

    if (targetFiles.length === 0) {
      console.log(chalk.yellow('標準入力から処理対象の画像リストが読み込めませんでした。'));
      return;
    }
  } else {
    let imageFiles = await scanImages(cwd, !!options.recursive, ignoreDirs);
    if (imageFiles.length === 0) {
      console.log(chalk.yellow('処理対象の画像が見つかりませんでした。'));
      return;
    }

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

    if (options.confirm && options.pick) {
      const confirmed = await promptForConfirmation(options, imageFiles);
      if (confirmed === null) {
        console.log(chalk.yellow('処理をキャンセルしました。'));
        return;
      }
      options = confirmed;
    }

    for (const file of imageFiles) {
      targetFiles.push({ file, fileOptions: options });
    }
  }

  const allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

  for (let i = 0; i < targetFiles.length; i++) {
    const { file, fileOptions } = targetFiles[i];

    if (fileOptions.hard && fileOptions.trash) {
      failureCount++;
      console.error(chalk.red(`エラー: ${file} - --hard と --trash は同時に指定できません。スキップします。`));
      continue;
    }

    const format = fileOptions.format?.toLowerCase();
    if (format && !allowedFormats.includes(format)) {
      failureCount++;
      console.error(chalk.red(`エラー: ${file} - サポートされていないフォーマットです: ${fileOptions.format}`));
      continue;
    }

    let targetSize: number | undefined;
    if (fileOptions.size) {
      try {
        targetSize = parseSize(fileOptions.size);
      } catch (err: any) {
        failureCount++;
        console.error(chalk.red(`エラー: ${file} - ${err.message}`));
        continue;
      }
    }

    let widthSpec: number | string | undefined;
    let heightSpec: number | string | undefined;
    let stretchMode = false;
    if (fileOptions.length) {
      try {
        const parsed = parseLengthOption(fileOptions.length);
        widthSpec = parsed.widthSpec;
        heightSpec = parsed.heightSpec;
        stretchMode = parsed.stretchMode;
      } catch (err: any) {
        failureCount++;
        console.error(chalk.red(`エラー: ${file} - ${err.message}`));
        continue;
      }
    }

    const copyOnly = onlyRenameRequested(fileOptions);

    const fileOutputDir = fileOptions.directory !== undefined
      ? resolveOutputDir(cwd, fileOptions.directory)
      : outputDir;

    const displayIndex = `[${i + 1}/${targetFiles.length}]`;
    const spinner = ora(`${displayIndex} ${file} を処理中...`).start();

    const result = await optimizeImage(file, fileOutputDir, {
      format,
      size: targetSize,
      widthSpec,
      heightSpec,
      stretchMode,
      keepMetadata: !!fileOptions.keep,
      namePattern: fileOptions.name,
      fileIndex: i + 1,
      recursive: !!fileOptions.recursive,
      cwd,
      copyOnly,
      hardDelete: !!fileOptions.hard,
      trashOriginal: !!fileOptions.trash,
    });

    if (result.success) {
      successCount++;
      totalOriginalSize += result.originalSize;
      totalOutputSize += result.outputSize || 0;

      spinner.succeed(chalk.green(`${displayIndex} ${file}`));
      printFileResult(result, file);
    } else {
      failureCount++;
      totalOriginalSize += result.originalSize;
      totalOutputSize += result.originalSize;

      spinner.fail(chalk.red(`${displayIndex} ${file} - 失敗`));
      console.log(chalk.red(`  エラー     : ${result.error}\n`));
    }
  }

  const netReduction = totalOriginalSize - totalOutputSize;
  const totalReductionLabel = netReduction >= 0
    ? formatSize(netReduction)
    : chalk.yellow(`-${formatSize(Math.abs(netReduction))}（増加）`);

  console.log(chalk.bold.green('処理完了\n'));
  console.log(`対象ファイル数 : ${targetFiles.length}`);
  console.log(`成功           : ${successCount}`);
  console.log(`失敗           : ${failureCount}`);
  console.log(`総削減容量     : ${totalReductionLabel}`);

  writeStoredOptions(options);
}

main().catch((err: any) => {
  if (isPromptAbortError(err)) {
    process.exit(0);
  }
  console.error(chalk.red(`致命的なエラーが発生しました: ${err.message}`));
  process.exit(1);
});
