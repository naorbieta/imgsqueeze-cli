import fs from 'node:fs';

const sourcePath = process.env.IMSQ_TEST_WSL_SOURCE_PATH;
const realExistsSync = fs.existsSync.bind(fs);
let sourceWasObservedMissing = false;

fs.existsSync = path => {
  if (path === sourcePath) {
    const exists = realExistsSync(path);
    if (!exists) sourceWasObservedMissing = true;
    return sourceWasObservedMissing ? true : exists;
  }
  return realExistsSync(path);
};
