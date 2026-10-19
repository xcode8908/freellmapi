import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const stagingDir = path.join(rootDir, '.botkeep-staging');
const outputZip = path.join(rootDir, 'freellmapi-botkeep.zip');

console.log('Cleaning previous artifacts...');
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
if (fs.existsSync(outputZip)) {
  fs.unlinkSync(outputZip);
}

fs.mkdirSync(stagingDir, { recursive: true });

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copyDir(srcPath, destPath, filter);
    } else {
      if (filter && !filter(entry.name)) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('Copying files into staging...');
copyFile(path.join(rootDir, 'index.js'), path.join(stagingDir, 'index.js'));
copyFile(path.join(rootDir, 'package.json'), path.join(stagingDir, 'package.json'));
copyFile(path.join(rootDir, 'package-lock.json'), path.join(stagingDir, 'package-lock.json'));
copyDir(path.join(rootDir, 'shared'), path.join(stagingDir, 'shared'));

// Server (exclude .map and .d.ts files)
copyFile(path.join(rootDir, 'server', 'package.json'), path.join(stagingDir, 'server', 'package.json'));
copyDir(path.join(rootDir, 'server', 'dist'), path.join(stagingDir, 'server', 'dist'), (name) => !name.endsWith('.map') && !name.endsWith('.d.ts'));

// Client (exclude any .map if present)
copyFile(path.join(rootDir, 'client', 'package.json'), path.join(stagingDir, 'client', 'package.json'));
copyDir(path.join(rootDir, 'client', 'dist'), path.join(stagingDir, 'client', 'dist'), (name) => !name.endsWith('.map'));

// Desktop
copyFile(path.join(rootDir, 'desktop', 'package.json'), path.join(stagingDir, 'desktop', 'package.json'));

console.log('Compressing with tar into freellmapi-botkeep.zip...');
execSync(`tar -a -cf "${outputZip}" *`, { cwd: stagingDir, stdio: 'inherit' });

console.log('Cleaning staging directory...');
fs.rmSync(stagingDir, { recursive: true, force: true });

const stat = fs.statSync(outputZip);
console.log(`Successfully created freellmapi-botkeep.zip (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
