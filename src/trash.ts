import fs from 'node:fs';
import trash from 'trash';
import {
  canAccessPowerShell,
  convertWslPathToWindows,
  isUncPath,
  isWsl,
  powerShellPath,
} from 'wsl-utils';
import { executePowerShell } from 'powershell-utils';

async function moveWindowsPathToTrash(filePath: string): Promise<void> {
  if (!(await canAccessPowerShell())) {
    throw new Error('WSLからWindowsのPowerShellを実行できません。実行権限とWSLのWindows連携設定を確認してください。');
  }

  const windowsPath = await convertWslPathToWindows(filePath);
  if (isUncPath(windowsPath)) {
    await trash([filePath], { glob: false });
    return;
  }
  if (!/^[A-Za-z]:[\\/]/u.test(windowsPath)) {
    throw new Error('WSLパスをWindowsローカルパスへ変換できませんでした');
  }

  const escapedPath = executePowerShell.escapeArgument(windowsPath);
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$p = ${escapedPath}
if (Test-Path -LiteralPath $p) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
}
`.trim();

  await executePowerShell(psScript, { powerShellPath: await powerShellPath() });
  if (fs.existsSync(filePath)) {
    throw new Error('元ファイルがゴミ箱へ移動されませんでした');
  }
}

export async function movePathToTrash(filePath: string): Promise<void> {
  if (!isWsl) {
    await trash([filePath], { glob: false });
    return;
  }

  await moveWindowsPathToTrash(filePath);
}
