// Node's built-in type stripping handles .ts but refuses .tsx outright, so the
// test runner cannot import a component at all. This is the smallest loader
// that makes components importable in tests: TS/TSX transpilation, the
// extensionless specifiers the app writes, and inert CSS.
//
// Tests only -- the app is still built by vite, untouched.
import { transform } from 'esbuild';

const CANDIDATES = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  // Stylesheets have no meaning here, but importing one must not explode.
  if (/\.css($|\?)/.test(specifier)) {
    return { url: 'data:text/javascript,export default {}', format: 'module', shortCircuit: true };
  }

  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]sx?($|\?)/.test(specifier)) {
    for (const extension of CANDIDATES) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch {
        // Try the next shape.
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!/\.tsx?($|\?)/.test(url)) return nextLoad(url, context);

  const loaded = await nextLoad(url, { ...context, format: 'module' });
  const { code } = await transform((loaded.source ?? '').toString(), {
    loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'node22',
    jsx: 'automatic',
    sourcefile: url,
    sourcemap: 'inline',
  });
  return { format: 'module', source: code, shortCircuit: true };
}
