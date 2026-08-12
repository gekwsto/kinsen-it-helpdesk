/**
 * Test-only Node preload (--require this file) that stubs out the
 * "server-only" marker package (imported by lib/web-push.ts) for scripts
 * run directly via tsx/node outside Next.js's own build.
 *
 * "server-only"'s real index.js unconditionally throws — it's a build-time
 * guard meant to fail a webpack build if server-only code is ever bundled
 * into client code. Next.js's own bundler resolves it via the package's
 * "react-server" exports condition (see node_modules/server-only/package.json)
 * to a harmless empty module instead. Plain `node --import tsx` doesn't set
 * that condition, so any script that transitively imports lib/web-push.ts
 * would otherwise crash immediately on that import alone.
 *
 * Deliberately NOT solved with `node --conditions=react-server` — that flag
 * also changes how React/Next's OWN internal packages resolve (they ALSO
 * define a "react-server" condition), which breaks unrelated tests that
 * need the real client React build (e.g. anything touching next/navigation).
 * Pre-populating the require cache for this ONE package, before anything
 * else loads, has no effect on any other module's resolution.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --import tsx <script>
 */
const resolved = require.resolve("server-only");
require.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: {},
};
