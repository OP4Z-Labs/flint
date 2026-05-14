// Cross-platform clipboard copy. No native deps — shells out to whatever
// the host platform ships with. Failure is non-fatal: the calling command
// just falls back to printing the content so the user can copy it manually.
//
//   macOS:   pbcopy
//   Windows: clip.exe (also reachable from WSL)
//   Linux:   wl-copy (Wayland) → xclip → xsel, in that order
//
// WSL note: WSL2 has clip.exe on PATH but not pbcopy, so this falls through
// to the windows branch by sniffing for `WSL_DISTRO_NAME`.

import { spawnSync } from 'node:child_process';

function tryCopy(cmd: string, args: string[], input: string): boolean {
  try {
    const res = spawnSync(cmd, args, { input, encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Returns true on success, false if no available clipboard tool worked. */
export function copyToClipboard(text: string): boolean {
  const platform = process.platform;
  const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

  if (platform === 'darwin') {
    return tryCopy('pbcopy', [], text);
  }
  if (platform === 'win32' || isWsl) {
    if (tryCopy('clip.exe', [], text)) return true;
    if (tryCopy('clip', [], text)) return true;
  }
  // Linux (and WSL fall-through if clip.exe missing)
  if (tryCopy('wl-copy', [], text)) return true;
  if (tryCopy('xclip', ['-selection', 'clipboard'], text)) return true;
  if (tryCopy('xsel', ['--clipboard', '--input'], text)) return true;
  return false;
}
