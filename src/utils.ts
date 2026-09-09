import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * CLI設定・状態ファイルの保存ディレクトリパスを返す。
 * 旧パス (~/.imsq/ または ~/.imsq.json) が存在する場合は
 * 自動的に新パスへ移行してから新パスを返す。
 *
 * 優先順位:
 *  1. $XDG_CONFIG_HOME/imsq
 *  2. ~/.config/imsq/
 *  (旧パスのみ存在する場合は自動移行のうえ上記へ)
 */
export function getImsqDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const primaryDir = path.join(configHome, 'imsq');
  const legacyDir = path.join(os.homedir(), '.imsq');

  const legacyExists = fs.existsSync(legacyDir);
  const primaryExists = fs.existsSync(primaryDir);

  if (legacyExists && !primaryExists) {
    // 旧ディレクトリを新ディレクトリへ移行
    try {
      fs.renameSync(legacyDir, primaryDir);
    } catch {
      // 異なるファイルシステム間など rename が使えない場合はコピー+削除
      try {
        copyDirRecursive(legacyDir, primaryDir);
        fs.rmSync(legacyDir, { recursive: true, force: true });
      } catch {
        // 移行に失敗してもクラッシュさせない。旧パスを引き続き使う。
        return legacyDir;
      }
    }
  }

  migrateLegacyStateFile(
    path.join(os.homedir(), '.imsq.json'),
    path.join(primaryDir, 'options.json'),
  );

  return primaryDir;
}

function migrateLegacyStateFile(legacyPath: string, currentPath: string): void {
  if (!fs.existsSync(legacyPath) || fs.existsSync(currentPath)) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.renameSync(legacyPath, currentPath);
  } catch {
    try {
      fs.copyFileSync(legacyPath, currentPath);
      fs.unlinkSync(legacyPath);
    } catch {
      // 移行に失敗しても、旧ファイルを残して処理を継続する。
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 容量指定の文字列をバイト数値に変換する (例: 100kb -> 102400)
 * 対応単位: B, KB, MB, GB (大文字小文字不問)
 */
export function parseSize(sizeStr: string): number {
  const match = sizeStr.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) {
    throw new Error(`無効な容量指定です: "${sizeStr}". 例: 100kb, 2mb`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();

  switch (unit) {
    case 'b':
      return Math.round(value);
    case 'kb':
      return Math.round(value * 1024);
    case 'mb':
      return Math.round(value * 1024 * 1024);
    case 'gb':
      return Math.round(value * 1024 * 1024 * 1024);
    default:
      return Math.round(value);
  }
}

/**
 * バイト数値を読みやすいサイズ表記に変換する (例: 102400 -> "100KB")
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1).replace(/\.0$/, '')}MB`;
}

/**
 * -d / --directory オプションに応じた出力先ディレクトリのフルパスを返す。
 * - 未指定 → カレントディレクトリ内に重複しない "optimized" フォルダを自動生成
 * - "." → カレントディレクトリそのもの
 * - その他 → 指定パスをそのまま使用 (絶対パスまたはcwd相対)
 */
export function resolveOutputDir(cwd: string, directoryOption?: string): string {
  if (!directoryOption) {
    return getUniqueOutputDir(cwd);
  }
  if (directoryOption === '.') {
    return cwd;
  }
  return path.resolve(cwd, directoryOption);
}

/**
 * 指定ディレクトリ直下で重複しない出力先フォルダ名 (例: optimized, optimized_1) を判定してフルパスを返す
 */
export function getUniqueOutputDir(baseDir: string): string {
  let targetPath = path.join(baseDir, 'optimized');
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }

  let counter = 1;
  while (true) {
    targetPath = path.join(baseDir, `optimized_${counter}`);
    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }
    counter++;
  }
}

/**
 * カレントディレクトリ内の画像を探索する。
 * node_modules, .git, および自動生成された出力先ディレクトリは除外する。
 */
export async function scanImages(
  cwd: string,
  recursive: boolean,
  ignoreDirs: string[]
): Promise<string[]> {
  const pattern = recursive
    ? '**/*.{jpg,jpeg,png,gif,webp}'
    : '*.{jpg,jpeg,png,gif,webp}';

  const ignore = [
    '**/node_modules/**',
    '**/.git/**',
    ...ignoreDirs.flatMap((dir) => [
      `**/${dir}/**`,
      `${dir}/**`,
    ]),
  ];

  // Windowsのパス区切り文字をスラッシュに置換してfast-globに渡す
  const files = await fg(pattern, {
    cwd: cwd.replace(/\\/g, '/'),
    ignore: ignore.map((p) => p.replace(/\\/g, '/')),
    caseSensitiveMatch: false,
    onlyFiles: true,
  });

  // Windows環境のパス形式に正規化して返す
  return files.map((file) => path.normalize(file));
}
