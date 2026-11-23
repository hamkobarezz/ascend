// Brings a running After Effects to the front when something is sent from Illustrator, Photoshop or
// Figma, so the Ascend panel there can build it right away. Does nothing if After Effects isn't open.

const cp = require('child_process');

const WIN = process.platform === 'win32';

// Windows refuses SetForegroundWindow from a background process, so this briefly attaches to the
// input of the window that is in front (the design app the user just clicked Send in), which is the
// standard, documented way to hand focus over.
const WIN_SCRIPT = `
$p = Get-Process AfterFX -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { exit 2 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AscendFocus {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  public static bool Bring(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = front != me && AttachThreadInput(me, front, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, front, false);
    return ok;
  }
}
"@
if ([AscendFocus]::Bring($p.MainWindowHandle)) { exit 0 } else { exit 1 }
`;

function run(cmd, args) {
  return new Promise((resolve) => {
    cp.execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') }));
  });
}

// Resolves to 'focused', 'not-running' or 'failed'.
async function focusAfterEffects() {
  if (WIN) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT]);
    return r.code === 0 ? 'focused' : r.code === 2 ? 'not-running' : 'failed';
  }
  if (process.platform === 'darwin') {
    // Find the running After Effects bundle (any version) and reopen it, which brings it to the front.
    const ps = await run('ps', ['-axo', 'comm=']);
    const line = ps.stdout.split('\n').find((l) => /\/Adobe After Effects[^/]*\.app\/Contents\/MacOS\//.test(l));
    if (!line) return 'not-running';
    const appPath = line.slice(0, line.indexOf('.app/') + 4);
    const r = await run('open', ['-a', appPath]);
    return r.code === 0 ? 'focused' : 'failed';
  }
  return 'failed';
}

module.exports = { focusAfterEffects };
