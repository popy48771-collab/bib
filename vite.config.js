import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// GitHub Pages ではリポジトリ名がパスに入る (https://<user>.github.io/<repo>/)。
// Actions 側から BASE_PATH を渡す。ローカル開発時は '/'。
const base = process.env.BASE_PATH ?? '/';
export default defineConfig({
    base,
    plugins: [react()],
});
