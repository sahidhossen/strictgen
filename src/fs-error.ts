/** A file system error thrown by Node, with its `code` (like `ENOENT`) and usually a `path`. */
export function isFsError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    typeof (error as NodeJS.ErrnoException).syscall === "string"
  );
}

const REASONS: Readonly<Record<string, string>> = {
  ENOENT: "a folder on the way is missing, or is a symlink that points nowhere",
  EISDIR: "is a folder, where a file should be",
  ENOTDIR: "a file is in the way, where a folder should be",
  EEXIST: "already exists",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EROFS: "the file system is read only",
  ENOSPC: "no space left on the device",
  ELOOP: "too many levels of symlinks",
};

/** A short, one line reason for a file system error, ending with its code. */
export function fsReason(error: NodeJS.ErrnoException & { code: string }): string {
  return `${REASONS[error.code] ?? error.message.split("\n")[0] ?? error.code} (${error.code})`;
}
