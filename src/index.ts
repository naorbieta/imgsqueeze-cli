#!/usr/bin/env -S node --no-warnings

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkbox, confirm, select, input } from '@inquirer/prompts';
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

