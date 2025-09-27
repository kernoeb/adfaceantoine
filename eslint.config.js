import antfu from '@antfu/eslint-config'

export default antfu(
  {
    formatters: {
      html: true,
    },
    stylistic: true,
    rules: {
      'antfu/if-newline': 'off',
      'nonblock-statement-body-position': 'error',
      'curly': ['error', 'multi-line', 'consistent'],
      'style/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      'unused-imports/no-unused-vars': 'warn',
      'unused-imports/no-unused-imports': 'warn',
      'jsonc/sort-keys': 'error',
      'antfu/no-top-level-await': 'off',
      'no-console': 'off',
      'new-cap': 'off',
    },
  },
)
