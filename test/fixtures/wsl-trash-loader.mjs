const mocks = new Map([
  ['wsl-utils', `
export const isWsl = process.env.IMSQ_TEST_NOT_WSL !== '1';
export const canAccessPowerShell = async () => true;
export const convertWslPathToWindows = async paths => {
  const isArray = Array.isArray(paths);
  const values = (isArray ? paths : [paths]).map(path => {
    if (process.env.IMSQ_TEST_WSL_NOTIFY_UNC === '1' && isArray) {
      return String.raw\`\\\\wsl.localhost\\Ubuntu\\home\\nao\\output\`;
    }
    if (process.env.IMSQ_TEST_WSL_NOTIFY_PATHS === '1' && isArray) {
      const basename = path.slice(path.lastIndexOf('/') + 1);
      return String.raw\`C:\\\\Users\\\\nao\\\\画像 [a]'b\` + '\\\\' + basename;
    }
    return process.env.IMSQ_TEST_WSL_CONVERSION_FAILURE === '1'
      ? path
      : String.raw\`C:\\\\Users\\\\nao\\\\画像 [a]'b.png\`;
  });
  return isArray ? values : values[0];
};
export const isUncPath = value => /^\\\\\\\\/.test(value);
export const powerShellPath = async () => '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
`],
  ['node:child_process', `
import {Buffer} from 'node:buffer';
import {promisify} from 'node:util';
import fs from 'node:fs';
import {execFileSync as inspectOpenFiles} from 'node:child_process';

function sourcePathIsOpen(filePath) {
  if (process.platform === 'darwin') {
    const output = inspectOpenFiles('/usr/sbin/lsof', ['-p', String(process.pid), '-Fn'], {encoding: 'utf8'});
    const realPath = fs.realpathSync(filePath);
    return output.split('\\n').some(line => line === 'n' + realPath);
  }
  if (process.platform === 'linux') {
    const realPath = fs.realpathSync(filePath);
    return fs.readdirSync('/proc/self/fd').some(fd => {
      try {
        return fs.realpathSync('/proc/self/fd/' + fd) === realPath;
      } catch {
        return false;
      }
    });
  }
  return false;
}

const execFile = () => {
  throw new Error('execFile callback should be wrapped by promisify');
};

execFile[promisify.custom] = async (file, args) => {
  const expected = process.env.IMSQ_TEST_EXPECTED_PS_PATH;
  if (file !== expected) {
    throw new Error('PowerShell executable path mismatch: ' + file);
  }
  const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  if (command.includes('SHChangeNotify')) {
    const requiredPaths = process.env.IMSQ_TEST_NOTIFICATION_REQUIRED_PATHS
      ? JSON.parse(process.env.IMSQ_TEST_NOTIFICATION_REQUIRED_PATHS)
      : [];
    for (const requiredPath of requiredPaths) {
      if (!fs.existsSync(requiredPath)) {
        throw new Error('notification arrived before required output: ' + requiredPath);
      }
    }
    if (process.env.IMSQ_TEST_NOTIFICATION_LOG) {
      fs.appendFileSync(process.env.IMSQ_TEST_NOTIFICATION_LOG, JSON.stringify(command) + '\\n');
    }
    if (process.env.IMSQ_TEST_NOTIFICATION_ERROR === '1') {
      throw new Error('simulated Shell notification failure');
    }
    return {stdout: '', stderr: ''};
  }
  if (!command.includes('Test-Path -LiteralPath')) {
    throw new Error('WSL trash command must use LiteralPath');
  }
  if (!command.includes(String.raw\`C:\\\\Users\\\\nao\\\\画像 [a]''b.png\`)) {
    throw new Error('WSL trash command changed the literal path');
  }
  if (process.env.IMSQ_TEST_FAIL_IF_SOURCE_OPEN === '1'
    && process.env.IMSQ_TEST_WSL_SOURCE_PATH
    && sourcePathIsOpen(process.env.IMSQ_TEST_WSL_SOURCE_PATH)) {
    throw new Error('input source remains open at the Windows trash boundary');
  }
  if (process.env.IMSQ_TEST_WSL_MOVE_SOURCE === '1') {
    fs.renameSync(process.env.IMSQ_TEST_WSL_SOURCE_PATH, process.env.IMSQ_TEST_WSL_BIN_PATH);
    return {stdout: '', stderr: ''};
  }
  if (process.env.IMSQ_TEST_WSL_REJECT_AFTER_DELETE === '1') {
    fs.renameSync(process.env.IMSQ_TEST_WSL_SOURCE_PATH, process.env.IMSQ_TEST_WSL_BIN_PATH);
    throw new Error('simulated PowerShell failure after moving the original to the Recycle Bin');
  }
  if (process.env.IMSQ_TEST_WSL_SOURCE_PATH && process.env.IMSQ_TEST_WSL_NOOP !== '1') {
    fs.unlinkSync(process.env.IMSQ_TEST_WSL_SOURCE_PATH);
  }
  return {stdout: '', stderr: ''};
};

const execFileSync = () => {
  throw new Error('execFileSync is not expected in the WSL trash probe');
};

export {execFile, execFileSync};
export default {execFile, execFileSync};
`],
]);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process' && !context.parentURL?.includes('/node_modules/powershell-utils/index.js')) {
    return nextResolve(specifier, context);
  }

  const source = mocks.get(specifier);
  if (source) {
    return {url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true};
  }

  return nextResolve(specifier, context);
}
