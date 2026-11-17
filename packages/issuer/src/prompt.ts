// Prompts for the terminal. A secret shows one * per character typed, so you can see you're typing in the right
// window, and is never echoed or stored.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    // piped input (tests, scripts): read one line, print nothing back
    const rl = createInterface({ input: stdin });
    for await (const line of rl) {
      rl.close();
      return line.trim();
    }
    return '';
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          done();
          stdout.write('\n');
          return reject(new Error('cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          stdout.write('*');
        }
      }
    };
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
