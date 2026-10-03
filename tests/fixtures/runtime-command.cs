using System;
using System.IO;
using System.Reflection;
using System.Threading;

// Test-only executable copied under each runtime filename. It simulates CLI
// identities/installation work in a disposable fixture; no model or build calls.
public static class RuntimeCommand
{
    public static int Main(string[] args)
    {
        string executable = Assembly.GetExecutingAssembly().Location;
        string name = Path.GetFileName(executable).ToLowerInvariant();
        string command = String.Join(" ", args);
        if (name == "portable-git.exe")
        {
            foreach (string argument in args)
                if (argument.StartsWith("-o", StringComparison.Ordinal))
                {
                    string root = argument.Substring(2).Trim('"');
                    Copy(executable, Path.Combine(root, "cmd", "git.exe"));
                    Copy(executable, Path.Combine(root, "bin", "bash.exe"));
                    return 0;
                }
        }
        if (name == "uv.exe" || name == "uvx.exe")
        {
            if (args.Length == 0 || args[0] == "--version") { Console.WriteLine("uv 0.12.5"); return 0; }
            if (args[0] == "python" && args[1] == "install")
            {
                string source = Environment.GetEnvironmentVariable("UV_PYTHON_INSTALL_MIRROR") ?? "";
                string log = Environment.GetEnvironmentVariable("CLIP_FIXTURE_UV_LOG");
                if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, source + "|" + Environment.GetEnvironmentVariable("UV_HTTP_CONNECT_TIMEOUT") + "|" + Environment.GetEnvironmentVariable("UV_HTTP_TIMEOUT") + "|" + Environment.GetEnvironmentVariable("UV_HTTP_RETRIES") + "|" + Environment.GetEnvironmentVariable("UV_DEFAULT_INDEX") + Environment.NewLine);
                if (Environment.GetEnvironmentVariable("CLIP_FIXTURE_UV_MODE") == "sleep") Thread.Sleep(10000);
                if (Environment.GetEnvironmentVariable("CLIP_FIXTURE_UV_MODE") == "all-fail" || (Environment.GetEnvironmentVariable("CLIP_FIXTURE_UV_MODE") == "mirror-fail" && source.Contains("accelerator")))
                {
                    Console.Error.WriteLine("HTTP 403 https://user:password@invalid.test/file?token=fixture-secret"); return 7;
                }
                Copy(executable, Path.Combine(Environment.GetEnvironmentVariable("UV_PYTHON_INSTALL_DIR"), "python.exe")); return 0;
            }
            if (args[0] == "python" && args[1] == "find") { Console.WriteLine(Path.Combine(Environment.GetEnvironmentVariable("UV_PYTHON_INSTALL_DIR"), "python.exe")); return 0; }
            if (args[0] == "venv") { Copy(executable, Path.Combine(args[args.Length - 1], "Scripts", "python.exe")); return 0; }
            if (args[0] == "pip") return 0;
        }
        if (name == "node.exe")
        {
            if (command == "--version") Console.WriteLine("v22.23.2");
            else if (command.Contains("process.arch")) Console.WriteLine("x64");
            else if (command.Contains("browser path"))
            {
                string browser = Environment.GetEnvironmentVariable("HYPERFRAMES_BROWSER_PATH");
                if (String.IsNullOrEmpty(browser)) browser = Path.Combine(Environment.GetEnvironmentVariable("HOME"), ".cache", "hyperframes", "chrome", "chrome-headless-shell", "win64-152.0.7928.2", "chrome-headless-shell-win64", "chrome-headless-shell.exe");
                Console.WriteLine(browser);
            }
            return 0;
        }
        if (name == "python.exe" || name == "python3.exe")
        {
            if (command == "--version") Console.WriteLine("Python 3.12.12");
            else if (command.Contains("platform.python_version")) Console.WriteLine("3.12.12");
            else if (command.Contains("sys._base_executable")) Console.WriteLine(Path.Combine(Environment.GetEnvironmentVariable("UV_PYTHON_INSTALL_DIR"), "python.exe"));
            return 0;
        }
        if (name == "ffmpeg.exe" || name == "ffprobe.exe") Console.WriteLine(command.Contains("-encoders") ? " libx264 aac" : "ffmpeg version fixture-latest");
        else if (name == "chrome-headless-shell.exe") Console.WriteLine("Chrome Headless Shell 152.0.7928.2");
        else if (name == "git.exe" || name == "bash.exe") Console.WriteLine("git version 2.55.0.windows.5");
        else Console.WriteLine("whisper fixture help");
        return 0;
    }

    private static void Copy(string source, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target));
        File.Copy(source, target, true);
    }
}
