import fs from 'node:fs';
import path from 'node:path';
import * as TOML from 'smol-toml';
import { getImsqDir } from './utils.js';

export type UserConfig = {
  watch?: {
    poll?: boolean;
    interval?: number;
  };
  poll?: boolean;
};

function getConfigPaths(): { optionsTomlPath: string; configTomlPath: string } {
  const imsqDir = getImsqDir();
  return {
    optionsTomlPath: path.join(imsqDir, 'options.toml'),
    configTomlPath: path.join(imsqDir, 'config.toml'),
  };
}

/**
 * ~/.config/imsq/options.toml または config.toml から設定を読み込む
 */
export function readUserConfig(): UserConfig {
  const { optionsTomlPath, configTomlPath } = getConfigPaths();
  const targetPath = fs.existsSync(optionsTomlPath)
    ? optionsTomlPath
    : fs.existsSync(configTomlPath)
      ? configTomlPath
      : undefined;

  if (!targetPath) {
    return {};
  }

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const parsed = TOML.parse(raw) as Record<string, any>;
    const watchObj = typeof parsed.watch === 'object' && parsed.watch !== null ? parsed.watch : {};

    const poll = typeof parsed.poll === 'boolean'
      ? parsed.poll
      : typeof watchObj.poll === 'boolean'
        ? watchObj.poll
        : typeof watchObj.usePolling === 'boolean'
          ? watchObj.usePolling
          : undefined;

    const interval = typeof watchObj.interval === 'number'
      ? watchObj.interval
      : typeof parsed.interval === 'number'
        ? parsed.interval
        : undefined;

    return {
      watch: {
        poll,
        interval,
      },
      poll,
    };
  } catch {
    return {};
  }
}
