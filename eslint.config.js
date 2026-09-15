import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'test-results/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The bench corpus is the one thing in this repository that runs in a
    // page rather than in Node: it is the application under the camera, not
    // part of the package.
    files: ['fixtures/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
)
