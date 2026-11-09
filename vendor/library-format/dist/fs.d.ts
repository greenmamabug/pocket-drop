/**
 * The minimal filesystem the format checks need. Node binds it to `node:fs` (see ./node.ts);
 * the desktop app binds it to scoped Tauri commands so the same checking code runs inside the
 * webview, where there is no Node.
 */
export interface FileInfo {
    exists: boolean;
    size: number;
    isDir: boolean;
}
export interface LibraryFs {
    /** Joins path segments with the platform separator. Never resolves `..`. */
    join(...parts: string[]): string;
    readText(file: string): Promise<string>;
    stat(file: string): Promise<FileInfo>;
    sha256File(file: string): Promise<string>;
}
/** Pure-JS join for callers that only ever deal with forward slashes (device-relative paths). */
export declare function posixJoin(...parts: string[]): string;
