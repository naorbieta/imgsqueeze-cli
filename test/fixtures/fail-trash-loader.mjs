export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'trash') {
    const trashImplementation = process.env.IMSQ_TEST_TRASH_NOOP === '1'
      ? 'export default async function trash() {}'
      : 'export default async function trash() { throw new Error("WSL interop is disabled. Enable it or use Linux trash implementation."); }';
    return {
      url: `data:text/javascript,${encodeURIComponent(trashImplementation)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
