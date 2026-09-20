import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Anything git ignores, eslint ignores too. Without this the checks
    // pass here and fail inside tools/gpu-box: that container unpacks
    // Chromium into `.box-browsers/` under the working directory, and
    // linting a bundled browser produces hundreds of errors about code
    // nobody in this repository wrote.
    ignores: [
      'node_modules/',
      'dist/',
      'test-results/',
      'artifacts/',
      '.box-browsers/',
      '.playwright-mcp/',
    ],
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
