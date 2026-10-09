// Runs the acceptance test files named on the command line.
const files = process.argv.slice(2);
if (!files.length) { console.log('no tests found'); process.exit(1); }
for (const f of files) await import('../' + f);
console.log(`${files.length} acceptance files passed`);
