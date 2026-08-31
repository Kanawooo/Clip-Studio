import path from "node:path";
import { DefaultResourceLoader, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { createTaskAccessPolicy } from "./access-policy.js";
export function getProjectSkillRoots(projectRoot) {
    return {
        clipSkills: path.resolve(projectRoot, ".pi", "skills", "clip-skills"),
        hyperframes: path.resolve(projectRoot, ".pi", "skills", "hyperframes"),
    };
}
export function isProjectSkillPath(filePath, roots) {
    return isUnderPath(filePath, roots.clipSkills) || isUnderPath(filePath, roots.hyperframes);
}
function isUnderPath(filePath, dir) {
    const target = path.resolve(filePath);
    const root = path.resolve(dir);
    const samePath = process.platform === "win32"
        ? target.toLowerCase() === root.toLowerCase()
        : target === root;
    if (samePath)
        return true;
    const relative = path.relative(root, target);
    if (relative === "")
        return true;
    // Different Windows drives produce an absolute relative path, never accept it.
    if (path.isAbsolute(relative))
        return false;
    if (relative === ".." || relative.startsWith(`..${path.sep}`))
        return false;
    return true;
}
/**
 * Create the Native Pi DefaultResourceLoader for this project.
 *
 * - cwd is the project root so `.pi/skills/` is understood as the project
 *   config root.
 * - agentDir is `<projectRoot>/data/pi` (never ~/.pi/agent).
 * - Native settings patterns `skills: ["!**"]` disable all auto-discovered
 *   skill sources (user home, other projects, packages).
 * - additionalSkillPaths explicitly loads only the two project-local skill
 *   directories.
 * - skillsOverride is the final Native filter: every skill whose filePath is
 *   outside the two project roots is dropped, even if a future SDK version
 *   changes discovery order.
 *
 * Pi's own loader does all SKILL.md scanning, parsing, metadata extraction
 * and system-prompt inventory building. No own skill parser is implemented.
 */
export async function createProjectResourceLoader(options) {
    const roots = getProjectSkillRoots(options.projectRoot);
    const settingsManager = SettingsManager.inMemory({ skills: ["!**"] });
    settingsManager.setProjectSkillPaths(["!**"]);
    const loader = new DefaultResourceLoader({
        cwd: options.projectRoot,
        agentDir: options.agentDir,
        settingsManager,
        additionalSkillPaths: [roots.clipSkills, roots.hyperframes],
        extensionFactories: [createTaskAccessPolicy(options)],
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter((extension) => extension.path === "<inline:task-access-policy>"),
            errors: base.errors.filter((error) => error.path === "<inline:task-access-policy>"),
        }),
        skillsOverride: (base) => ({
            skills: base.skills.filter((skill) => isProjectSkillPath(skill.filePath, roots)),
            diagnostics: base.diagnostics,
        }),
    });
    await loader.reload();
    return loader;
}
