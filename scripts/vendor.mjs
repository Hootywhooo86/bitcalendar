// Bundles the libraries the app imports into app/vendor/, so the web app, the APK and the
// desktop app all start without reaching a CDN. Run after changing versions in package.json.
import { build } from 'esbuild';

const opts = { bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2020', legalComments: 'none', logLevel: 'info' };
await build({ ...opts, stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: '.' }, outfile: 'app/vendor/supabase.js' });
await build({
  ...opts,
  stdin: {
    contents: [
      "export { Capacitor, registerPlugin } from '@capacitor/core';",
      "export { LocalNotifications } from '@capacitor/local-notifications';",
      "export { App } from '@capacitor/app';",
      "export { Browser } from '@capacitor/browser';",
    ].join('\n'),
    resolveDir: '.',
  },
  outfile: 'app/vendor/capacitor.js',
});
