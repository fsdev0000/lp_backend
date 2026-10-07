const { swaggerSpec } = require('../src/config/swagger.ts');

console.log('Swagger Title:', swaggerSpec.info.title);
console.log('Swagger Tags:', swaggerSpec.tags.map(t => t.name));

const paths = Object.keys(swaggerSpec.paths);
console.log('\nTotal Documented Paths:', paths.length);
console.log('Newsletter Paths:');
for (const path of paths) {
  if (path.includes('newsletter')) {
    const methods = Object.keys(swaggerSpec.paths[path]).map(m => m.toUpperCase());
    console.log(`  ${methods.join(', ')} ${path}`);
  }
}
