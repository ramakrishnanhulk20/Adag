// Loaded with --import before the tests: src/lib uses extensionless relative imports so Next.js and tsc can read it,
// and bare Node needs the ".ts" added, the same hook scripts/check-batches.mjs uses.
import { registerHooks } from 'node:module';

// The app's "@/..." alias points at src, as tsconfig.json says, so a route can be loaded here too.
const SRC = new URL('../../../', import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const base = new URL(specifier.slice(2), SRC).href;
      for (const candidate of [`${base}.ts`, `${base}.tsx`, base]) {
        try {
          return next(candidate, context);
        } catch {
          // Try the next spelling.
        }
      }
    }
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  emitWarning(warning, ...rest);
};
