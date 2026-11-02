/**
 * Delivering a ticket to a thermal printer on a USB cable (Teran, 2026-11-02:
 * an Xprinter XP-Q80B and no network cable).
 *
 * The same ESC/POS bytes as the TCP transport, by a different road:
 *
 * - WINDOWS — the printer is installed (Xprinter driver, or Windows' own
 *   "Generic / Text Only") and named, e.g. "XP-80C". The bytes go to the
 *   spooler as a RAW document, so the driver passes them through untouched:
 *   no rendering, the printer reads its own commands. Node has no spooler API,
 *   so a short PowerShell script calls `winspool.drv` (OpenPrinter /
 *   StartDocPrinter "RAW" / WritePrinter) — no native module to build.
 * - LINUX — a device path such as `/dev/usb/lp0`, written directly.
 *
 * ── What "printed" means here ────────────────────────────────────────────────
 * Weaker than TCP, and stated plainly: a resolve means the SPOOLER took the
 * whole ticket. A printer unplugged or out of paper does not refuse it —
 * Windows holds the job and prints it when the printer comes back. So the
 * queue's retries cover "no such printer" and a spooler error, not a printer
 * that is off; the Windows print queue is where a stuck ticket shows.
 *
 * One attempt, like the TCP transport: the queue owns retries.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildTicket } from './escpos'
import type { TicketTransport } from './transport'
import type { TicketPayload } from '@/types/tickets'

/**
 * Longer than TCP's five seconds: PowerShell starts and compiles the spooler
 * call on every ticket, about a second or two on a slow till.
 */
const PRINT_TIMEOUT_MS = 20_000

/**
 * The printer name and the ticket file arrive as ENVIRONMENT variables, never
 * spliced into the script — a printer name is configuration, and a quote in it
 * must not become PowerShell.
 */
const RAW_PRINT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CdRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In] DocInfo info);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  public static void Send(string name, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(name, out handle, IntPtr.Zero))
      throw new Exception("no Windows printer named '" + name + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      if (StartDocPrinter(handle, 1, new DocInfo { pDocName = "Carpe Diem ticket", pDataType = "RAW" }) == 0)
        throw new Exception("the spooler refused the ticket (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(handle);
        int written;
        if (!WritePrinter(handle, bytes, bytes.Length, out written) || written != bytes.Length)
          throw new Exception("wrote " + written + " of " + bytes.Length + " bytes (error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(handle);
      } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}
'@
[CdRawPrint]::Send($env:CDRMS_PRINTER, [IO.File]::ReadAllBytes($env:CDRMS_TICKET_FILE))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

async function deliverToWindowsPrinter(printer: string, bytes: Buffer): Promise<void> {
  const file = path.join(tmpdir(), `cdrms-ticket-${randomUUID()}.bin`)
  await writeFile(file, bytes)
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RAW_PRINT_SCRIPT],
        {
          env: { ...process.env, CDRMS_PRINTER: printer, CDRMS_TICKET_FILE: file },
          timeout: PRINT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          if (!error) return resolve()
          const reason = stderr.trim() || error.message
          reject(new Error(`USB printer '${printer}': ${reason}`))
        },
      )
    })
  } finally {
    await unlink(file).catch(() => {})
  }
}

/** The USB transport: a Windows printer name, or a Linux device path. */
export function usbTransport(printer: string): TicketTransport {
  const isDevicePath = printer.startsWith('/dev/')
  return {
    name: `usb:${printer}`,
    deliver: async (ticket: TicketPayload) => {
      const bytes = buildTicket(ticket)
      if (isDevicePath) {
        await writeFile(printer, bytes).catch((error: Error) => {
          throw new Error(`USB printer ${printer}: ${error.message}`)
        })
        return
      }
      await deliverToWindowsPrinter(printer, bytes)
    },
  }
}
