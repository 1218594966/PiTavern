import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // faux 注册表是全局的，串行跑避免互相干扰
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 15000,
  },
});
