const { execSync } = require('child_process');
try {
  execSync('npx tsx src/index.ts', { stdio: 'inherit' });
} catch (e) {
  console.error('CRASH:', e.message);
}
