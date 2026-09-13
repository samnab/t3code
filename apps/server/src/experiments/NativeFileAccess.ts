import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

// Effect FileSystem follows final symlinks, cannot express O_NOFOLLOW, and its
// realPath does not provide Windows native 8.3-name canonicalization. Keep these
// capability-gap primitives here so repository identity checks remain intact.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

export interface NativeFileInfo {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
}

export class NativeFileAccessError extends Data.TaggedError("NativeFileAccessError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface NativeFileHandle {
  readonly stat: Effect.Effect<NativeFileInfo, NativeFileAccessError>;
  readonly readAll: Effect.Effect<Buffer, NativeFileAccessError>;
  readonly writeAll: (content: Buffer) => Effect.Effect<void, NativeFileAccessError>;
  readonly sync: Effect.Effect<void, NativeFileAccessError>;
}

function fileInfo(info: Awaited<ReturnType<NodeFSP.FileHandle["stat"]>>): NativeFileInfo {
  return {
    kind: info.isFile()
      ? "file"
      : info.isDirectory()
        ? "directory"
        : info.isSymbolicLink()
          ? "symlink"
          : "other",
    dev: Number(info.dev),
    ino: Number(info.ino),
    mode: Number(info.mode),
    size: Number(info.size),
  };
}

function nativePromise<A>(operation: string, evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new NativeFileAccessError({ operation, cause }),
  });
}

function scopedHandle(acquire: Effect.Effect<NodeFSP.FileHandle, NativeFileAccessError>) {
  return Effect.acquireRelease(acquire, (handle) =>
    nativePromise("close", () => handle.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.map((handle): NativeFileHandle => ({
      stat: nativePromise("fstat", () => handle.stat()).pipe(Effect.map(fileInfo)),
      readAll: nativePromise("read", () => handle.readFile()),
      writeAll: (content) =>
        nativePromise("write", async () => {
          let offset = 0;
          while (offset < content.byteLength) {
            const result = await handle.write(content, offset, content.byteLength - offset);
            if (result.bytesWritten <= 0) {
              throw new Error("Native file write made no progress.");
            }
            offset += result.bytesWritten;
          }
        }),
      sync: nativePromise("sync", () => handle.datasync()),
    })),
  );
}

export const lstatNoFollow = (path: string): Effect.Effect<NativeFileInfo, NativeFileAccessError> =>
  nativePromise("lstat", () => NodeFSP.lstat(path)).pipe(Effect.map(fileInfo));

export const nativeRealPath = (path: string): string => NodeFS.realpathSync.native(path);

export const openNoFollowRead = (path: string) => {
  const noFollow = "O_NOFOLLOW" in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0;
  return scopedHandle(
    nativePromise("open", () => NodeFSP.open(path, NodeFS.constants.O_RDONLY | noFollow)),
  );
};

export const openNoFollowAppendCreate = (path: string, mode: number) => {
  const noFollow = "O_NOFOLLOW" in NodeFS.constants ? NodeFS.constants.O_NOFOLLOW : 0;
  return scopedHandle(
    nativePromise("open append", () =>
      NodeFSP.open(
        path,
        NodeFS.constants.O_APPEND | NodeFS.constants.O_CREAT | NodeFS.constants.O_WRONLY | noFollow,
        mode,
      ),
    ),
  );
};
