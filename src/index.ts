#!/usr/bin/env -S node --no-warnings

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkbox, confirm } from '@inquirer/prompts';
import { scanImages, parseSize, formatSize, resolveOutputDir } from './utils.js';
import { optimizeImage } from './optimizer.js';

const program = new Command();

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

async function main() {
  const options = program.opts();
  const cwd = process.cwd();

  // 1. フォーマットの検証
  const allowedFormats = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  let format: string | undefined = options.format;
  if (format) {
    format = format.toLowerCase();
    if (!allowedFormats.includes(format)) {
      console.error(chalk.red(`エラー: サポートされていないフォーマットです: ${options.format}`));
      console.log(chalk.gray(`サポートされている形式: ${allowedFormats.join(', ')}`));
      process.exit(1);
    }
  }

  // 2. サイズ制限のパース
  let targetSize: number | undefined;
  if (options.size) {
    try {
      targetSize = parseSize(options.size);
    } catch (err: any) {
      console.error(chalk.red(`エラー: ${err.message}`));
      process.exit(1);
    }
  }

  // 3. リサイズオプションの検証・パース
  //    値はピクセル数 (number) またはパーセント文字列 (例: "50%")
  let widthSpec: number | string | undefined;
  let heightSpec: number | string | undefined;
  let stretchMode = false; // w と h を両方指定した場合はストレッチ

  if (options.length) {
    const lengthStr = options.length.trim().toLowerCase();
    const parts = lengthStr.split(/[\s,;]+/);
    for (const part of parts) {
      if (part.startsWith('w:')) {
        const raw = part.slice(2);
        if (raw.endsWith('%')) {
          const pct = parseFloat(raw);
          if (isNaN(pct) || pct <= 0) {
            console.error(chalk.red(`エラー: 横幅のパーセント値が不正です: "${part}"`));
            process.exit(1);
          }
          widthSpec = raw;
        } else {
          const val = parseInt(raw, 10);
          if (isNaN(val) || val <= 0) {
            console.error(chalk.red(`エラー: 横幅の値が不正です: "${part}"`));
            process.exit(1);
          }
          widthSpec = val;
        }
      } else if (part.startsWith('h:')) {
        const raw = part.slice(2);
        if (raw.endsWith('%')) {
          const pct = parseFloat(raw);
          if (isNaN(pct) || pct <= 0) {
            console.error(chalk.red(`エラー: 高さのパーセント値が不正です: "${part}"`));
            process.exit(1);
          }
          heightSpec = raw;
        } else {
          const val = parseInt(raw, 10);
          if (isNaN(val) || val <= 0) {
            console.error(chalk.red(`エラー: 高さの値が不正です: "${part}"`));
            process.exit(1);
          }
          heightSpec = val;
        }
      } else {
        console.error(
          chalk.red(
            `エラー: 無効な長さ指定です: "${part}"。 "w:600", "h:400", "w:50%" の形式で指定してください。`
          )
        );
        process.exit(1);
      }
    }
    // w と h の両方をピクセル指定した場合はストレッチ (アスペクト比無視)
    if (widthSpec !== undefined && heightSpec !== undefined &&
        typeof widthSpec === 'number' && typeof heightSpec === 'number') {
      stretchMode = true;
    }
  }

  // 4. 出力先ディレクトリを決定
  const outputDir = resolveOutputDir(cwd, options.directory);

  // 5. カレントディレクトリ内の既存の 'optimized*' ディレクトリを特定してスキャンから除外する
  const ignoreDirs: string[] = [];
  try {
    const filesInCwd = fs.readdirSync(cwd);
    for (const file of filesInCwd) {
      if (file.startsWith('optimized')) {
        const fullPath = path.join(cwd, file);
        if (fs.statSync(fullPath).isDirectory()) {
          ignoreDirs.push(file);
        }
      }
    }
  } catch (_err) {
    // 読み�  // 7. オプションサマリー表示 (全項目を常に出す)

  /** CJK全角文字を幅2としてビジュアル幅を計算する */
  function visualWidth(str: string): number {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0) ?? 0;
      const isWide =
        (cp >= 0x1100 && cp <= 0x115F) ||
        (cp >= 0x2E80 && cp <= 0x303E) ||
        (cp >= 0x3041 && cp <= 0x33FF) ||
        (cp >= 0xFE30 && cp <= 0xFE4F) ||
        (cp >= 0xFF01 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||
        (cp >= 0x4E00 && cp <= 0x9FFF) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) ||
        (cp >= 0xF900 && cp <= 0xFAFF);
      w += isWide ? 2 : 1;
    }
    return w;
  }

  /** ビジュアル幅を考慮して右をスペースで埋める */
  function padLabel(str: string, target: number): string {
    return str + ' '.repeat(Math.max(0, target - visualWidth(str)));
  }

  function formatResizeSpec(raw: string): string {
    return raw
      .split(/[\s,;]+/)
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
  }

  const resizeValue = options.length
    ? formatResizeSpec(options.length) + (stretchMode ? ' (ストレッチ)' : '')
    : undefined;

  type OptionRow = { label: string; flag: string; value: string | undefined };
  const optionRows: OptionRow[] = [
    { label: 'フォーマット',   flag: '-f', value: format ?? undefined },
    { label: '最大サイズ',     flag: '-s', value: targetSize !== undefined ? formatSize(targetSize) : undefined },
    { label: 'リサイズ',       flag: '-l', value: resizeValue },
    { label: 'メタデータ保持', flag: '-k', value: options.keep      ? '有効' : undefined },
    { label: 'リネーム',       flag: '-n', value: options.name      ?? undefined },
    { label: '対話モード',     flag: '-p', value: options.pick      ? '有効' : undefined },
    { label: '再帰処理',       flag: '-r', value: options.recursive ? '有効' : undefined },
    { label: '出力先指定',     flag: '-d', value: options.directory ?? undefined },
    { label: '確認モード',     flag: '-c', value: options.confirm   ? '有効' : undefined },
  ];

  // ラベルの最大ビジュアル幅を求めてコロン位置を揃える
  const maxLabelWidth = Math.max(...optionRows.map((r) => visualWidth(r.label)));

  console.log(chalk.gray('─'.repeat(44)));
  console.log(chalk.bold('オプション:'));
  for (const row of optionRows) {
    const flag  = chalk.gray(`(${row.flag})`);
    const colon = chalk.gray(' : ');
    const paddedLabel = padLabel(row.label, maxLabelWidth);
    if (row.value !== undefined) {
      console.log(`  ${chalk.white(paddedLabel)}${colon}${chalk.cyan(row.value)}  ${flag}`);
    } else {
      console.log(`  ${chalk.gray(paddedLabel)}${colon}${chalk.gray('--')}  ${flag}`);
    }
  }
  console.log(chalk.gray('─'.repeat(44))); { label: 'リサイズ',       flag: '-l', value: resizeValue },
    { label: 'メタデータ保持', flag: '-k', value: options.keep      ? '有効' : undefined },
    { label: 'リネーム',       flag: '-n', value: options.name      ?? undefined },
    { label: '対話モード',     flag: '-p', value: options.pick      ? '有効' : undefined },
    { label: '再帰処理',       flag: '-r', value: options.recursive ? '有効' : undefined },
    { label: '出力先指定',     flag: '-d', value: options.directory ?? undefined },
    { label: '確認モード',     flag: '-c', value: options.confirm   ? '有効' : undefined },
  ];

  console.log(chalk.gray('─'.repeat(44)));
  console.log(chalk.bold('オプション:'));
  for (const row of optionRows) {
    const flag  = chalk.gray(`(${row.flag})`);
    const colon = chalk.gray(' : ');
    if (row.value !== undefined) {
      const label = chalk.white(row.label.padEnd(8));
      const val   = chalk.cyan(row.value);
      console.log(`  ${label}${colon}${val}  ${flag}`);
    } else {
      const label = chalk.gray(row.label.padEnd(8));
      const val   = chalk.gray('--');
      console.log(`  ${label}${colon}${val}  ${flag}`);
    }
  }
  console.log(chalk.gray('─'.repeat(44)));


  // 8. -p / --pick: 対話モードで画像を選択
  if (options.pick) {
    console.log(chalk.cyan('\n対話モード: スペースキーで選択/解除、Enterで確定、Escでキャンセル\n'));
    try {
      const selected = await checkbox({
        message: '処理する画像を選択してください:',
        choices: imageFiles.map((f) => ({ name: f, value: f, checked: true })),
        pageSize: 20,
      });
      if (selected.length === 0) {
        console.log(chalk.yellow('画像が選択されませんでした。処理を中断します。'));
        process.exit(0);
      }
      imageFiles = selected;
    } catch (err: any) {
      // Esc / Ctrl+C などで中断 (ExitPromptError)
      console.log(chalk.yellow('\n選択がキャンセルされました。'));
      process.exit(0);
    }
  }

  // 9. -c / --confirm: 処理前確認
  if (options.confirm) {
    const displayOutputDir = options.directory === '.'
      ? '現在のディレクトリ (.)'
      : path.relative(cwd, outputDir) || outputDir;

    console.log('');
    console.log(chalk.bold(`対象ファイル数: ${imageFiles.length} 件`));
    console.log(chalk.bold(`出力先        : ${displayOutputDir}/`));
    console.log('');

    try {
      const ok = await confirm({ message: '処理を開始しますか？', default: true });
      if (!ok) {
        console.log(chalk.yellow('処理をキャンセルしました。'));
        process.exit(0);
      }
    } catch (_err) {
      // Esc / Ctrl+C
      console.log(chalk.yellow('\n処理をキャンセルしました。'));
      process.exit(0);
    }
  }

  // 10. 出力先の表示
  const displayOutputDir = options.directory === '.'
    ? '現在のディレクトリ (.)' 
    : path.relative(cwd, outputDir) || outputDir;
  console.log(chalk.blue(`\n出力先ディレクトリ: ${displayOutputDir}/\n`));

  // 11. 最適化処理ループ
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
    });

    if (result.success) {
      successCount++;
      totalOriginalSize += result.originalSize;
      totalOutputSize += result.outputSize || 0;

      const reduction = result.originalSize - (result.outputSize || 0);
      const reductionRate = result.originalSize > 0
        ? Math.max(0, (reduction / result.originalSize * 100)).toFixed(1)
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

  // 12. 完了サマリー表示
  const totalReduction = Math.max(0, totalOriginalSize - totalOutputSize);

  console.log(chalk.bold.green('処理完了\n'));
  console.log(`対象ファイル数 : ${imageFiles.length}`);
  console.log(`成功           : ${successCount}`);
  console.log(`失敗           : ${failureCount}`);
  console.log(`総削減容量     : ${formatSize(totalReduction)}`);
}

main().catch((err) => {
  console.error(chalk.red(`致命的なエラーが発生しました: ${err.message}`));
  process.exit(1);
});
