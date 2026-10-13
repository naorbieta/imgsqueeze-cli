export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'trash') {
    const trashImplementation = `
export default async function trash() {
  if (process.env.IMSQ_TEST_TRASH_NOOP === '1') return;
  const error = new Error(process.env.IMSQ_TEST_TRASH_MESSAGE || 'WSL interop is disabled. Enable it or use Linux trash implementation.');
  if (process.env.IMSQ_TEST_TRASH_STDERR) error.stderr = process.env.IMSQ_TEST_TRASH_STDERR;
  throw error;
}`;
    return {
      url: `data:text/javascript,${encodeURIComponent(trashImplementation)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
