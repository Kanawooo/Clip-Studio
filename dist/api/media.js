import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "../security.js";
import { sendJson } from "./tasks.js";
const MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
};
export function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] ?? "application/octet-stream";
}
export function handleStreamTaskOutput(manager, taskId, outputIndexStr, req, res) {
    const task = manager.getTask(taskId);
    if (!task) {
        sendJson(res, 404, { error: `task not found: ${taskId}` });
        return;
    }
    const index = parseInt(outputIndexStr, 10);
    if (isNaN(index) || index < 0 || index >= task.outputs.length) {
        sendJson(res, 404, {
            error: `output index out of bounds: index ${outputIndexStr}, task outputs count: ${task.outputs.length}`,
        });
        return;
    }
    const filePath = task.outputs[index].path;
    let stat;
    try {
        stat = statSync(filePath);
        if (!stat.isFile()) {
            sendJson(res, 404, { error: `output is not a file: ${filePath}` });
            return;
        }
    }
    catch (error) {
        if (isMissing(error)) {
            sendJson(res, 404, { error: `output file not found on disk: ${filePath}` });
            return;
        }
        sendJson(res, 500, { error: errorMessage(error) });
        return;
    }
    const fileSize = stat.size;
    const mimeType = getMimeType(filePath);
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
            res.writeHead(416, {
                "Content-Range": `bytes */${fileSize}`,
                "Content-Type": "text/plain",
            });
            res.end("Requested range not satisfiable");
            return;
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": mimeType,
        });
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        pipeFile(filePath, res, { start, end });
    }
    else {
        res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type": mimeType,
            "Accept-Ranges": "bytes",
        });
        if (req.method === "HEAD") {
            res.end();
            return;
        }
        pipeFile(filePath, res);
    }
}
function pipeFile(filePath, res, range) {
    const stream = createReadStream(filePath, range);
    stream.once("error", (error) => res.destroy(error));
    stream.pipe(res);
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
