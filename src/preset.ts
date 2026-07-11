import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import * as TOML from 'smol-toml';


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
};

const imsqDir = path.join(os.homedir(), '.imsq');
const presetFilePath = path.join(imsqDir, 'presets.toml');

function readPresetFile(): Record<string, StoredOptions> {
  try {
    const raw = fs.readFileSync(presetFilePath, 'utf8');
    const parsed = TOML.parse(raw) as Record<string, Record<string, unknown>>;
    const result: Record<string, StoredOptions> = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        result[name] = normalizePresetEntry(entry);
      }
    }
    return result;
  } catch {
    return {};
  }
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
  };
}

function writePresetFile(presets: Record<string, StoredOptions>): void {
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
    fs.mkdirSync(imsqDir, { recursive: true });
    fs.writeFileSync(presetFilePath, content, 'utf8');
  } catch (err: any) {
    console.error(chalk.red(`プリセットの保存に失敗しました: ${err.message}`));
  }
}

/** 名前または1-indexed番号でプリセットを取得する */
export function getPreset(name: string): { presetName: string; options: StoredOptions } | undefined {
  const presets = readPresetFile();

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

/** プリセットを保存する（永続化する項目のみ） */
export function savePreset(name: string, options: StoredOptions): void {
  const presets = readPresetFile();
  const persisted: StoredOptions = {
    format: options.format,
    size: options.size,
    length: options.length,
    recursive: options.recursive || undefined,
    keep: options.keep || undefined,
    name: options.name,
    directory: options.directory,
  };
  presets[name] = persisted;
  writePresetFile(presets);
}

/** プリセットを削除する。成功すれば削除したプリセット名を返す */
export function deletePreset(nameOrIndex: string): string | undefined {
  const presets = readPresetFile();

  // 名前で直接一致する場合
  if (presets[nameOrIndex] !== undefined) {
    delete presets[nameOrIndex];
    writePresetFile(presets);
    return nameOrIndex;
  }

  // 番号指定の場合
  const index = Number.parseInt(nameOrIndex, 10);
  if (!Number.isNaN(index) && index > 0) {
    const entries = Object.entries(presets);
    const entry = entries[index - 1];
    if (entry) {
      delete presets[entry[0]];
      writePresetFile(presets);
      return entry[0];
    }
  }

  return undefined;
}

/** プリセット一覧をコンソールに表示する */
export function listPresets(): void {
  const presets = readPresetFile();
  const entries = Object.entries(presets);

  if (entries.length === 0) {
    console.log(chalk.yellow('プリセットがありません。'));
    console.log(chalk.gray('  imsq preset save <name>  で保存できます。'));
    return;
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
