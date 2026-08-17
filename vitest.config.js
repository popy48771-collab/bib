import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        // DOMParser を使う NDL パーサのテストのために DOM 実装が要る
        environment: 'jsdom',
        include: ['src/**/*.test.ts'],
    },
});
