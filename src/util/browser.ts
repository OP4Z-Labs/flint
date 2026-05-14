// Open a URL in the host browser. Like clipboard.ts, this avoids a `open`
// or `opn` dependency in favor of the OS's native handler. Failure is
// non-fatal — the calling command falls back to printing the URL.

import { spawn } from 'node:child_process';

export function openInBrowser(url: string): boolean {
  const platform = process.platform;
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // `start` is a cmd builtin; route through cmd.exe explicitly.
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (isWsl) {
    // WSL2: use the Windows host browser via cmd.exe.
    cmd = 'cmd.exe';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
