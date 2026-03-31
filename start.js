try {
  require('tsx/cjs/api').register();
  require('./src/index.ts');
} catch (e) {
  console.error('ERRO AO INICIAR:', e);
  process.exit(1);
}
