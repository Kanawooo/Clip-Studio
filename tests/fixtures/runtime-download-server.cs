using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClipStudio.InstallerTests
{
    // Loopback-only HTTP fixture. No URL ACL, external service, or user proxy changes.
    public sealed class DownloadServer : IDisposable
    {
        private readonly TcpListener _listener = new TcpListener(IPAddress.Loopback, 0);
        private readonly ConcurrentDictionary<string, int> _counts = new ConcurrentDictionary<string, int>();
        private readonly ConcurrentDictionary<int, TcpClient> _clients = new ConcurrentDictionary<int, TcpClient>();
        private readonly ConcurrentBag<Task> _tasks = new ConcurrentBag<Task>();
        private readonly ConcurrentDictionary<string, byte[]> _files = new ConcurrentDictionary<string, byte[]>();
        private readonly byte[] _payload = new byte[2 * 1024 * 1024 + 123];
        private readonly Task _accept;
        private volatile bool _stopped;
        private int _nextClient;
        public string BaseUri { get; private set; }
        public byte[] Payload { get { return _payload; } }

        public DownloadServer()
        {
            for (int i = 0; i < _payload.Length; i++) _payload[i] = (byte)(i % 251);
            _listener.Start();
            BaseUri = "http://127.0.0.1:" + ((IPEndPoint)_listener.LocalEndpoint).Port;
            _accept = Task.Run((Action)Accept);
        }

        public void AddFile(string path, byte[] contents) { _files[path] = contents; }
        public int Count(string path) { int count; return _counts.TryGetValue(path, out count) ? count : 0; }
        public int MaximumRangeCount(string path)
        {
            int maximum = 0;
            foreach (var pair in _counts)
                if (pair.Key.StartsWith(path + "|bytes=", StringComparison.Ordinal) && pair.Key != path + "|bytes=0-0") maximum = Math.Max(maximum, pair.Value);
            return maximum;
        }

        private void Accept()
        {
            while (!_stopped)
            {
                try
                {
                    TcpClient client = _listener.AcceptTcpClient();
                    int id = Interlocked.Increment(ref _nextClient);
                    _clients[id] = client;
                    _tasks.Add(Task.Run(delegate {
                        try { Serve(client); }
                        catch (IOException) { }
                        catch (SocketException) { }
                        catch (ObjectDisposedException) { }
                        finally { client.Close(); TcpClient ignored; _clients.TryRemove(id, out ignored); }
                    }));
                }
                catch (SocketException) { if (!_stopped) throw; }
            }
        }

        private void Pause(int milliseconds)
        {
            for (int elapsed = 0; elapsed < milliseconds && !_stopped; elapsed += 25) Thread.Sleep(25);
        }

        private void Serve(TcpClient client)
        {
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 5000;
            NetworkStream stream = client.GetStream();
            var request = new StringBuilder();
            while (request.Length < 32768)
            {
                int next = stream.ReadByte();
                if (next < 0) return;
                request.Append((char)next);
                if (request.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal)) break;
            }
            string[] lines = request.ToString().Split(new[] { "\r\n" }, StringSplitOptions.None);
            string path = lines[0].Split(' ')[1].Split('?')[0];
            string range = "";
            foreach (string line in lines)
                if (line.StartsWith("Range:", StringComparison.OrdinalIgnoreCase)) range = line.Substring(6).Trim();
            _counts.AddOrUpdate(path, 1, (key, value) => value + 1);
            int rangeAttempt = _counts.AddOrUpdate(path + "|" + range, 1, (key, value) => value + 1);
            bool probe = range == "bytes=0-0";
            if (path == "/header-stall" || (path == "/segment-header-stall" && !probe)) { Pause(10000); return; }
            if (path == "/redirect") { Header(stream, "302 Found", "Location: /range\r\nContent-Length: 0\r\n"); return; }
            if (path == "/404" || path == "/403") { Header(stream, path == "/404" ? "404 Not Found" : "403 Forbidden", "Content-Length: 0\r\n"); return; }
            if ((path == "/segment-error" || path == "/segment-retry") && !probe && range.Length > 0 && (path == "/segment-error" || rangeAttempt < 3))
            {
                Header(stream, "503 Service Unavailable", "Content-Length: 0\r\n"); return;
            }

            byte[] payload;
            if (!_files.TryGetValue(path, out payload)) payload = _payload;
            if (path == "/slow-single") payload = new byte[192 * 1024];
            if (probe && (path == "/invalid-probe-range" || path == "/missing-probe-range"))
            {
                string contentRange = path == "/invalid-probe-range" ? "Content-Range: bytes 1-1/" + payload.Length + "\r\n" : "";
                Header(stream, "206 Partial Content", "Content-Length: 1\r\n" + contentRange);
                stream.WriteByte(payload[0]); return;
            }
            bool ranges = path != "/no-range" && path != "/slow-single" && path != "/single-stall" && path != "/truncated";
            bool useRange = ranges && range.Length > 0;
            if ((path == "/range-missing" || path == "/invalid-range") && !probe) useRange = false;
            long start = 0, end = payload.Length - 1;
            if (useRange)
            {
                string[] parts = range.Substring(6).Split('-');
                start = Int64.Parse(parts[0]);
                end = Int64.Parse(parts[1]);
            }
            long length = end - start + 1;
            if (path == "/peer-error" && !probe && start > 0 && useRange)
            {
                Header(stream, "403 Forbidden", "Content-Length: 0\r\n"); return;
            }
            if (path == "/peer-range" && !probe && start > 0 && useRange)
            {
                Header(stream, "200 OK", "Content-Length: 0\r\n"); return;
            }
            string extra = "Content-Length: " + length + "\r\n";
            if (useRange) extra += "Content-Range: bytes " + start + "-" + end + "/" + payload.Length + "\r\n";
            if (path == "/invalid-range" && !probe && range.Length > 0)
            {
                Header(stream, "206 Partial Content", "Content-Length: 1\r\nContent-Range: bytes 1-1/" + payload.Length + "\r\n");
                stream.WriteByte(0); return;
            }
            Header(stream, useRange ? "206 Partial Content" : "200 OK", extra);
            bool bodyStall = (path == "/single-stall" && range.Length == 0) || (path == "/segment-stall" && !probe) || ((path == "/peer-error" || path == "/peer-range") && !probe && start == 0 && useRange);
            bool truncate = (path == "/truncated" && range.Length == 0) || (path == "/segment-truncated" && !probe);
            if (bodyStall || truncate)
            {
                stream.Write(payload, (int)start, (int)Math.Min(length, 1024));
                stream.Flush();
                if (bodyStall) Pause(10000);
                return;
            }
            int chunk = path == "/slow-single" ? 16384 : 32768;
            bool slow = path == "/slow-single" || path == "/slow-range";
            for (long offset = start; offset <= end && !_stopped; offset += chunk)
            {
                stream.Write(payload, (int)offset, (int)Math.Min(chunk, end - offset + 1));
                stream.Flush();
                if (slow && !probe) Pause(150);
            }
        }

        private static void Header(Stream stream, string status, string extra)
        {
            byte[] bytes = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\nConnection: close\r\n" + extra + "\r\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        public void Dispose()
        {
            _stopped = true;
            _listener.Stop();
            foreach (var pair in _clients) pair.Value.Close();
            _accept.Wait(5000);
            Task.WaitAll(_tasks.ToArray(), 5000);
        }
    }
}
