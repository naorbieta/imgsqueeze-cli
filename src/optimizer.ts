import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import trash from 'trash';
import type { Sharp, ResizeOptions } from 'sharp';

export interface OptimizeResult {
  success: boolean;
  inputPath: string;
  outputPath?: string;
  originalSize: number;
  outputSize?: number;
  error?: string;
  warning?: string;
}

/**
 * 形式と品質を指定して画像を圧縮し、バッファを返す
 */
async function compress(
  instance: Sharp,
  formatName: string,
  quality: number
): Promise<Buffer> {
  const normFormat = formatName.toLowerCase();
  if (normFormat === 'jpg' || normFormat === 'jpeg') {
    return await instance.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
  } else if (normFormat === 'webp') {
    return await instance.clone().webp({ quality }).toBuffer();
  } else if (normFormat === 'png') {
    if (quality === 100) {
      return await instance.clone().png({ compressionLevel: 9 }).toBuffer();
    }
    // PNGはpalette: trueを指定することで、8bit量子化による劇的なサイズ削減(lossy)を行います
    return await instance.clone().png({ quality, palette: true, compressionLevel: 9 }).toBuffer();
  } else if (normFormat === 'gif') {
    if (quality === 100) {
      return await instance.clone().gif({ reuse: true }).toBuffer();
    }
    // GIFの色数を品質(10〜100)に応じて16〜256色にマッピングします
    const colours = Math.max(16, Math.min(256, Math.round(16 + (256 - 16) * (quality - 10) / 90)));
    return await instance.clone().gif({ colours, reuse: true }).toBuffer();
  } else {
    return await instance.clone().toBuffer();
  }
}

/**
 * -n / --name パターンからファイル名を生成する
 * ? → 元ファイル名 (拡張子除く)
 * * → 1桁 (1, 2, ..., 9, 10, ...)
 * ** → 2桁 (01, 02, ...)
 * *** → 3桁 (001, 002, ...)
 */
function applyNamePattern(pattern: string, originalBaseName: string, index: number, ext: string): string {
  // *** から順に長いものから置換 (短いパターンに誤マッチしないよう)
  let result = pattern.replaceAll('?', originalBaseName);
  if (result.includes('***')) {
    result = result.replace('***', String(index).padStart(3, '0'));
  } else if (result.includes('**')) {
    result = result.replace('**', String(index).padStart(2, '0'));
  } else if (result.includes('*')) {
    result = result.replace('*', String(index));
  }
  return result + ext;
}

function createTempOutputPath(targetPath: string): string {
  const tempName = `.imsq-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(path.dirname(targetPath), tempName);
}

async function movePathToTrash(filePath: string): Promise<void> {
  await trash([filePath]);
}

function deletePath(filePath: string): void {
  fs.unlinkSync(filePath);
}

async function replaceSamePathFromTemp(
  inputPath: string,
  outputPath: string,
  tempPath: string,
  hardDelete: boolean
): Promise<void> {
  if (hardDelete) {
    deletePath(inputPath);
  } else {
    await movePathToTrash(inputPath);
  }

  try {
    fs.copyFileSync(tempPath, outputPath);
  } catch (err) {
    try {
      fs.copyFileSync(tempPath, inputPath);
    } catch {
      // 復旧失敗時は元のエラーを優先する
    }
    throw err;
  }
}

/**
 * 単一の画像を最適化するメイン関数
 */
export async function optimizeImage(
  inputPath: string,
  outputDir: string,
  options: {
    format?: string;
    size?: number;
    /** ピクセル数または "50%" 形式のパーセント文字列 */
    widthSpec?: number | string;
    heightSpec?: number | string;
    /** w と h を両方ピクセル指定した場合、アスペクト比を無視してストレッチ */
    stretchMode?: boolean;
    keepMetadata?: boolean;
    namePattern?: string;
    fileIndex?: number;
    recursive: boolean;
    cwd: string;
    copyOnly?: boolean;
    hardDelete?: boolean;
    trashOriginal?: boolean;
  }
): Promise<OptimizeResult> {
  const absoluteInputPath = path.resolve(options.cwd, inputPath);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absoluteInputPath);
  } catch (err: any) {
    return {
      success: false,
      inputPath,
      originalSize: 0,
      error: `ファイルにアクセスできません: ${err.message}`,
    };
  }

  const originalSize = stats.size;
  const originalExt = path.extname(inputPath).toLowerCase();

  // 出力ファイルの拡張子と形式名を取得
  const targetExt = options.format
    ? `.${options.format.toLowerCase()}`
    : originalExt;
  const formatName = targetExt.substring(1) === 'jpg' ? 'jpeg' : targetExt.substring(1);

  // 出力パスの決定
  let absoluteOutputPath: string;

  if (options.namePattern) {
    // --name パターン指定時: ファイル名をパターンで置き換える
    const originalBaseName = path.basename(inputPath, originalExt);
    const newFileName = applyNamePattern(
      options.namePattern,
      originalBaseName,
      options.fileIndex ?? 1,
      targetExt
    );
    if (options.recursive) {
      const relativeInputPath = path.relative(options.cwd, absoluteInputPath);
      const dir = path.dirname(relativeInputPath);
      absoluteOutputPath = dir === '.'
        ? path.join(outputDir, newFileName)
        : path.join(outputDir, dir, newFileName);
    } else {
      absoluteOutputPath = path.join(outputDir, newFileName);
    }
  } else if (options.recursive) {
    const relativeInputPath = path.relative(options.cwd, absoluteInputPath);
    const extName = path.extname(relativeInputPath);
    const baseName = relativeInputPath.slice(0, relativeInputPath.length - extName.length);
    const relativeOutputPath = baseName + targetExt;
    absoluteOutputPath = path.join(outputDir, relativeOutputPath);
  } else {
    const fileName = path.basename(inputPath);
    const extName = path.extname(fileName);
    const baseName = path.basename(fileName, extName);
    absoluteOutputPath = path.join(outputDir, baseName + targetExt);
  }

  try {
    // アニメーションGIF/WebPの場合はフレームを維持して読み込む
    const isAnimated = originalExt === '.gif' || originalExt === '.webp';
    const outputDirPath = path.dirname(absoluteOutputPath);
    const samePath = absoluteInputPath === absoluteOutputPath;
    let warning: string | undefined;

    if (!fs.existsSync(outputDirPath)) {
      fs.mkdirSync(outputDirPath, { recursive: true });
    }

    if (options.copyOnly) {
      const tempOutputPath = createTempOutputPath(absoluteOutputPath);
      try {
        fs.copyFileSync(absoluteInputPath, tempOutputPath);

        if (samePath) {
          await replaceSamePathFromTemp(
            absoluteInputPath,
            absoluteOutputPath,
            tempOutputPath,
            !!options.hardDelete
          );
        } else {
          fs.copyFileSync(tempOutputPath, absoluteOutputPath);
          if (options.hardDelete) {
            deletePath(absoluteInputPath);
          } else if (options.trashOriginal) {
            await movePathToTrash(absoluteInputPath);
          }
        }
      } finally {
        if (fs.existsSync(tempOutputPath)) {
          fs.unlinkSync(tempOutputPath);
        }
      }

      return {
        success: true,
        inputPath,
        outputPath: path.relative(options.cwd, absoluteOutputPath),
        originalSize,
        outputSize: originalSize,
        warning,
      };
    }

    let sharpInstance = sharp(absoluteInputPath, isAnimated ? { animated: true } : {});

    // メタデータ取得 (パーセント指定のリサイズに必要)
    const metadata = await sharpInstance.metadata();

    // リサイズ設定の組み立て
    const { widthSpec, heightSpec, stretchMode } = options;
    const resizeOpts: ResizeOptions = {};
    let shouldResize = false;

    if (widthSpec !== undefined || heightSpec !== undefined) {
      let pixelWidth: number | undefined;
      let pixelHeight: number | undefined;

      // パーセント → ピクセルへ変換
      if (typeof widthSpec === 'string' && widthSpec.endsWith('%')) {
        const pct = parseFloat(widthSpec) / 100;
        if (metadata.width) pixelWidth = Math.round(metadata.width * pct);
      } else if (typeof widthSpec === 'number') {
        pixelWidth = widthSpec;
      }

      if (typeof heightSpec === 'string' && heightSpec.endsWith('%')) {
        const pct = parseFloat(heightSpec) / 100;
        if (metadata.height) pixelHeight = Math.round(metadata.height * pct);
      } else if (typeof heightSpec === 'number') {
        pixelHeight = heightSpec;
      }

      if (stretchMode) {
        // w と h を両方ピクセル指定 → アスペクト比を無視してストレッチ
        resizeOpts.fit = 'fill';
      } else {
        // 片方のみ指定、またはパーセント指定 → アスペクト比を維持
        resizeOpts.fit = 'inside';
        resizeOpts.withoutEnlargement = true;
      }

      if (pixelWidth) resizeOpts.width = pixelWidth;
      if (pixelHeight) resizeOpts.height = pixelHeight;
      shouldResize = true;
    }

    if (shouldResize) {
      sharpInstance = sharpInstance.resize(resizeOpts);
    }

    // メタデータ保持
    if (options.keepMetadata) {
      sharpInstance = sharpInstance.withMetadata();
    }

    let finalBuffer: Buffer;

    if (options.size) {
      const targetSize = options.size;
      let quality = 100;
      let targetMet = false;

      // まず品質100で試す
      finalBuffer = await compress(sharpInstance, formatName, quality);
      if (finalBuffer.length <= targetSize) {
        targetMet = true;
      } else {
        // 品質を95から10まで5刻みで下げる
        for (quality = 95; quality >= 10; quality -= 5) {
          finalBuffer = await compress(sharpInstance, formatName, quality);
          if (finalBuffer.length <= targetSize) {
            targetMet = true;
            break;
          }
        }
      }

      if (!targetMet) {
        warning = `最低品質でも指定容量 (${options.size}B) を下回りませんでした (結果: ${finalBuffer.length}B)`;
      }
    } else {
      // 容量指定がない場合はデフォルト品質80で圧縮
      finalBuffer = await compress(sharpInstance, formatName, 80);
    }

    const tempOutputPath = createTempOutputPath(absoluteOutputPath);
    try {
      fs.writeFileSync(tempOutputPath, finalBuffer);

      if (samePath) {
        await replaceSamePathFromTemp(
          absoluteInputPath,
          absoluteOutputPath,
          tempOutputPath,
          !!options.hardDelete
        );
      } else {
        fs.copyFileSync(tempOutputPath, absoluteOutputPath);
        if (options.hardDelete) {
          deletePath(absoluteInputPath);
        } else if (options.trashOriginal) {
          await movePathToTrash(absoluteInputPath);
        }
      }
    } finally {
      if (fs.existsSync(tempOutputPath)) {
        fs.unlinkSync(tempOutputPath);
      }
    }

    return {
      success: true,
      inputPath,
      outputPath: path.relative(options.cwd, absoluteOutputPath),
      originalSize,
      outputSize: fs.statSync(absoluteOutputPath).size,
      warning,
    };
  } catch (err: any) {
    return {
      success: false,
      inputPath,
      originalSize,
      error: `画像処理エラー: ${err.message}`,
    };
  }
}
