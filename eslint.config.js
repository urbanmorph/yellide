// Minimal, and deliberately so. Yellide has no build step and no dependencies, so this
// exists to catch the two things that have actually bitten: a name referenced but never
// defined, and a value computed but never used.
module.exports = [
  {
    files: ['server/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        fetch: 'readonly', AbortController: 'readonly', URL: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',              // PKG_VERSION was referenced and never defined
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],   // `catch {}` is the house idiom
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // The Worker is ESM and runs against the Cloudflare runtime, not Node.
    files: ['edge/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        fetch: 'readonly', Response: 'readonly', Request: 'readonly',
        crypto: 'readonly', URL: 'readonly', TextEncoder: 'readonly', console: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' },
  },
];
