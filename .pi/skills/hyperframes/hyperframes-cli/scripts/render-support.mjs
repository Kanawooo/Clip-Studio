// Technical rendering policy only. No creative decisions, decoding or model calls.
const MiB = 1024 * 1024;
export function publicError(value, limit = 2000, preserveLines = false) {
  return String(value)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "***")
    .replace(/\b(Bearer\s+)[^\s,;"']+/gi, "$1***")
    .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&#\s]+/gi, "$1***")
    .replace(/((?:["']?(?:api[_-]?key|authorization|x-api-key|access_token|refresh_token|token)["']?)\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,;"'}]+/gi, "$1***")
    .replace(preserveLines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, " ").slice(0, limit);
}

/** Used by the pinned renderer patch; parallel work drains even on rejection. */
export async function renderMap(items, operation) {
  const configured = Number(process.env.CLIP_RENDER_EXTRACT_WORKERS);
  const limit = Number.isInteger(configured) && configured > 0 ? configured : 1;
  const results = new Array(items.length);
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try { results[index] = await operation(items[index], index); }
      catch (error) {
        const item = items[index];
        const source = item?.videoPath ?? item?.src ?? item?.video?.src ?? item?.work?.videoPath ?? item?.work?.video?.src;
        if (typeof source === "string") emitSourceFailures({ errors: [{ stage: "probe", source,
          videoId: item?.video?.id ?? item?.id ?? index, kind: error.kind ?? "probe_failed",
          retryable: error.retryable === true, error: error.diagnostic ?? error.message ?? String(error) }] });
        failure ??= error;
      }
    }
  }));
  if (failure) throw failure;
  return results;
}

export function extractionThreadArgs() {
  const threads = Number(process.env.CLIP_RENDER_EXTRACT_THREADS);
  return Number.isInteger(threads) && threads > 0
    ? ["-threads", String(threads), "-filter_threads", String(threads), "-filter_complex_threads", String(threads)] : [];
}

export function emitSourceFailures(result, videos = []) {
  for (const error of result.errors ?? []) process.stderr.write(`[CLIP_RENDER_SOURCE] ${JSON.stringify({
    stage: error.stage === "probe" ? "probe" : "extract", videoId: publicError(error.videoId, 160), kind: publicError(error.kind ?? "internal", 80),
    source: publicError(error.source ?? videos.find((video) => video.id === error.videoId)?.src ?? error.videoId, 500),
    retryable: error.retryable === true, cause: publicError(error.error, 1600),
  })}\n`);
}

export function sourceDiagnostic(line) {
  if (!line.startsWith("[CLIP_RENDER_SOURCE] ")) return undefined;
  try {
    const value = JSON.parse(line.slice("[CLIP_RENDER_SOURCE] ".length));
    if (typeof value.cause !== "string" || typeof value.kind !== "string") return undefined;
    return { stage: value.stage === "probe" ? "probe" : "extract", kind: publicError(value.kind, 80), source: publicError(value.source ?? value.videoId, 500),
      cause: publicError(value.cause, 1600), retryable: value.retryable === true };
  } catch { return undefined; }
}

export function classifyRenderFailure(text, sources = [], code) {
  const clean = publicError(text, 32_000, true);
  if (/heap out of memory|Committing semi space failed|Cannot allocate memory|bad_alloc|ENOMEM|out of memory/i.test(clean))
    return { stage: "render", kind: "resource", retryable: true, cause: clean.match(/[^\n]*?(?:FATAL ERROR|Allocation failed|Cannot allocate memory|ENOMEM)[^\n]*/i)?.[0]?.slice(0, 800) ?? "内存分配失败" };
  if (sources.length) return { stage: sources.some((item) => item.stage === "extract") ? "extract" : "probe", kind: "source", retryable: sources.every((item) => item.retryable),
    cause: sources.slice(0, 3).map((item) => `${item.source} (${item.kind})：${item.cause}`).join("；"), sources };
  if (/Runtime\.evaluate timed out|ProtocolError.*timed out|Target closed|Session closed|drawElement.*(?:self.verify|verification).*fail|browser.*(?:crash|disconnected)/i.test(clean))
    return { stage: "capture", kind: "browser", retryable: true,
      cause: clean.match(/(?:Runtime\.evaluate timed out|ProtocolError[^.]*timed out|Target closed|Session closed|browser[^.]*disconnected)/i)?.[0] ?? clean.slice(-800) };
  if (/(?:nvenc|qsv|vaapi|cuda|amf|hardware|encoder|device)[^\n]{0,160}(?:not available|not supported|cannot|failed|error)|(?:cannot|failed|error)[^\n]{0,120}(?:nvenc|qsv|cuda|hardware encoder)/i.test(clean))
    return { stage: "encode", kind: "hardware", retryable: true, cause: clean.slice(-1000) };
  const errorLine = clean.match(/(?:Render failed|Error:|error:|Unable to|Cannot |failed:)[^.]{0,900}/)?.[0];
  return { stage: "render", kind: "unknown", retryable: false,
    cause: errorLine || clean.slice(-1000) || `HyperFrames 退出码 ${code ?? "未知"}，未提供详细原因` };
}

/** Reservations include admitted children which have not spawned yet. freeBytes
 * already excludes measured RSS; subtract only the reserved, unobserved gap. */
export function admissionBudget({ active, logicalCpus, cpuBusy, freeBytes, totalBytes,
  committedFreeBytes, reservations = [], measured = new Map(), observedWorkerBytes = 0, estimatedWorkerBytes = 0, known = true }) {
  const headroom = Math.max(512 * MiB, totalBytes * 0.1);
  const cost = Math.max(768 * MiB, estimatedWorkerBytes, observedWorkerBytes * 1.3);
  const gap = reservations.reduce((sum, row) => sum + Math.max(0, row.bytes - (measured.get(row.id) ?? 0)), 0);
  const available = Math.min(freeBytes, committedFreeBytes ?? freeBytes) - headroom - gap;
  const cores = Math.max(1, logicalCpus);
  // Predictions limit additional parallel work, not whether a valid job may
  // render at all. Idle queues always start one; tight/unknown resources use
  // one extractor and one thread. Real failures retain the shared retry budget.
  const lowLoad = !known || available < cost || cpuBusy >= 0.85;
  const admit = active === 0 || (active < cores && !lowLoad);
  const extractWorkers = lowLoad ? 1 : Math.max(1, Math.min(cores, Math.floor(cost / (384 * MiB))));
  return { admit, cost, available, headroom, lowLoad, extractWorkers,
    extractThreads: lowLoad ? 1 : Math.max(1, Math.floor(cores / Math.max(1, active + 1) / extractWorkers)) };
}

export function rowFailureMessage(index, failure, log, attempts) {
  return publicError(`第 ${index + 1} 条 / ${failure.stage}：${failure.cause}；已执行 ${attempts} 次；日志：${log}`);
}
