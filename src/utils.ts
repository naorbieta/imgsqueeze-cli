import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

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
