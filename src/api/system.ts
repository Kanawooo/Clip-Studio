import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { TaskManager } from "../tasks/manager.js";
import { errorMessage } from "../security.js";
import { HttpError, readJsonBody, sendJson } from "./tasks.js";

export async function handleReveal(
  manager: TaskManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "request body must be an object");
    }
    const raw = body as Record<string, unknown>;
    if (typeof raw.taskId !== "string" || !raw.taskId.trim()) {
      throw new HttpError(400, "taskId is required");
    }
    const task = manager.getTask(raw.taskId);
    if (!task) throw new HttpError(404, `task not found: ${raw.taskId}`);

    let targetPath = task.input.outputDir;
    if (raw.outputIndex !== undefined) {
      if (!Number.isInteger(raw.outputIndex)) {
        throw new HttpError(400, "outputIndex must be an integer");
      }
      const outputIndex = raw.outputIndex as number;
      if (outputIndex < 0 || outputIndex >= task.outputs.length) {
        throw new HttpError(404, `output index out of bounds: ${outputIndex}`);
      }
      targetPath = task.outputs[outputIndex].path;
    }

    statSync(targetPath);
    await revealInExplorer(targetPath);
    sendJson(res, 200, { status: "ok", foregrounded: true });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: errorMessage(error) });
  }
}

async function revealInExplorer(targetPath: string): Promise<void> {
  const normalized = path.normalize(targetPath);
  const isFile = statSync(normalized).isFile();
  const script = buildRevealScript(normalized, isFile);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("资源管理器没有及时显示，请稍后重试"));
    }, 12_000);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.includes("REVEALED")) resolve();
      else reject(new Error(stderr.trim() || "未能将资源管理器显示到前方"));
    });
  });
}

export function buildRevealScript(targetPath: string, isFile: boolean): string {
  const folder = isFile ? path.dirname(targetPath) : targetPath;
  const fileName = isFile ? path.basename(targetPath) : "";
  return `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiVideoWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  public static bool Activate(IntPtr hWnd) {
    var foreground = GetForegroundWindow();
    var currentThread = GetCurrentThreadId();
    var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
    var attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    try {
      ShowWindowAsync(hWnd, 9);
      BringWindowToTop(hWnd);
      return SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
'@
$folder = '${quotePowerShell(folder)}'
$fileName = '${quotePowerShell(fileName)}'
$shell = New-Object -ComObject Shell.Application
$shell.Open($folder)
$deadline = [DateTime]::UtcNow.AddSeconds(8)
$window = $null
do {
  Start-Sleep -Milliseconds 150
  $window = @($shell.Windows()) | Where-Object {
    try { [IO.Path]::GetFullPath($_.Document.Folder.Self.Path).TrimEnd('\\') -ieq [IO.Path]::GetFullPath($folder).TrimEnd('\\') } catch { $false }
  } | Select-Object -First 1
} while (-not $window -and [DateTime]::UtcNow -lt $deadline)
if (-not $window) { throw 'Explorer window was not found' }
if (${isFile ? "$true" : "$false"}) {
  $item = $window.Document.Folder.ParseName($fileName)
  if (-not $item) { throw 'Output file was not found in Explorer' }
  $window.Document.SelectItem($item, 29)
}
$handle = [IntPtr]::new([Int64]$window.HWND)
if (-not [PiVideoWindow]::Activate($handle)) { throw 'Explorer could not be brought to the foreground' }
Write-Output 'REVEALED'
`.trim();
}

export async function handleDialogPick(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const raw = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    if (raw.type !== "file" && raw.type !== "directory") {
      throw new HttpError(400, 'type must be "file" or "directory"');
    }
    const type = raw.type;
    const title = typeof raw.title === "string"
      ? raw.title
      : type === "directory" ? "选择目录" : "选择文件";
    const filter = typeof raw.filter === "string"
      ? raw.filter
      : "Video Files|*.mp4;*.mov;*.webm;*.mkv|All Files|*.*";
    const initialPath = resolvePickerInitialPath(type, raw.initialPath);

    const command = type === "directory"
      ? buildDirectoryPickerScript(title, initialPath)
      : buildFilePickerScript(title, filter, initialPath);
    const result = await runPowerShellPicker(req, command);
    if (!result) {
      sendJson(res, 200, { path: null, cancelled: true });
      return;
    }
    const selected = statSync(result);
    if ((type === "file" && !selected.isFile()) || (type === "directory" && !selected.isDirectory())) {
      throw new Error(type === "file" ? "系统选择窗口没有返回文件" : "系统选择窗口没有返回目录");
    }
    sendJson(res, 200, { path: result, cancelled: false });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: errorMessage(error) });
  }
}

function runPowerShellPicker(req: IncomingMessage, command: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      pickerPowerShellArgs(command),
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: pickerEnvironment() },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = parsePickerOutput(stdout);
      if (result.type === "picked") resolve(result.path);
      else if (result.type === "cancelled") resolve(null);
      else if (result.type === "error") reject(new Error(`无法打开系统选择窗口：${result.message}`));
      else reject(new Error(code === 0 ? "系统选择窗口没有返回结果" : "系统选择窗口启动失败"));
    });
    req.once("aborted", () => child.kill());
  });
}

export function buildDirectoryPickerScript(title: string, initialPath?: string): string {
  return buildWindowsPickerScript("directory", title, "", initialPath);
}

export function buildFilePickerScript(title: string, filter: string, initialPath?: string): string {
  return buildWindowsPickerScript("file", title, filter, initialPath);
}

export function pickerPowerShellArgs(command: string): string[] {
  return ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

export type PickerOutput =
  | { type: "picked"; path: string }
  | { type: "cancelled" }
  | { type: "error"; message: string }
  | { type: "invalid" };

export function parsePickerOutput(output: string): PickerOutput {
  const line = output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1) ?? "";
  if (line === "CANCELLED") return { type: "cancelled" };
  if (line.startsWith("PICKED:")) {
    const pathValue = decodePickerValue(line.slice("PICKED:".length));
    return pathValue ? { type: "picked", path: pathValue } : { type: "invalid" };
  }
  if (line.startsWith("PICKER_ERROR:")) {
    const message = decodePickerValue(line.slice("PICKER_ERROR:".length));
    return message ? { type: "error", message: compactPickerError(message) } : { type: "invalid" };
  }
  return { type: "invalid" };
}

function buildWindowsPickerScript(
  type: "file" | "directory",
  title: string,
  filter: string,
  initialPath?: string,
): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  Add-Type -TypeDefinition @'
${WINDOWS_PICKER_INTEROP_SOURCE}
'@
  $title = ${powerShellUtf8Value(title)}
  $filter = ${powerShellUtf8Value(filter)}
  $initialPath = ${initialPath ? powerShellUtf8Value(initialPath) : "$null"}
  $result = [ClipStudio.NativePathPicker]::Pick('${type}', $title, $filter, $initialPath)
  if ($null -eq $result) {
    Write-Output 'CANCELLED'
  } else {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result))
    Write-Output "PICKED:$encoded"
  }
} catch {
  $message = $_.Exception.GetBaseException().Message
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message))
  Write-Output "PICKER_ERROR:$encoded"
  exit 41
}
`.trim();
}

export function resolvePickerInitialPath(type: "file" | "directory", value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > 32_767) return undefined;
  try {
    const candidate = path.resolve(value.trim());
    const info = statSync(candidate);
    if (info.isDirectory()) return candidate;
    if (type === "file" && info.isFile()) return path.dirname(candidate);
  } catch {
    // Invalid initial locations are ignored; Windows will use its recent location.
  }
  return undefined;
}

function pickerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const userProfile = process.env.USERPROFILE?.trim();
  if (userProfile) {
    environment.USERPROFILE = userProfile;
    environment.HOME = userProfile;
  }
  return environment;
}

function powerShellUtf8Value(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

function decodePickerValue(value: string): string | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    return null;
  }
}

function compactPickerError(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function quotePowerShell(value: string): string {
  return value.replace(/'/g, "''");
}

export const WINDOWS_PICKER_INTEROP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace ClipStudio {
  [Flags]
  internal enum FileOpenOptions : uint {
    PickFolders = 0x00000020,
    ForceFileSystem = 0x00000040,
    NoChangeDirectory = 0x00000008,
    PathMustExist = 0x00000800,
    FileMustExist = 0x00001000
  }

  internal enum ShellDisplayName : uint {
    FileSystemPath = 0x80058000
  }

  internal enum FileDialogAddPlace {
    Bottom = 0,
    Top = 1
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  internal struct FilterSpec {
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Spec;
  }

  [ComImport]
  [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] FilterSpec[] filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(FileOpenOptions options);
    void GetOptions(out FileOpenOptions options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, FileDialogAddPlace location);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }

  [ComImport]
  [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid interfaceId, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(ShellDisplayName name, out IntPtr value);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem item, uint hint, out int order);
  }

  [ComImport]
  [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogCom {
  }

  public static class NativePathPicker {
    private const int Cancelled = unchecked((int)0x800704C7);
    private static readonly Guid ShellItemId = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
      [MarshalAs(UnmanagedType.LPWStr)] string path,
      IntPtr bindingContext,
      ref Guid interfaceId,
      [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Pick(string mode, string title, string filter, string initialPath) {
      IFileDialog dialog = null;
      IShellItem initialFolder = null;
      IShellItem result = null;
      try {
        dialog = (IFileDialog)new FileOpenDialogCom();
        FileOpenOptions options;
        dialog.GetOptions(out options);
        options |= FileOpenOptions.ForceFileSystem | FileOpenOptions.NoChangeDirectory | FileOpenOptions.PathMustExist;
        if (String.Equals(mode, "directory", StringComparison.Ordinal)) {
          options |= FileOpenOptions.PickFolders;
        } else {
          options |= FileOpenOptions.FileMustExist;
          FilterSpec[] filters = ParseFilters(filter);
          if (filters.Length > 0) {
            dialog.SetFileTypes((uint)filters.Length, filters);
            dialog.SetFileTypeIndex(1);
          }
        }
        dialog.SetOptions(options);
        dialog.SetTitle(title);

        if (!String.IsNullOrWhiteSpace(initialPath)) {
          Guid shellItemId = ShellItemId;
          int initialResult = SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemId, out initialFolder);
          if (initialResult >= 0 && initialFolder != null) dialog.SetFolder(initialFolder);
        }

        int showResult = dialog.Show(GetForegroundWindow());
        if (showResult == Cancelled) return null;
        Marshal.ThrowExceptionForHR(showResult);
        dialog.GetResult(out result);

        IntPtr displayName;
        result.GetDisplayName(ShellDisplayName.FileSystemPath, out displayName);
        if (displayName == IntPtr.Zero) throw new InvalidOperationException("Windows did not return a file-system path.");
        try {
          return Marshal.PtrToStringUni(displayName);
        } finally {
          Marshal.FreeCoTaskMem(displayName);
        }
      } finally {
        Release(result);
        Release(initialFolder);
        Release(dialog);
      }
    }

    private static FilterSpec[] ParseFilters(string value) {
      if (String.IsNullOrWhiteSpace(value)) return new FilterSpec[0];
      string[] parts = value.Split('|');
      List<FilterSpec> filters = new List<FilterSpec>();
      for (int index = 0; index + 1 < parts.Length; index += 2) {
        if (parts[index].Length == 0 || parts[index + 1].Length == 0) continue;
        FilterSpec filter = new FilterSpec();
        filter.Name = parts[index];
        filter.Spec = parts[index + 1];
        filters.Add(filter);
      }
      return filters.ToArray();
    }

    private static void Release(object value) {
      if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
  }
}
`;
