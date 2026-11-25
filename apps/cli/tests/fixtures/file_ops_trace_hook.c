/* Linux-only disposable test fixture for the transaction trace test. The Rust
 * crate contains no unsafe FFI. It changes no syscall's result: it appends one
 * line per durable step to the file named by WSMP_TRACE_LOG, in call order,
 * while the test holds the marker file `<log>.on` (around one operation),
 * interleaved with the lines the test itself appends there. Logged: fsync and
 * fdatasync (with the synced object's path), each INTENT replacement (the
 * renameat of INTENT.new onto INTENT, with the phase it made durable), and every
 * other name change: renameat, renameat2 (with its flags), linkat, unlinkat and
 * mkdirat (with the directory's path and the names). No file bytes other than
 * the INTENT phase name are logged. Each wrapper returns the real call's result
 * and errno unchanged: logging runs between saving and restoring errno. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fd_path(int fd, char *path, size_t size) {
    char proc[64];
    snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, path, size - 1);
    if (n <= 0) return 0;
    path[n] = 0;
    return 1;
}

/* Only while the test holds `<log>.on`, around the one operation under test. */
static void log_line(const char *line) {
    const char *log = getenv("WSMP_TRACE_LOG");
    char on[4200];
    if (!log) return;
    snprintf(on, sizeof(on), "%s.on", log);
    if (access(on, F_OK)) return;
    int fd = open(log, O_WRONLY | O_APPEND | O_CLOEXEC);
    if (fd < 0) return;
    (void)!write(fd, line, strlen(line));
    close(fd);
}

static void log_synced(const char *call, int fd, int result) {
    char path[4096], line[4200];
    if (!fd_path(fd, path, sizeof(path))) strcpy(path, "?");
    snprintf(line, sizeof(line), "  d %s %s%s\n", call, path, result ? " (failed)" : "");
    log_line(line);
}

int fsync(int fd) {
    static int (*real)(int);
    if (!real) real = dlsym(RTLD_NEXT, "fsync");
    int result = real(fd);
    int saved = errno;
    log_synced("fsync", fd, result);
    errno = saved;
    return result;
}

int fdatasync(int fd) {
    static int (*real)(int);
    if (!real) real = dlsym(RTLD_NEXT, "fdatasync");
    int result = real(fd);
    int saved = errno;
    log_synced("fdatasync", fd, result);
    errno = saved;
    return result;
}

/* The phase named in the INTENT file under the directory `dirfd`. */
static void intent_phase(int dirfd, char *phase, size_t size) {
    char path[4096], body[65536];
    strcpy(phase, "?");
    if (!fd_path(dirfd, path, sizeof(path) - 8)) return;
    strcat(path, "/INTENT");
    int input = open(path, O_RDONLY | O_CLOEXEC);
    if (input < 0) return;
    ssize_t n = read(input, body, sizeof(body) - 1);
    close(input);
    if (n <= 0) return;
    body[n] = 0;
    const char *at = strstr(body, "\"phase\":\"");
    if (!at) return;
    at += strlen("\"phase\":\"");
    size_t length = strcspn(at, "\"");
    if (length >= size) length = size - 1;
    memcpy(phase, at, length);
    phase[length] = 0;
}

/* One name change: `call dir/name [-> dir/name] [flags]`, and whether it failed. */
static void log_named(const char *call, int fd, const char *name, int tofd, const char *to,
                      unsigned flags, int result) {
    char from[4096], dest[4096], line[8400];
    if (!fd_path(fd, from, sizeof(from))) strcpy(from, "?");
    if (to) {
        if (!fd_path(tofd, dest, sizeof(dest))) strcpy(dest, "?");
        snprintf(line, sizeof(line), "  d %s %s/%s -> %s/%s flags=%u%s\n", call, from, name, dest,
                 to, flags, result ? " (failed)" : "");
    } else {
        snprintf(line, sizeof(line), "  d %s %s/%s flags=%u%s\n", call, from, name, flags,
                 result ? " (failed)" : "");
    }
    log_line(line);
}

int renameat2(int oldfd, const char *old, int newfd, const char *new, unsigned flags) {
    static int (*real)(int, const char *, int, const char *, unsigned);
    if (!real) real = dlsym(RTLD_NEXT, "renameat2");
    int result = real(oldfd, old, newfd, new, flags);
    int saved = errno;
    log_named("renameat2", oldfd, old, newfd, new, flags, result);
    errno = saved;
    return result;
}

int linkat(int oldfd, const char *old, int newfd, const char *new, int flags) {
    static int (*real)(int, const char *, int, const char *, int);
    if (!real) real = dlsym(RTLD_NEXT, "linkat");
    int result = real(oldfd, old, newfd, new, flags);
    int saved = errno;
    log_named("linkat", oldfd, old, newfd, new, (unsigned)flags, result);
    errno = saved;
    return result;
}

int unlinkat(int fd, const char *name, int flags) {
    static int (*real)(int, const char *, int);
    if (!real) real = dlsym(RTLD_NEXT, "unlinkat");
    int result = real(fd, name, flags);
    int saved = errno;
    log_named("unlinkat", fd, name, -1, NULL, (unsigned)flags, result);
    errno = saved;
    return result;
}

int mkdirat(int fd, const char *name, mode_t mode) {
    static int (*real)(int, const char *, mode_t);
    if (!real) real = dlsym(RTLD_NEXT, "mkdirat");
    int result = real(fd, name, mode);
    int saved = errno;
    log_named("mkdirat", fd, name, -1, NULL, (unsigned)mode, result);
    errno = saved;
    return result;
}

int renameat(int oldfd, const char *old, int newfd, const char *new) {
    static int (*real)(int, const char *, int, const char *);
    if (!real) real = dlsym(RTLD_NEXT, "renameat");
    int result = real(oldfd, old, newfd, new);
    int saved = errno;
    if (strcmp(old, "INTENT.new") || strcmp(new, "INTENT")) {
        log_named("renameat", oldfd, old, newfd, new, 0, result);
    } else {
        char phase[64], line[128];
        if (result) {
            strcpy(phase, "(failed)");
        } else {
            intent_phase(newfd, phase, sizeof(phase));
        }
        snprintf(line, sizeof(line), "  d intent %s\n", phase);
        log_line(line);
    }
    errno = saved;
    return result;
}
