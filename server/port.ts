import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortHolder {
  pid: number;
  command: string;
}

export function isMcpMatrixCommand(command: string): boolean {
  const value = command.toLowerCase().replaceAll('\\', '/');
  return value.includes('mcp-matrix') || value.includes('dist-server/index');
}

export function parseLsofListenPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('p')) continue;
    const pid = Number(line.slice(1));
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function readProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-ww', '-o', 'args='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const command = stdout.trim();
    return command || undefined;
  } catch {
    return undefined;
  }
}

export async function findListenHolders(port: number): Promise<PortHolder[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p'],
      { encoding: 'utf8', timeout: 2_000 },
    );
    const holders: PortHolder[] = [];
    for (const pid of parseLsofListenPids(stdout)) {
      if (pid === process.pid) continue;
      const command = await readProcessCommand(pid);
      if (!command) continue;
      holders.push({ pid, command });
    }
    return holders;
  } catch {
    return [];
  }
}

export function findReplaceableMcpMatrix(holders: PortHolder[]): PortHolder | undefined {
  return holders.find((holder) => isMcpMatrixCommand(holder.command));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function terminateProcess(pid: number, timeoutMs = 2_000): Promise<void> {
  if (!(await processExists(pid))) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return;
    await sleep(100);
  }

  if (!(await processExists(pid))) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  await sleep(150);
}

export async function confirmReplaceRunningInstance(
  port: number,
  holder: PortHolder,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<boolean> {
  const prompt =
    `mcp-matrix: Port ${port} is already used by another mcp-matrix (pid ${holder.pid}).\n` +
    'Replace the running instance and continue? [Y/n] ';
  const readline = createInterface({ input: io.input, output: io.output, terminal: true });
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    readline.close();
  }
}

export function portInUseMessage(port: number, suggestedPort: number, holder?: PortHolder): string {
  if (holder && isMcpMatrixCommand(holder.command)) {
    return (
      `Port ${port} is already used by mcp-matrix (pid ${holder.pid}). ` +
      `Stop it first, or try: mcp-matrix --port ${suggestedPort}`
    );
  }
  return `Port ${port} is already in use. Try: mcp-matrix --port ${suggestedPort}`;
}

export async function maybeReplaceOccupiedPort(port: number): Promise<'replaced' | 'declined' | 'unavailable'> {
  const holders = await findListenHolders(port);
  const holder = findReplaceableMcpMatrix(holders);
  if (!holder) return 'unavailable';

  const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!canPrompt) return 'unavailable';

  const replace = await confirmReplaceRunningInstance(port, holder);
  if (!replace) return 'declined';

  process.stdout.write(`mcp-matrix: Stopping pid ${holder.pid}…\n`);
  await terminateProcess(holder.pid);
  return 'replaced';
}
