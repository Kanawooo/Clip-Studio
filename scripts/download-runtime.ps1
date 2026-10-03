$downloadSource = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace ClipStudio.Installer
{
    public sealed class DownloadResult
    {
        public long Bytes { get; set; }
        public double Seconds { get; set; }
        public int Connections { get; set; }
    }

    internal sealed class ProbeResult
    {
        public long TotalBytes { get; set; }
        public bool SupportsRanges { get; set; }
        public string EffectiveUri { get; set; }
    }

    internal sealed class TransferResult
    {
        public string TemporaryPath { get; set; }
        public long Bytes { get; set; }
        public double Seconds { get; set; }
        public int Connections { get; set; }
    }

    internal sealed class ProgressCounter
    {
        private long _bytes;

        public long Bytes
        {
            get { return Interlocked.Read(ref _bytes); }
        }

        public void Add(int count)
        {
            Interlocked.Add(ref _bytes, count);
        }
    }

    // One budget owns every request in a complete attempt, including segment retries.
    internal sealed class TransferBudget : IDisposable
    {
        private readonly object _gate = new object();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly int _totalSeconds;
        private readonly int _idleSeconds;
        private readonly Timer _watchdog;
        private long _lastProgress;
        private int _activeBodies;
        private string _failure;
        public readonly CancellationTokenSource Cancellation = new CancellationTokenSource();

        public TransferBudget(int totalSeconds, int idleSeconds)
        {
            _totalSeconds = totalSeconds;
            _idleSeconds = idleSeconds;
            _watchdog = new Timer(Check, null, 100, 100);
        }

        public string Failure { get { lock (_gate) { return _failure; } } }

        public void BeginBody()
        {
            lock (_gate)
            {
                if (_activeBodies++ == 0) _lastProgress = _clock.ElapsedMilliseconds;
            }
        }

        public void Progress()
        {
            lock (_gate) { _lastProgress = _clock.ElapsedMilliseconds; }
        }

        public void EndBody() { lock (_gate) { _activeBodies--; } }

        private void Check(object state)
        {
            bool cancel = false;
            lock (_gate)
            {
                if (_failure != null) return;
                if (_clock.Elapsed.TotalSeconds >= _totalSeconds)
                    _failure = "Complete transfer exceeded " + _totalSeconds + " seconds.";
                else if (_activeBodies > 0 && _clock.ElapsedMilliseconds - _lastProgress >= _idleSeconds * 1000L)
                    _failure = "Response body stalled: no new bytes for " + _idleSeconds + " seconds.";
                cancel = _failure != null;
            }
            if (cancel) Cancellation.Cancel();
        }

        public void Dispose()
        {
            // Wait for the timer callback before disposing its cancellation source.
            using (var stopped = new ManualResetEvent(false))
            {
                if (_watchdog.Dispose(stopped)) stopped.WaitOne();
            }
            Cancellation.Dispose();
        }
    }

    internal sealed class RangeNotSupportedException : Exception
    {
        public RangeNotSupportedException(string message) : base(message) { }
    }

    internal sealed class SegmentRange
    {
        public long Start { get; set; }
        public long End { get; set; }
    }

    internal sealed class SegmentFailure
    {
        private Exception _cause;
        public Exception Cause { get { return _cause; } }
        public void Record(Exception error) { Interlocked.CompareExchange(ref _cause, error, null); }
    }

    internal sealed class ConsoleProgress
    {
        private sealed class Sample
        {
            public DateTime At { get; set; }
            public long Bytes { get; set; }
        }

        private readonly string _label;
        private readonly bool _interactive;
        private readonly Queue<Sample> _samples = new Queue<Sample>();
        private DateTime _lastRenderedAt = DateTime.MinValue;
        private int _lastWidth;

        public ConsoleProgress(string label, bool forceProgress)
        {
            _label = label;
            _interactive = forceProgress || !Console.IsOutputRedirected;
        }

        public void Start()
        {
            if (_interactive)
            {
                WriteInline("[DOWNLOAD] " + _label + " | connecting...");
            }
            else
            {
                Console.WriteLine("[DOWNLOAD] " + _label);
            }
        }

        public void Update(long downloaded, long total, int connections, bool force)
        {
            if (!_interactive) return;
            DateTime now = DateTime.UtcNow;
            if (!force && _lastRenderedAt != DateTime.MinValue && (now - _lastRenderedAt).TotalMilliseconds < 250) return;
            _lastRenderedAt = now;

            _samples.Enqueue(new Sample { At = now, Bytes = downloaded });
            while (_samples.Count > 1 && (now - _samples.Peek().At).TotalSeconds > 2.0)
            {
                _samples.Dequeue();
            }

            double speed = 0;
            if (_samples.Count > 1)
            {
                Sample oldest = _samples.Peek();
                double seconds = (now - oldest.At).TotalSeconds;
                if (seconds > 0) speed = (downloaded - oldest.Bytes) / seconds;
            }

            string progress;
            if (total > 0)
            {
                int percent = (int)Math.Min(100, Math.Floor(downloaded * 100.0 / total));
                progress = percent.ToString(CultureInfo.InvariantCulture) + "% | " + FormatBytes(downloaded) + "/" + FormatBytes(total);
            }
            else
            {
                progress = FormatBytes(downloaded);
            }

            WriteInline("[DOWNLOAD] " + _label + " | " + progress + " | " + FormatSpeed(speed));
        }

        public void Complete(long bytes, double seconds, int connections)
        {
            double speed = seconds > 0 ? bytes / seconds : 0;
            WriteFinal("[OK] " + _label + " | " + FormatBytes(bytes) + " | " + FormatSpeed(speed));
        }

        public void Verify(bool sha256)
        {
            WriteFinal("[VERIFY] " + _label + " | " + (sha256 ? "checking SHA-256" : "checking file"));
        }

        public void Retry(int nextAttempt, string message)
        {
            WriteFinal("[RETRY] " + _label + " | attempt " + nextAttempt.ToString(CultureInfo.InvariantCulture) + " | " + SafeMessage(message));
        }

        public void Fail(string message)
        {
            WriteFinal("[ERROR] " + _label + " | " + SafeMessage(message));
        }

        private void WriteInline(string line)
        {
            string padded = line;
            if (_lastWidth > line.Length) padded += new string(' ', _lastWidth - line.Length);
            Console.Write("\r" + padded);
            _lastWidth = Math.Max(_lastWidth, line.Length);
        }

        private void WriteFinal(string line)
        {
            if (_interactive)
            {
                string padded = line;
                if (_lastWidth > line.Length) padded += new string(' ', _lastWidth - line.Length);
                Console.Write("\r" + padded + Environment.NewLine);
                _lastWidth = 0;
            }
            else
            {
                Console.WriteLine(line);
            }
        }

        private static string FormatBytes(long bytes)
        {
            string[] units = { "B", "KB", "MB", "GB" };
            double value = Math.Max(0, bytes);
            int unit = 0;
            while (value >= 1024 && unit < units.Length - 1)
            {
                value /= 1024;
                unit++;
            }
            string format = unit == 0 ? "0" : "0.0";
            return value.ToString(format, CultureInfo.InvariantCulture) + " " + units[unit];
        }

        private static string FormatSpeed(double bytesPerSecond)
        {
            return FormatBytes((long)Math.Max(0, bytesPerSecond)) + "/s";
        }

        private static string SafeMessage(string message)
        {
            if (String.IsNullOrWhiteSpace(message)) return "download failed";
            return RuntimeDownloader.SafeMessage(message);
        }
    }

    public static class RuntimeDownloader
    {
        private const int BufferSize = 128 * 1024;
        private const long MinimumSegmentSize = 512L * 1024;

        public static DownloadResult Download(
            string uri,
            string outputPath,
            string label,
            string expectedSha256,
            int requestedConnections,
            long segmentThresholdBytes,
            int timeoutSeconds,
            int headerTimeoutSeconds,
            int noProgressTimeoutSeconds,
            int attempts,
            bool forceProgress)
        {
            if (String.IsNullOrWhiteSpace(uri)) throw new ArgumentException("Download URI is required.", "uri");
            if (String.IsNullOrWhiteSpace(outputPath)) throw new ArgumentException("Output path is required.", "outputPath");
            if (String.IsNullOrWhiteSpace(label)) throw new ArgumentException("Download label is required.", "label");
            if (requestedConnections < 1 || requestedConnections > 32) throw new ArgumentOutOfRangeException("requestedConnections");
            if (attempts < 1 || attempts > 5) throw new ArgumentOutOfRangeException("attempts");
            if (timeoutSeconds < 1 || headerTimeoutSeconds < 1 || noProgressTimeoutSeconds < 1) throw new ArgumentOutOfRangeException("timeoutSeconds");
            if (!String.IsNullOrWhiteSpace(expectedSha256) && !Regex.IsMatch(expectedSha256, "^[0-9a-fA-F]{64}$")) throw new ArgumentException("Expected SHA-256 is invalid.");

            string fullOutputPath = Path.GetFullPath(outputPath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullOutputPath));
            var progress = new ConsoleProgress(label, forceProgress);
            Exception lastError = null;

            for (int attempt = 1; attempt <= attempts; attempt++)
            {
                string temporaryPath = fullOutputPath + ".download-" + Guid.NewGuid().ToString("N");
                progress.Start();
                try
                {
                    TransferResult transfer = DownloadAttempt(
                        uri,
                        temporaryPath,
                        progress,
                        requestedConnections,
                        segmentThresholdBytes,
                        timeoutSeconds,
                        headerTimeoutSeconds,
                        noProgressTimeoutSeconds);

                    progress.Verify(!String.IsNullOrWhiteSpace(expectedSha256));
                    if (!String.IsNullOrWhiteSpace(expectedSha256))
                    {
                        string actual = ComputeSha256(transfer.TemporaryPath);
                        if (!String.Equals(actual, expectedSha256.Trim().ToLowerInvariant(), StringComparison.Ordinal))
                        {
                            throw new InvalidDataException("SHA-256 verification failed.");
                        }
                    }

                    if (File.Exists(fullOutputPath)) File.Replace(transfer.TemporaryPath, fullOutputPath, null);
                    else File.Move(transfer.TemporaryPath, fullOutputPath);
                    progress.Complete(transfer.Bytes, transfer.Seconds, transfer.Connections);
                    return new DownloadResult
                    {
                        Bytes = transfer.Bytes,
                        Seconds = transfer.Seconds,
                        Connections = transfer.Connections
                    };
                }
                catch (Exception error)
                {
                    lastError = Unwrap(error);
                    if (attempt < attempts)
                    {
                        progress.Retry(attempt + 1, lastError.Message);
                        Thread.Sleep(1000);
                    }
                }
                finally
                {
                    // Never enumerate another attempt's temporary files.
                    TryDelete(temporaryPath);
                }
            }

            progress.Fail(lastError == null ? "download failed" : lastError.Message);
            throw new InvalidOperationException("Download failed for " + SafeMessage(label) + ": " + SafeMessage(ErrorText(lastError)));
        }

        private static TransferResult DownloadAttempt(
            string uri,
            string temporaryPath,
            ConsoleProgress progress,
            int requestedConnections,
            long segmentThresholdBytes,
            int timeoutSeconds,
            int headerTimeoutSeconds,
            int noProgressTimeoutSeconds)
        {
            var stopwatch = new Stopwatch();

            using (var handler = CreateHandler(requestedConnections))
            using (var client = new HttpClient(handler))
            using (var budget = new TransferBudget(timeoutSeconds, noProgressTimeoutSeconds))
            {
                client.Timeout = Timeout.InfiniteTimeSpan;
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Clip-Studio-Installer/1.0");
                try
                {
                ProbeResult probe = Probe(client, uri, budget, headerTimeoutSeconds);
                string downloadUri = String.IsNullOrWhiteSpace(probe.EffectiveUri) ? uri : probe.EffectiveUri;

                int connections = 1;
                if (probe.SupportsRanges && probe.TotalBytes >= segmentThresholdBytes && requestedConnections > 1)
                {
                    int availableChunks = (int)((probe.TotalBytes + MinimumSegmentSize - 1) / MinimumSegmentSize);
                    connections = Math.Min(requestedConnections, Math.Max(1, availableChunks));
                }

                if (connections > 1)
                {
                    stopwatch.Start();
                    try
                    {
                        using (var segmentCancellation = CancellationTokenSource.CreateLinkedTokenSource(budget.Cancellation.Token))
                        {
                            DownloadSegmented(client, downloadUri, temporaryPath, probe.TotalBytes, connections, progress, segmentCancellation, budget, headerTimeoutSeconds);
                        }
                    }
                    catch (RangeNotSupportedException)
                    {
                        TryDelete(temporaryPath);
                        connections = 1;
                        stopwatch.Restart();
                        DownloadSingle(client, downloadUri, temporaryPath, probe.TotalBytes, progress, budget, headerTimeoutSeconds);
                    }
                }
                else
                {
                    stopwatch.Start();
                    DownloadSingle(client, downloadUri, temporaryPath, probe.TotalBytes, progress, budget, headerTimeoutSeconds);
                }

                stopwatch.Stop();
                long bytes = new FileInfo(temporaryPath).Length;
                if (probe.TotalBytes > 0 && bytes != probe.TotalBytes)
                {
                    throw new InvalidDataException("Downloaded size does not match the server response.");
                }
                progress.Update(bytes, probe.TotalBytes, connections, true);
                return new TransferResult
                {
                    TemporaryPath = temporaryPath,
                    Bytes = bytes,
                    Seconds = Math.Max(0.001, stopwatch.Elapsed.TotalSeconds),
                    Connections = connections
                };
                }
                catch (Exception)
                {
                    if (budget.Failure != null) throw new TimeoutException(budget.Failure);
                    throw;
                }
            }
        }

        private static HttpClientHandler CreateHandler(int connections)
        {
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                AutomaticDecompression = DecompressionMethods.None,
                UseCookies = false,
                UseProxy = true,
                DefaultProxyCredentials = CredentialCache.DefaultCredentials
            };
            var property = handler.GetType().GetProperty("MaxConnectionsPerServer");
            if (property != null && property.CanWrite) property.SetValue(handler, connections, null);
            return handler;
        }

        private static ProbeResult Probe(HttpClient client, string uri, TransferBudget budget, int headerTimeoutSeconds)
        {
            using (var request = CreateRequest(uri))
            {
                request.Headers.Range = new RangeHeaderValue(0, 0);
                using (HttpResponseMessage response = SendHeaders(client, request, budget.Cancellation.Token, headerTimeoutSeconds, "Range probe").GetAwaiter().GetResult())
                {
                    if (response.StatusCode == HttpStatusCode.PartialContent)
                    {
                        ContentRangeHeaderValue range = response.Content.Headers.ContentRange;
                        if (range != null && range.From == 0 && range.To == 0 && range.Length.HasValue && range.Length.Value > 0)
                        {
                            return new ProbeResult
                            {
                                TotalBytes = range.Length.Value,
                                SupportsRanges = true,
                                EffectiveUri = response.RequestMessage.RequestUri.AbsoluteUri
                            };
                        }
                    }

                    response.EnsureSuccessStatusCode();
                    return new ProbeResult
                    {
                        // A malformed 206 describes only a partial body. The full
                        // single-stream response must supply its own size authority.
                        TotalBytes = response.StatusCode == HttpStatusCode.PartialContent ? -1 : response.Content.Headers.ContentLength ?? -1,
                        SupportsRanges = false,
                        EffectiveUri = response.RequestMessage.RequestUri.AbsoluteUri
                    };
                }
            }
        }

        private static void DownloadSingle(
            HttpClient client,
            string uri,
            string temporaryPath,
            long probedTotal,
            ConsoleProgress progress,
            TransferBudget budget,
            int headerTimeoutSeconds)
        {
            CancellationToken token = budget.Cancellation.Token;
            using (var request = CreateRequest(uri))
            using (HttpResponseMessage response = SendHeaders(client, request, token, headerTimeoutSeconds, "File request").GetAwaiter().GetResult())
            {
                response.EnsureSuccessStatusCode();
                long total = response.Content.Headers.ContentLength ?? probedTotal;
                long downloaded = 0;
                budget.BeginBody();
                try
                {
                // .NET Framework streams may ignore read cancellation; disposing the response
                // closes the underlying request and releases a pending read on PowerShell 5.1.
                using (token.Register(response.Dispose))
                using (Stream input = response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
                using (var output = new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.None, BufferSize, FileOptions.SequentialScan))
                {
                    var buffer = new byte[BufferSize];
                    while (true)
                    {
                        int read = input.ReadAsync(buffer, 0, buffer.Length, token).GetAwaiter().GetResult();
                        if (read == 0) break;
                        token.ThrowIfCancellationRequested();
                        budget.Progress();
                        if (total > 0 && downloaded + read > total) throw new InvalidDataException("Response body exceeded the expected file size.");
                        output.Write(buffer, 0, read);
                        downloaded += read;
                        progress.Update(downloaded, total, 1, false);
                    }
                    output.Flush(true);
                }
                if (total > 0 && downloaded != total) throw new InvalidDataException("The server closed the download before all bytes were received.");
                }
                finally { budget.EndBody(); }
            }
        }

        private static void DownloadSegmented(
            HttpClient client,
            string uri,
            string temporaryPath,
            long total,
            int connections,
            ConsoleProgress progress,
            CancellationTokenSource cancellation,
            TransferBudget budget,
            int headerTimeoutSeconds)
        {
            var counter = new ProgressCounter();
            int targetChunks = connections * 8;
            long chunkSize = (total + targetChunks - 1) / targetChunks;
            chunkSize = Math.Max(MinimumSegmentSize, Math.Min(1024 * 1024, chunkSize));
            int chunkCount = (int)((total + chunkSize - 1) / chunkSize);
            var pending = new ConcurrentQueue<SegmentRange>();

            for (int index = 0; index < chunkCount; index++)
            {
                long start = index * chunkSize;
                long end = Math.Min(total - 1, ((index + 1) * chunkSize) - 1);
                pending.Enqueue(new SegmentRange { Start = start, End = end });
            }

            using (var output = new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite, BufferSize, FileOptions.RandomAccess))
            {
                output.SetLength(total);
            }

            int workerCount = Math.Min(connections, chunkCount);
            var tasks = new Task[workerCount];
            var failure = new SegmentFailure();
            for (int index = 0; index < workerCount; index++)
            {
                tasks[index] = DownloadSegmentWorker(client, uri, temporaryPath, total, pending, counter, cancellation, budget, headerTimeoutSeconds, failure);
            }

            Task all = Task.WhenAll(tasks);
            while (!all.IsCompleted)
            {
                progress.Update(counter.Bytes, total, connections, false);
                if (tasks.Any(task => task.IsFaulted)) cancellation.Cancel();
                Thread.Sleep(100);
            }

            try
            {
                all.GetAwaiter().GetResult();
                progress.Update(total, total, connections, true);
            }
            catch
            {
                // Cancellation of peers must not hide the original HTTP/range/IO failure.
                if (failure.Cause != null) throw failure.Cause;
                throw;
            }
            finally
            {
                if (!all.IsCompleted || all.IsFaulted || all.IsCanceled) cancellation.Cancel();
            }
        }

        private static async Task DownloadSegmentWorker(
            HttpClient client,
            string uri,
            string outputPath,
            long total,
            ConcurrentQueue<SegmentRange> pending,
            ProgressCounter counter,
            CancellationTokenSource cancellation,
            TransferBudget budget,
            int headerTimeoutSeconds,
            SegmentFailure failure)
        {
            CancellationToken token = cancellation.Token;
            try
            {
            SegmentRange range;
            while (pending.TryDequeue(out range))
            {
                token.ThrowIfCancellationRequested();
                await DownloadSegmentWithRetry(client, uri, outputPath, range.Start, range.End, total, counter, token, budget, headerTimeoutSeconds).ConfigureAwait(false);
            }
            }
            catch (Exception error)
            {
                if (!token.IsCancellationRequested) failure.Record(error);
                cancellation.Cancel();
                throw;
            }
        }

        private static async Task DownloadSegmentWithRetry(
            HttpClient client,
            string uri,
            string outputPath,
            long start,
            long end,
            long total,
            ProgressCounter counter,
            CancellationToken token,
            TransferBudget budget,
            int headerTimeoutSeconds)
        {
            Exception lastError = null;
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    token.ThrowIfCancellationRequested();
                    await DownloadSegment(client, uri, outputPath, start, end, total, counter, token, budget, headerTimeoutSeconds).ConfigureAwait(false);
                    return;
                }
                catch (RangeNotSupportedException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    token.ThrowIfCancellationRequested();
                    lastError = error;
                }
                if (attempt < 3) await Task.Delay(attempt * 250, token).ConfigureAwait(false);
            }
            throw new InvalidDataException("A download segment failed after three attempts: " + ErrorText(lastError), lastError);
        }

        private static async Task DownloadSegment(
            HttpClient client,
            string uri,
            string outputPath,
            long start,
            long end,
            long total,
            ProgressCounter counter,
            CancellationToken token,
            TransferBudget budget,
            int headerTimeoutSeconds)
        {
            using (var request = CreateRequest(uri))
            {
                request.Headers.Range = new RangeHeaderValue(start, end);
                using (HttpResponseMessage response = await SendHeaders(client, request, token, headerTimeoutSeconds, "Segment request").ConfigureAwait(false))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.StatusCode != HttpStatusCode.PartialContent)
                    {
                        throw new RangeNotSupportedException("The server did not honor the requested byte range.");
                    }
                    ContentRangeHeaderValue range = response.Content.Headers.ContentRange;
                    if (range == null || range.From != start || range.To != end || !range.Length.HasValue || range.Length.Value != total)
                    {
                        throw new RangeNotSupportedException("The server returned an invalid byte range.");
                    }

                    long expected = end - start + 1;
                    long written = 0;
                    budget.BeginBody();
                    try
                    {
                    using (token.Register(response.Dispose))
                    using (Stream input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var output = new FileStream(outputPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, BufferSize, true))
                    {
                        output.Seek(start, SeekOrigin.Begin);
                        var buffer = new byte[BufferSize];
                        while (true)
                        {
                            int read = await input.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
                            if (read == 0) break;
                            token.ThrowIfCancellationRequested();
                            budget.Progress();
                            counter.Add(read);
                            if (written + read > expected) throw new InvalidDataException("Response body exceeded the requested byte range.");
                            await output.WriteAsync(buffer, 0, read, token).ConfigureAwait(false);
                            written += read;
                        }
                    }
                    if (written != expected) throw new InvalidDataException("A download segment ended before all bytes were received.");
                    }
                    finally { budget.EndBody(); }
                }
            }
        }

        private static async Task<HttpResponseMessage> SendHeaders(HttpClient client, HttpRequestMessage request, CancellationToken token, int seconds, string stage)
        {
            using (var headerBudget = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                headerBudget.CancelAfter(TimeSpan.FromSeconds(seconds));
                try
                {
                    return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headerBudget.Token).ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    if (!token.IsCancellationRequested && headerBudget.IsCancellationRequested)
                        throw new TimeoutException(stage + " connection/response headers exceeded " + seconds + " seconds.");
                    if (token.IsCancellationRequested) token.ThrowIfCancellationRequested();
                    throw new HttpRequestException(stage + " failed: " + ErrorText(error), error);
                }
            }
        }

        public static string SafeMessage(string message)
        {
            if (String.IsNullOrWhiteSpace(message)) return "download failed";
            string safe = Regex.Replace(message, @"https?://[^\s<>\""']+", delegate(Match match) {
                Uri parsed;
                if (!Uri.TryCreate(match.Value, UriKind.Absolute, out parsed)) return "[redacted URL]";
                return parsed.GetLeftPart(UriPartial.Authority).Replace(parsed.UserInfo + "@", "") + parsed.AbsolutePath;
            }, RegexOptions.IgnoreCase);
            safe = Regex.Replace(safe, @"(?i)\b(?:Bearer\s+\S+|(?:token|password|api[_-]?key|authorization)\s*[:=]\s*\S+)", "[redacted]");
            safe = Regex.Replace(safe, @"[\x00-\x1f\x7f]", " ").Trim();
            return safe.Length <= 600 ? safe : safe.Substring(0, 600) + "...";
        }

        private static string ErrorText(Exception error)
        {
            if (error == null) return "unknown error";
            string message = error.Message;
            if (error.InnerException != null && message.IndexOf(error.InnerException.Message, StringComparison.Ordinal) < 0)
                message += " " + ErrorText(error.InnerException);
            return SafeMessage(message);
        }

        private static HttpRequestMessage CreateRequest(string uri)
        {
            var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");
            return request;
        }

        private static string ComputeSha256(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var algorithm = SHA256.Create())
            {
                return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            }
        }

        private static Exception Unwrap(Exception error)
        {
            var aggregate = error as AggregateException;
            if (aggregate != null)
            {
                AggregateException flat = aggregate.Flatten();
                if (flat.InnerExceptions.Count > 0) return Unwrap(flat.InnerExceptions[0]);
            }
            return error.InnerException != null && (error is System.Reflection.TargetInvocationException) ? Unwrap(error.InnerException) : error;
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch
            {
                // The transaction staging directory is removed by the installer.
            }
        }
    }
}
'@

if (-not ("ClipStudio.Installer.RuntimeDownloader" -as [type])) {
  if ($PSVersionTable.PSEdition -eq "Desktop") {
    Add-Type -TypeDefinition $downloadSource -Language CSharp -ReferencedAssemblies "System.Net.Http.dll"
  } else {
    Add-Type -TypeDefinition $downloadSource -Language CSharp
  }
}

function Invoke-ProjectDownload {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$ExpectedSha256 = "",
    [int]$Connections = 16,
    [long]$SegmentThresholdBytes = 4MB,
    [int]$TimeoutSec = 900,
    [int]$HeaderTimeoutSec = 20,
    [int]$NoProgressTimeoutSec = 45,
    [int]$Attempts = 2,
    [string]$AllowedRoot = "",
    [switch]$ForceProgress
  )

  $fullOutput = [IO.Path]::GetFullPath($OutFile)
  if (-not [string]::IsNullOrWhiteSpace($AllowedRoot)) {
    $fullRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\') + '\'
    if (-not $fullOutput.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Download output is outside the allowed project directory: $fullOutput"
    }
  }

  return [ClipStudio.Installer.RuntimeDownloader]::Download(
    $Uri,
    $fullOutput,
    $Label,
    $ExpectedSha256,
    $Connections,
    $SegmentThresholdBytes,
    $TimeoutSec,
    $HeaderTimeoutSec,
    $NoProgressTimeoutSec,
    $Attempts,
    [bool]$ForceProgress
  )
}
