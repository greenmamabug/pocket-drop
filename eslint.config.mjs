import globals from 'globals';
export default [
  { ignores: ['vendor/**', 'node_modules/**', 'release/**', 'assets/**'] },
  {
    files: [
      'app/**/*.{js,mjs,cjs}',
      'ui/**/*.{js,mjs}',
      'scripts/**/*.{js,mjs,cjs}',
      'test/**/*.mjs',
    ],
    languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser } },
    rules: {
      'no-undef': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-async-promise-executor': 'error',
      'valid-typeof': 'error',
    },
  },
];
