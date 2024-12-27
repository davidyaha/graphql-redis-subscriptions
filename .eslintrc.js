module.exports = {
    root: true,
    parser: '@typescript-eslint/parser',
    plugins: [
        '@typescript-eslint',
    ],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-require-imports': 'warn',
        '@typescript-eslint/no-unused-vars': [ 'error',
            { caughtErrors: 'none' }
        ]
    }
};
