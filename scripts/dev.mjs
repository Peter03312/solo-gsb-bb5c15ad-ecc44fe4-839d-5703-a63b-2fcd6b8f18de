// 本地开发：并行启动后端(3000) 与 Vite(5173)，前端通过代理访问 /api
import { spawn } from 'node:child_process';

const procs = [
  ['server', 'npm', ['run', 'dev', '--prefix', 'server']],
  ['web', 'npm', ['run', 'dev', '--prefix', 'web']],
];

const children = procs.map(([name, cmd, args]) => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const tag = `[${name}]`;
  c.stdout.on('data', d => process.stdout.write(prefix(tag, d)));
  c.stderr.on('data', d => process.stderr.write(prefix(tag, d)));
  c.on('exit', code => {
    console.log(`${tag} exited (${code})`);
    process.exit(code ?? 0);
  });
  return c;
});

function prefix(tag, buf) {
  return buf
    .toString()
    .split(/\n(?=.)/)
    .map(l => `${tag} ${l}`)
    .join('\n')
    .replace(/\n?$/, '\n');
}

process.on('SIGINT', () => children.forEach(c => c.kill('SIGINT')));
