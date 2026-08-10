import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import * as TOML from 'smol-toml';
import { getImsqDir } from './utils.js';


export type StoredOptions = {
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

function getPresetFilePath(): string {
  return path.join(getImsqDir(), 'presets.toml');
}

function readPresetFile(): Record<string, StoredOptions> {
  const filePath = getPresetFilePath();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TOMLフォーマットが不正です。オブジェクト形式である必要があります。');
  }
  const result: Record<string, StoredOptions> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      result[name] = normalizePresetEntry(entry);
    }
  }
  return result;
}

function normalizePresetEntry(raw: Record<string, unknown>): StoredOptions {
  return {
    format: typeof raw.format === 'string' ? raw.format : undefined,
    size: typeof raw.size === 'string' ? raw.size : undefined,
    length: typeof raw.length === 'string' ? raw.length : undefined,
    recursive: typeof raw.recursive === 'boolean' ? raw.recursive : undefined,
    keep: typeof raw.keep === 'boolean' ? raw.keep : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    pick: typeof raw.pick === 'boolean' ? raw.pick : undefined,
    directory: typeof raw.directory === 'string' ? raw.directory : undefined,
    confirm: typeof raw.confirm === 'boolean' ? raw.confirm : undefined,
    hard: typeof raw.hard === 'boolean' ? raw.hard : undefined,
    trash: typeof raw.trash === 'boolean' ? raw.trash : undefined,
    watch: typeof raw.watch === 'boolean' ? raw.watch : undefined,
    initial: typeof raw.initial === 'boolean' ? raw.initial : undefined,
    poll: typeof raw.poll === 'boolean' ? raw.poll : undefined,
  };
}

function writePresetFile(presets: Record<string, StoredOptions>): boolean {
  try {
    const clean: Record<string, Record<string, unknown>> = {};
    for (const [name, opts] of Object.entries(presets)) {
      const entry: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) {
          entry[k] = v;
        }
      }
      clean[name] = entry;
    }
    const content = TOML.stringify(clean);
    const imsqDir = getImsqDir();
    fs.mkdirSync(imsqDir, { recursive: true });
    fs.writeFileSync(getPresetFilePath(), content, 'utf8');
    return true;
  } catch (err: any) {
    console.error(chalk.red(`プリセットの保存に失敗しました: ${err.message}`));
    return false;
  }
}

/** 名前または1-indexed番号でプリセットを取得する */
export function getPreset(name: string): { presetName: string; options: StoredOptions } | undefined {
  let presets: Record<string, StoredOptions>;
  try {
    presets = readPresetFile();
  } catch (err: any) {
    console.error(chalk.red(`エラー: プリセットファイルの読み込みに失敗しました: ${err.message}`));
    console.error(chalk.yellow(`  既存のファイル (${getPresetFilePath()}) を確認・修正してください。`));
    return undefined;
  }

  // 名前で直接一致する場合
  if (presets[name] !== undefined) {
    return { presetName: name, options: presets[name] };
  }

  // 番号指定の場合（1-indexed）
  const index = Number.parseInt(name, 10);
  if (!Number.isNaN(index) && index > 0) {
    const entries = Object.entries(presets);
    const entry = entries[index - 1];
    if (entry) {
      return { presetName: entry[0], options: entry[1] };
    }
  }

  return undefined;
}

/** プリセットを保存する（永続化する項目のみ）。保存成功時は true を返す */
export function savePreset(name: string, options: StoredOptions): boolean {
  let presets: Record<string, StoredOptions>;
  try {
    presets = readPresetFile();
  } catch (err: any) {
    console.error(chalk.red(`エラー: プリセットファイルの読み込みに失敗したため保存を中止しました: ${err.message}`));
    console.error(chalk.yellow(`  既存のファイル (${getPresetFilePath()}) を確認・修正してください。`));
    return false;
  }
  const persisted: StoredOptions = {
    format: options.format,
    size: options.size,
    length: options.length,
    recursive: options.recursive || undefined,
    keep: options.keep || undefined,
    name: options.name,
    directory: options.directory,
    hard: options.hard || undefined,
    trash: options.trash || undefined,
    poll: options.poll || undefined,
  };
  presets[name] = persisted;
  return writePresetFile(presets);
}

/** プリセットを削除する。成功すれば削除したプリセット名を返す */
export function deletePreset(nameOrIndex: string): string | undefined {
  let presets: Record<string, StoredOptions>;
  try {
    presets = readPresetFile();
  } catch (err: any) {
    console.error(chalk.red(`エラー: プリセットファイルの読み込みに失敗したため削除できません: ${err.message}`));
    console.error(chalk.yellow(`  既存のファイル (${getPresetFilePath()}) を確認・修正してください。`));
    return undefined;
  }

  // 名前で直接一致する場合
  if (presets[nameOrIndex] !== undefined) {
    delete presets[nameOrIndex];
    if (writePresetFile(presets)) {
      return nameOrIndex;
    }
    return undefined;
  }

  // 番号指定の場合
  const index = Number.parseInt(nameOrIndex, 10);
  if (!Number.isNaN(index) && index > 0) {
    const entries = Object.entries(presets);
    const entry = entries[index - 1];
    if (entry) {
      delete presets[entry[0]];
      if (writePresetFile(presets)) {
        return entry[0];
      }
      return undefined;
    }
  }

  return undefined;
}

/** プリセット一覧をコンソールに表示する。成功時は true、失敗時は false を返す */
export function listPresets(): boolean {
  let presets: Record<string, StoredOptions>;
  try {
    presets = readPresetFile();
  } catch (err: any) {
    console.error(chalk.red(`エラー: プリセットファイルの読み込みに失敗しました: ${err.message}`));
    console.error(chalk.yellow(`  既存のファイル (${getPresetFilePath()}) を確認・修正してください。`));
    return false;
  }
  const entries = Object.entries(presets);

  if (entries.length === 0) {
    console.log(chalk.yellow('プリセットがありません。'));
    console.log(chalk.gray('  imsq preset save <name>  で保存できます。'));
    return true;
  }

  console.log(chalk.bold('プリセット一覧:'));
  console.log(chalk.gray('-'.repeat(44)));

  for (let i = 0; i < entries.length; i++) {
    const [name, opts] = entries[i];
    const num = chalk.gray(`${i + 1}.`);
    console.log(`${num} ${chalk.cyan(name)}`);
    printPresetOptions(opts);
  }

  console.log(chalk.gray('-'.repeat(44)));
  return true;
}

function printPresetOptions(opts: StoredOptions): void {
  const checks: Array<[string, unknown]> = [
    ['フォーマット', opts.format],
    ['最大サイズ', opts.size],
    ['リサイズ', opts.length],
    ['メタデータ保持', opts.keep ? '有効' : undefined],
    ['リネーム', opts.name],
    ['再帰処理', opts.recursive ? '有効' : undefined],
    ['出力先指定', opts.directory],
    ['元ファイル削除', opts.hard ? '有効' : undefined],
    ['元ファイルゴミ箱移動', opts.trash ? '有効' : undefined],
    ['ポーリング監視', opts.poll ? '有効' : undefined],
  ];

  const rows = checks.filter(([, v]) => v !== undefined && v !== null && v !== false);

  if (rows.length === 0) {
    console.log(chalk.gray('   (オプションなし)'));
  } else {
    for (const [label, val] of rows) {
      console.log(`   ${chalk.gray(label)}: ${chalk.white(String(val))}`);
    }
  }
}
