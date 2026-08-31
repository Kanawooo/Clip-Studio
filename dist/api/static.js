import { createReadStream, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "../security.js";
import { getMimeType } from "./media.js";
import { sendJson } from "./tasks.js";
const STATIC_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
};
export function serveStatic(distDir, req, res) {
    if (req.method !== "GET" && req.method !== "HEAD")
        return false;
    let root;
    try {
        root = realpathSync(distDir);
    }
    catch (error) {
        if (isMissing(error))
            return false;
        sendJson(res, 500, { error: errorMessage(error) });
        return true;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    }
    catch {
        sendJson(res, 400, { error: "invalid URL path" });
        return true;
    }
    const requested = pathname === "/" ? "/index.html" : pathname;
    const candidate = path.resolve(root, `.${requested}`);
    if (!isInside(root, candidate)) {
        sendJson(res, 403, { error: "forbidden" });
        return true;
    }
    const served = serveFile(root, candidate, req, res);
    if (served !== "missing")
        return true;
    if (path.extname(pathname) !== "") {
        sendJson(res, 404, { error: "static asset not found" });
        return true;
    }
    const indexPath = path.join(root, "index.html");
    return serveFile(root, indexPath, req, res) !== "missing";
}
function serveFile(root, filePath, req, res) {
    let realPath;
    let stat;
    try {
        realPath = realpathSync(filePath);
        if (!isInside(root, realPath)) {
            sendJson(res, 403, { error: "forbidden" });
            return "error";
        }
        stat = statSync(realPath);
    }
    catch (error) {
        if (isMissing(error))
            return "missing";
        sendJson(res, 500, { error: errorMessage(error) });
        return "error";
    }
    if (!stat.isFile())
        return "missing";
    const ext = path.extname(realPath).toLowerCase();
    res.writeHead(200, {
        "Content-Type": STATIC_MIME_TYPES[ext] ?? getMimeType(realPath),
        "Content-Length": stat.size,
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") {
        res.end();
    }
    else {
        createReadStream(realPath).pipe(res);
    }
    return "served";
}
function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
